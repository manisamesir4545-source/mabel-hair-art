begin;

-- This campaign intentionally uses the current customer candidate union. The
-- function is service-role only because app_state and appointments are not an
-- authorization boundary. Missing consent fields remain candidates for
-- backwards compatibility; callers must independently ensure a valid WhatsApp
-- opt-in before sending.
create or replace function public.assert_service_location_candidate_source_limits()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account_count integer := 0;
  v_appointment_count integer := 0;
begin
  -- Prevent the client-writable source from changing while a canonical set is
  -- built, and reject raw floods before expanding/sorting their contents.
  lock table public.app_state in share mode;
  lock table public.appointments in share mode;

  select coalesce(max(
    case
      when jsonb_typeof(state.data::jsonb -> 'customerAccounts') = 'array'
        then jsonb_array_length(state.data::jsonb -> 'customerAccounts')
      else 0
    end
  ), 0)::integer
  into v_account_count
  from public.app_state state
  where state.id = 1;

  select count(*)::integer
  into v_appointment_count
  from (
    select 1
    from public.appointments appointment
    limit 10001
  ) bounded_appointments;

  if v_account_count > 5000 then
    raise exception 'service location account source cap exceeded';
  end if;
  if v_appointment_count > 10000 then
    raise exception 'service location appointment source cap exceeded';
  end if;

  return true;
end;
$$;

create or replace function public.get_current_service_location_broadcast_candidates()
returns table (
  phone text,
  customer_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.assert_service_location_candidate_source_limits();

  return query
  with account_entries as (
    select account_entry.account
    from public.app_state state
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(state.data::jsonb -> 'customerAccounts') = 'array'
          then state.data::jsonb -> 'customerAccounts'
        else '[]'::jsonb
      end
    ) as account_entry(account)
    where state.id = 1
  ),
  account_raw as (
    select
      regexp_replace(
        coalesce(account_entries.account ->> 'phone', ''),
        '[^0-9]',
        '',
        'g'
      ) as raw_phone,
      left(
        regexp_replace(
          coalesce(
            nullif(btrim(account_entries.account ->> 'name'), ''),
            nullif(btrim(account_entries.account ->> 'username'), ''),
            'Müşterimiz'
          ),
          '[[:cntrl:]]+',
          ' ',
          'g'
        ),
        80
      ) as customer_name,
      lower(coalesce(account_entries.account ->> 'whatsappOptOut', 'false')) = 'true'
        or lower(coalesce(account_entries.account ->> 'marketingOptOut', 'false')) = 'true'
        or lower(coalesce(account_entries.account ->> 'announcementOptOut', 'false')) = 'true'
        or lower(coalesce(account_entries.account ->> 'whatsappConsent', 'true')) = 'false'
        or lower(coalesce(account_entries.account ->> 'marketingConsent', 'true')) = 'false'
        or lower(coalesce(account_entries.account ->> 'receiveWhatsappAnnouncements', 'true')) = 'false'
        as opted_out
    from account_entries
  ),
  account_without_00 as (
    select
      account_raw.customer_name,
      account_raw.opted_out,
      case
        when account_raw.raw_phone like '00%'
          then substr(account_raw.raw_phone, 3)
        else account_raw.raw_phone
      end as phone
    from account_raw
  ),
  account_without_local_zero as (
    select
      account_without_00.customer_name,
      account_without_00.opted_out,
      case
        when account_without_00.phone like '0%'
          then '9' || account_without_00.phone
        else account_without_00.phone
      end as phone
    from account_without_00
  ),
  normalized_accounts as (
    select
      account_without_local_zero.customer_name,
      account_without_local_zero.opted_out,
      case
        when account_without_local_zero.phone like '5%'
          then '90' || account_without_local_zero.phone
        else account_without_local_zero.phone
      end as phone
    from account_without_local_zero
  ),
  opted_out_phones as (
    select distinct normalized_accounts.phone
    from normalized_accounts
    where normalized_accounts.opted_out
      and normalized_accounts.phone ~ '^[1-9][0-9]{7,14}$'
  ),
  appointment_raw as (
    select
      regexp_replace(
        coalesce(appointment.phone, ''),
        '[^0-9]',
        '',
        'g'
      ) as raw_phone,
      left(
        regexp_replace(
          coalesce(nullif(btrim(appointment.customer_name), ''), 'Müşterimiz'),
          '[[:cntrl:]]+',
          ' ',
          'g'
        ),
        80
      ) as customer_name,
      appointment.id
    from public.appointments appointment
  ),
  appointment_without_00 as (
    select
      appointment_raw.customer_name,
      appointment_raw.id,
      case
        when appointment_raw.raw_phone like '00%'
          then substr(appointment_raw.raw_phone, 3)
        else appointment_raw.raw_phone
      end as phone
    from appointment_raw
  ),
  appointment_without_local_zero as (
    select
      appointment_without_00.customer_name,
      appointment_without_00.id,
      case
        when appointment_without_00.phone like '0%'
          then '9' || appointment_without_00.phone
        else appointment_without_00.phone
      end as phone
    from appointment_without_00
  ),
  normalized_appointments as (
    select
      appointment_without_local_zero.customer_name,
      appointment_without_local_zero.id,
      case
        when appointment_without_local_zero.phone like '5%'
          then '90' || appointment_without_local_zero.phone
        else appointment_without_local_zero.phone
      end as phone
    from appointment_without_local_zero
  ),
  candidates as (
    select
      normalized_accounts.phone,
      normalized_accounts.customer_name,
      1 as source_priority,
      null::text as appointment_id
    from normalized_accounts
    where not normalized_accounts.opted_out
      and normalized_accounts.phone ~ '^[1-9][0-9]{7,14}$'
      and not exists (
        select 1
        from opted_out_phones excluded
        where excluded.phone = normalized_accounts.phone
      )

    union all

    select
      normalized_appointments.phone,
      normalized_appointments.customer_name,
      2 as source_priority,
      normalized_appointments.id::text as appointment_id
    from normalized_appointments
    where normalized_appointments.phone ~ '^[1-9][0-9]{7,14}$'
      and not exists (
        select 1
        from opted_out_phones excluded
        where excluded.phone = normalized_appointments.phone
      )
  ),
  deduplicated as (
    select distinct on (candidates.phone)
      candidates.phone,
      candidates.customer_name
    from candidates
    order by
      candidates.phone,
      candidates.source_priority,
      candidates.appointment_id desc nulls last,
      candidates.customer_name
  )
  select
    deduplicated.phone,
    coalesce(nullif(btrim(deduplicated.customer_name), ''), 'Müşterimiz')
  from deduplicated
  where not exists (
    select 1
    from public.broadcast_suppressions suppressed
    where suppressed.phone = deduplicated.phone
  )
  order by deduplicated.phone;
end;
$$;

create or replace function public.refresh_service_location_broadcast_recipients(
  p_campaign_id text,
  p_series_id text,
  p_template_name text,
  p_template_parameters jsonb,
  p_expected_recipient_count integer default null
)
returns table (
  round_id text,
  recipient_count integer,
  recipient_hash text,
  refreshed boolean,
  expected_recipient_count_matches boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_address constant text := 'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir';
  v_series_id constant text := 'mabel_is_yeri_adres_guncellemesi_v1';
  v_template_name constant text := 'is_yeri_adres_guncellemesi';
  v_max_recipients constant integer := 1000;
  v_now timestamptz := clock_timestamp();
  v_series public.broadcast_series%rowtype;
  v_campaign public.broadcast_campaigns%rowtype;
  v_candidates jsonb;
  v_existing jsonb;
  v_candidate_count integer;
  v_candidate_hash text;
  v_growth_limit integer;
  v_changed boolean;
begin
  if p_campaign_id is null
     or p_series_id is distinct from v_series_id
     or p_template_name is distinct from v_template_name
     or p_template_parameters is distinct from jsonb_build_array(v_address) then
    raise exception 'service location broadcast fingerprint mismatch';
  end if;
  if p_expected_recipient_count is not null
     and (p_expected_recipient_count < 1 or p_expected_recipient_count > v_max_recipients) then
    raise exception 'invalid expected recipient count';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('broadcast-round:' || v_series_id, 0)
  );

  select series.*
  into v_series
  from public.broadcast_series series
  where series.series_id = v_series_id
  for update;

  if not found
     or v_series.template_name <> v_template_name
     or v_series.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast series is not configured';
  end if;

  select campaign.*
  into v_campaign
  from public.broadcast_campaigns campaign
  where campaign.series_id = v_series_id
  order by campaign.round_number desc
  limit 1
  for update;

  if not found
     or v_campaign.campaign_id <> p_campaign_id
     or v_campaign.template_name <> v_template_name
     or v_campaign.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast campaign is not current';
  end if;

  if v_campaign.state <> 'idle'
     or v_campaign.attempt_count <> 0
     or v_campaign.run_token is not null
     or v_campaign.locked_until is not null
     or v_campaign.started_at is not null
     or v_campaign.finished_at is not null
     or v_campaign.sent_count <> 0
     or v_campaign.failed_count <> 0
     or v_campaign.processing_count <> 0
     or v_campaign.skipped_count <> 0
     or exists (
       select 1
       from public.message_logs log
       where log.campaign_id = v_campaign.campaign_id
     ) then
    raise exception 'service location broadcast round is not safely refreshable';
  end if;

  -- Aggregate once so all subsequent writes use one canonical candidate set.
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'phone', candidate.phone,
          'customer_name', candidate.customer_name
        )
        order by candidate.phone
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    encode(
      extensions.digest(
        coalesce(string_agg(candidate.phone, ',' order by candidate.phone), ''),
        'sha256'
      ),
      'hex'
    )
  into v_candidates, v_candidate_count, v_candidate_hash
  from (
    select current_candidate.phone, current_candidate.customer_name
    from public.get_current_service_location_broadcast_candidates()
      current_candidate
    order by current_candidate.phone
    limit v_max_recipients + 1
  ) candidate;

  if v_candidate_count < 1 then
    raise exception 'service location broadcast has no current candidates';
  end if;
  if v_candidate_count > v_max_recipients then
    raise exception 'service location broadcast candidate cap exceeded';
  end if;

  -- Operational per-refresh blast-radius guard for the client-writable source.
  -- This is not consent or authorization proof and must not be treated as one.
  -- The observed 157 -> 163 reconciliation remains within this bound.
  if v_campaign.recipient_count > 0 then
    v_growth_limit := greatest(
      25,
      ceil(v_campaign.recipient_count::numeric * 0.25)::integer
    );
    if v_candidate_count > v_campaign.recipient_count + v_growth_limit then
      raise exception 'service location broadcast candidate growth exceeded';
    end if;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'phone', recipient.phone,
        'customer_name', recipient.customer_name
      )
      order by recipient.phone
    ),
    '[]'::jsonb
  )
  into v_existing
  from public.broadcast_recipients recipient
  where recipient.campaign_id = v_campaign.campaign_id;

  v_changed := v_existing is distinct from v_candidates
    or v_campaign.recipient_count <> v_candidate_count
    or v_campaign.pending_count <> v_candidate_count;

  if v_changed then
    delete from public.broadcast_recipients recipient
    where recipient.campaign_id = v_campaign.campaign_id;

    insert into public.broadcast_recipients (
      campaign_id,
      phone,
      customer_name
    )
    select
      v_campaign.campaign_id,
      candidate.value ->> 'phone',
      candidate.value ->> 'customer_name'
    from jsonb_array_elements(v_candidates) candidate(value);

    update public.broadcast_campaigns campaign
    set recipient_count = v_candidate_count,
        pending_count = v_candidate_count,
        updated_at = v_now
    where campaign.campaign_id = v_campaign.campaign_id;
  end if;

  return query
  select
    v_campaign.campaign_id,
    v_candidate_count,
    v_candidate_hash,
    v_changed,
    p_expected_recipient_count is null
      or p_expected_recipient_count = v_candidate_count;
end;
$$;

-- Refreshing and claiming are one transaction so a concurrent status refresh
-- cannot swap the snapshot between the final comparison and the lease claim.
-- When a pristine snapshot changes (even at the same count), the new snapshot
-- is stored but the claim is refused so the admin must review status again.
create or replace function public.claim_current_service_location_broadcast(
  p_campaign_id text,
  p_series_id text,
  p_template_name text,
  p_template_parameters jsonb,
  p_expected_recipient_count integer,
  p_expected_recipient_hash text,
  p_lease_seconds integer default 900
)
returns table (
  acquired boolean,
  run_token uuid,
  campaign_state text,
  lock_expires_at timestamptz,
  recipient_count integer,
  recipient_hash text,
  recipient_list_changed boolean,
  expected_recipient_count_matches boolean,
  expected_recipient_hash_matches boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_address constant text := 'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir';
  v_series_id constant text := 'mabel_is_yeri_adres_guncellemesi_v1';
  v_template_name constant text := 'is_yeri_adres_guncellemesi';
  v_max_recipients constant integer := 1000;
  v_series public.broadcast_series%rowtype;
  v_campaign public.broadcast_campaigns%rowtype;
  v_refreshed boolean := false;
  v_matches boolean := false;
  v_hash_matches boolean := false;
  v_recipient_count integer := 0;
  v_recipient_hash text;
  v_acquired boolean := false;
  v_run_token uuid;
  v_campaign_state text;
  v_lock_expires_at timestamptz;
begin
  if p_campaign_id is null
     or p_series_id is distinct from v_series_id
     or p_template_name is distinct from v_template_name
     or p_template_parameters is distinct from jsonb_build_array(v_address) then
    raise exception 'service location broadcast fingerprint mismatch';
  end if;
  if p_expected_recipient_count is null
     or p_expected_recipient_count < 1
     or p_expected_recipient_count > v_max_recipients then
    raise exception 'invalid expected recipient count';
  end if;
  if p_expected_recipient_hash is null
     or p_expected_recipient_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid expected recipient hash';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('broadcast-round:' || v_series_id, 0)
  );

  select series.*
  into v_series
  from public.broadcast_series series
  where series.series_id = v_series_id
  for update;

  if not found
     or v_series.template_name <> v_template_name
     or v_series.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast series is not configured';
  end if;

  select campaign.*
  into v_campaign
  from public.broadcast_campaigns campaign
  where campaign.series_id = v_series_id
  order by campaign.round_number desc
  limit 1
  for update;

  if not found
     or v_campaign.campaign_id <> p_campaign_id
     or v_campaign.template_name <> v_template_name
     or v_campaign.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast campaign is not current';
  end if;

  if v_campaign.state = 'idle'
     and v_campaign.attempt_count = 0
     and v_campaign.run_token is null
     and v_campaign.locked_until is null
     and v_campaign.started_at is null
     and v_campaign.finished_at is null
     and v_campaign.sent_count = 0
     and v_campaign.failed_count = 0
     and v_campaign.processing_count = 0
     and v_campaign.skipped_count = 0
     and not exists (
       select 1
       from public.message_logs log
       where log.campaign_id = v_campaign.campaign_id
     ) then
    select
      refresh.recipient_count,
      refresh.recipient_hash,
      refresh.refreshed,
      refresh.expected_recipient_count_matches
    into v_recipient_count, v_recipient_hash, v_refreshed, v_matches
    from public.refresh_service_location_broadcast_recipients(
      p_campaign_id,
      p_series_id,
      p_template_name,
      p_template_parameters,
      p_expected_recipient_count
    ) refresh;

    v_hash_matches := p_expected_recipient_hash = v_recipient_hash;
    if v_refreshed or not v_matches or not v_hash_matches then
      return query
      select
        false,
        null::uuid,
        'idle'::text,
        null::timestamptz,
        v_recipient_count,
        v_recipient_hash,
        v_refreshed,
        v_matches,
        v_hash_matches;
      return;
    end if;
  else
    select
      count(*)::integer,
      encode(
        extensions.digest(
          coalesce(string_agg(recipient.phone, ',' order by recipient.phone), ''),
          'sha256'
        ),
        'hex'
      )
    into v_recipient_count, v_recipient_hash
    from (
      select snapshot.phone
      from public.broadcast_recipients snapshot
      where snapshot.campaign_id = v_campaign.campaign_id
      order by snapshot.phone
      limit v_max_recipients + 1
    ) recipient;

    if v_recipient_count < 1 or v_recipient_count > v_max_recipients then
      raise exception 'service location broadcast snapshot count is unsafe';
    end if;
    v_matches := p_expected_recipient_count = v_recipient_count;
    v_hash_matches := p_expected_recipient_hash = v_recipient_hash;
    if not v_matches or not v_hash_matches then
      return query
      select
        false,
        null::uuid,
        v_campaign.state,
        v_campaign.locked_until,
        v_recipient_count,
        v_recipient_hash,
        false,
        v_matches,
        v_hash_matches;
      return;
    end if;
  end if;

  select
    claim.acquired,
    claim.run_token,
    claim.campaign_state,
    claim.lock_expires_at
  into v_acquired, v_run_token, v_campaign_state, v_lock_expires_at
  from public.claim_broadcast_campaign(
    p_campaign_id,
    p_template_name,
    p_template_parameters,
    v_recipient_count,
    p_lease_seconds
  ) claim;

  return query
  select
    coalesce(v_acquired, false),
    v_run_token,
    coalesce(v_campaign_state, v_campaign.state),
    v_lock_expires_at,
    v_recipient_count,
    v_recipient_hash,
    false,
    true,
    true;
end;
$$;

revoke all on function public.assert_service_location_candidate_source_limits()
  from public, anon, authenticated, authenticator;
revoke all on function public.get_current_service_location_broadcast_candidates()
  from public, anon, authenticated, authenticator;
revoke all on function public.refresh_service_location_broadcast_recipients(
  text,
  text,
  text,
  jsonb,
  integer
) from public, anon, authenticated, authenticator;
revoke all on function public.claim_current_service_location_broadcast(
  text,
  text,
  text,
  jsonb,
  integer,
  text,
  integer
) from public, anon, authenticated, authenticator;

grant execute on function public.assert_service_location_candidate_source_limits()
  to service_role;
grant execute on function public.get_current_service_location_broadcast_candidates()
  to service_role;
grant execute on function public.refresh_service_location_broadcast_recipients(
  text,
  text,
  text,
  jsonb,
  integer
) to service_role;
grant execute on function public.claim_current_service_location_broadcast(
  text,
  text,
  text,
  jsonb,
  integer,
  text,
  integer
) to service_role;

-- Reconcile the already-created first round only while it is provably unused.
-- The production preflight for this migration observed 157 frozen recipients
-- and 163 current candidates, but no count is hard-coded here.
do $$
begin
  if exists (
    select 1
    from public.broadcast_campaigns campaign
    where campaign.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and campaign.series_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and campaign.template_name = 'is_yeri_adres_guncellemesi'
      and campaign.template_parameters = jsonb_build_array(
        'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir'
      )
      and campaign.state = 'idle'
      and campaign.attempt_count = 0
      and campaign.run_token is null
      and campaign.locked_until is null
      and campaign.started_at is null
      and campaign.finished_at is null
      and campaign.sent_count = 0
      and campaign.failed_count = 0
      and campaign.processing_count = 0
      and campaign.skipped_count = 0
      and not exists (
        select 1
        from public.message_logs log
        where log.campaign_id = campaign.campaign_id
      )
  ) then
    perform *
    from public.refresh_service_location_broadcast_recipients(
      'mabel_is_yeri_adres_guncellemesi_v1',
      'mabel_is_yeri_adres_guncellemesi_v1',
      'is_yeri_adres_guncellemesi',
      jsonb_build_array('Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir'),
      null
    );
  end if;
end;
$$;

-- This endpoint now prepares rounds only for the exact address-update series.
-- New rounds use current candidates rather than copying the historic seed.
create or replace function public.prepare_broadcast_round(
  p_series_id text,
  p_request_id uuid,
  p_template_name text,
  p_template_parameters jsonb
)
returns table (
  campaign_id text,
  round_number integer,
  recipient_count integer,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_address constant text := 'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir';
  v_series_id constant text := 'mabel_is_yeri_adres_guncellemesi_v1';
  v_template_name constant text := 'is_yeri_adres_guncellemesi';
  v_max_recipients constant integer := 1000;
  v_now timestamptz := clock_timestamp();
  v_series public.broadcast_series%rowtype;
  v_latest public.broadcast_campaigns%rowtype;
  v_requested public.broadcast_campaigns%rowtype;
  v_campaign_id text;
  v_round_number integer;
  v_recipient_count integer := 0;
  v_recipient_hash text;
  v_candidates jsonb;
  v_growth_limit integer;
  v_requested_refreshed boolean := false;
  v_latest_refreshed boolean := false;
begin
  if p_series_id is distinct from v_series_id
     or p_request_id is null
     or p_template_name is distinct from v_template_name
     or p_template_parameters is distinct from jsonb_build_array(v_address) then
    raise exception 'service location broadcast fingerprint mismatch';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('broadcast-round:' || v_series_id, 0)
  );

  select series.*
  into v_series
  from public.broadcast_series series
  where series.series_id = v_series_id
  for update;

  if not found
     or v_series.template_name <> v_template_name
     or v_series.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast series is not configured';
  end if;

  select campaign.*
  into v_requested
  from public.broadcast_round_requests request
  join public.broadcast_campaigns campaign
    on campaign.campaign_id = request.campaign_id
  where request.series_id = v_series_id
    and request.request_id = p_request_id;

  select campaign.*
  into v_latest
  from public.broadcast_campaigns campaign
  where campaign.series_id = v_series_id
  order by campaign.round_number desc
  limit 1
  for update;

  if not found then
    raise exception 'service location broadcast has no initial round';
  end if;
  if v_latest.template_name <> v_template_name
     or v_latest.template_parameters <> jsonb_build_array(v_address) then
    raise exception 'service location broadcast campaign fingerprint mismatch';
  end if;

  if v_requested.campaign_id is not null then
    if v_requested.series_id <> v_series_id
       or v_requested.template_name <> v_template_name
       or v_requested.template_parameters <> jsonb_build_array(v_address) then
      raise exception 'service location broadcast request fingerprint mismatch';
    end if;

    if v_requested.campaign_id = v_latest.campaign_id
       and v_latest.state = 'idle'
       and v_latest.attempt_count = 0
       and v_latest.run_token is null
       and v_latest.locked_until is null
       and v_latest.started_at is null
       and v_latest.finished_at is null
       and v_latest.sent_count = 0
       and v_latest.failed_count = 0
       and v_latest.processing_count = 0
       and v_latest.skipped_count = 0
       and not exists (
         select 1
         from public.message_logs log
         where log.campaign_id = v_latest.campaign_id
      ) then
      select refresh.recipient_count
      into v_recipient_count
      from public.refresh_service_location_broadcast_recipients(
        v_latest.campaign_id,
        v_series_id,
        v_template_name,
        jsonb_build_array(v_address),
        null
      ) refresh;
      v_requested_refreshed := true;
    end if;

    return query
    select
      v_requested.campaign_id,
      v_requested.round_number,
      case
        when v_requested_refreshed then v_recipient_count
        else v_requested.recipient_count
      end,
      false;
    return;
  end if;

  -- Reuse an active or unfinished latest round. A pristine idle round is first
  -- reconciled to the current candidate union under the same advisory lock.
  if v_latest.state in ('idle', 'running') or v_latest.pending_count > 0 then
    if v_latest.state = 'idle'
       and v_latest.attempt_count = 0
       and v_latest.run_token is null
       and v_latest.locked_until is null
       and v_latest.started_at is null
       and v_latest.finished_at is null
       and v_latest.sent_count = 0
       and v_latest.failed_count = 0
       and v_latest.processing_count = 0
       and v_latest.skipped_count = 0
       and not exists (
         select 1
         from public.message_logs log
         where log.campaign_id = v_latest.campaign_id
      ) then
      select refresh.recipient_count
      into v_recipient_count
      from public.refresh_service_location_broadcast_recipients(
        v_latest.campaign_id,
        v_series_id,
        v_template_name,
        jsonb_build_array(v_address),
        null
      ) refresh;
      v_latest_refreshed := true;
    end if;

    insert into public.broadcast_round_requests (
      series_id,
      request_id,
      campaign_id,
      created_at
    ) values (
      v_series_id,
      p_request_id,
      v_latest.campaign_id,
      v_now
    )
    on conflict (series_id, request_id) do nothing;

    return query
    select
      v_latest.campaign_id,
      v_latest.round_number,
      case
        when v_latest_refreshed then v_recipient_count
        else v_latest.recipient_count
      end,
      false;
    return;
  end if;

  if v_latest.processing_count > 0 or exists (
    select 1
    from public.message_logs log
    where log.campaign_id = v_latest.campaign_id
      and log.status = 'pending'
  ) then
    raise exception 'service location broadcast has uncertain recipients';
  end if;

  v_round_number := v_latest.round_number + 1;
  v_campaign_id := v_series_id || ':r' || v_round_number::text;
  if char_length(v_campaign_id) > 128 then
    raise exception 'service location broadcast campaign id is too long';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'phone', candidate.phone,
          'customer_name', candidate.customer_name
        )
        order by candidate.phone
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    encode(
      extensions.digest(
        coalesce(string_agg(candidate.phone, ',' order by candidate.phone), ''),
        'sha256'
      ),
      'hex'
    )
  into v_candidates, v_recipient_count, v_recipient_hash
  from (
    select current_candidate.phone, current_candidate.customer_name
    from public.get_current_service_location_broadcast_candidates()
      current_candidate
    order by current_candidate.phone
    limit v_max_recipients + 1
  ) candidate;

  if v_recipient_count < 1 then
    raise exception 'service location broadcast has no current candidates';
  end if;
  if v_recipient_count > v_max_recipients then
    raise exception 'service location broadcast candidate cap exceeded';
  end if;

  if v_latest.recipient_count > 0 then
    v_growth_limit := greatest(
      25,
      ceil(v_latest.recipient_count::numeric * 0.25)::integer
    );
    if v_recipient_count > v_latest.recipient_count + v_growth_limit then
      raise exception 'service location broadcast candidate growth exceeded';
    end if;
  end if;

  if v_recipient_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'service location broadcast candidate hash is invalid';
  end if;

  insert into public.broadcast_recipients (
    campaign_id,
    phone,
    customer_name
  )
  select
    v_campaign_id,
    candidate.value ->> 'phone',
    candidate.value ->> 'customer_name'
  from jsonb_array_elements(v_candidates) candidate(value);

  insert into public.broadcast_campaigns (
    campaign_id,
    template_name,
    template_parameters,
    state,
    recipient_count,
    pending_count,
    series_id,
    round_number,
    created_at,
    updated_at
  ) values (
    v_campaign_id,
    v_template_name,
    jsonb_build_array(v_address),
    'idle',
    v_recipient_count,
    v_recipient_count,
    v_series_id,
    v_round_number,
    v_now,
    v_now
  );

  insert into public.broadcast_round_requests (
    series_id,
    request_id,
    campaign_id,
    created_at
  ) values (
    v_series_id,
    p_request_id,
    v_campaign_id,
    v_now
  );

  return query
  select v_campaign_id, v_round_number, v_recipient_count, true;
end;
$$;

revoke all on function public.prepare_broadcast_round(text, uuid, text, jsonb)
  from public, anon, authenticated, authenticator;
grant execute on function public.prepare_broadcast_round(text, uuid, text, jsonb)
  to service_role;

commit;
