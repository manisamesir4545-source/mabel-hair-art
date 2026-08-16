begin;

create table if not exists public.message_logs (
  id bigserial primary key,
  appointment_id bigint null,
  event text not null,
  phone text,
  template_name text,
  status text not null,
  provider_response jsonb,
  error_message text,
  dedupe_key text,
  created_at timestamptz not null default now()
);

create table if not exists public.broadcast_campaigns (
  campaign_id text primary key,
  template_name text not null,
  template_parameters jsonb not null default '[]'::jsonb,
  state text not null default 'idle'
    check (state in ('idle', 'running', 'completed', 'partial', 'failed')),
  run_token uuid,
  locked_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  pending_count integer not null default 0 check (pending_count >= 0),
  processing_count integer not null default 0 check (processing_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (campaign_id ~ '^[a-z0-9_:-]{1,128}$'),
  check (template_name ~ '^[a-z0-9_]{1,512}$'),
  check (jsonb_typeof(template_parameters) = 'array')
);

create table if not exists public.broadcast_recipients (
  campaign_id text not null,
  phone text not null,
  customer_name text not null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, phone),
  check (campaign_id ~ '^[a-z0-9_:-]{1,128}$'),
  check (phone ~ '^[1-9][0-9]{7,14}$'),
  check (char_length(customer_name) between 1 and 80)
);

alter table public.message_logs
  add column if not exists campaign_id text;

alter table public.broadcast_campaigns
  add column if not exists processing_count integer not null default 0
  check (processing_count >= 0);

alter table public.message_logs
  drop constraint if exists message_logs_status_check;

alter table public.message_logs
  add constraint message_logs_status_check
  check (status in ('pending', 'sent', 'failed', 'skipped'));

create unique index if not exists message_logs_dedupe_key_idx
  on public.message_logs (dedupe_key)
  where dedupe_key is not null;

create index if not exists message_logs_campaign_status_idx
  on public.message_logs (campaign_id, status)
  where campaign_id is not null;

create table if not exists public.admin_session_rate_limits (
  attempt_key text primary key,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  check (char_length(attempt_key) between 1 and 128)
);

alter table public.message_logs enable row level security;
alter table public.broadcast_campaigns enable row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.admin_session_rate_limits enable row level security;

drop policy if exists "Allow public read message_logs" on public.message_logs;
revoke all on table public.message_logs from public, anon, authenticated;
revoke all on table public.broadcast_campaigns from public, anon, authenticated;
revoke all on table public.broadcast_recipients from public, anon, authenticated;
revoke all on table public.admin_session_rate_limits from public, anon, authenticated;
revoke all on sequence public.message_logs_id_seq from public, anon, authenticated;

grant all on table public.message_logs to service_role;
grant all on table public.broadcast_campaigns to service_role;
grant select on table public.broadcast_recipients to service_role;
grant all on table public.admin_session_rate_limits to service_role;
grant usage, select on sequence public.message_logs_id_seq to service_role;

-- Freeze this one-off campaign's recipients at migration time. A table lock plus the
-- non-empty check keeps later migration re-runs from appending client-poisoned rows.
lock table public.broadcast_recipients in share row exclusive mode;

insert into public.broadcast_recipients (campaign_id, phone, customer_name)
with account_entries as (
  select account
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
    account,
    regexp_replace(coalesce(account ->> 'phone', ''), '[^0-9]', '', 'g') as raw_phone,
    left(
      regexp_replace(
        coalesce(
          nullif(btrim(account ->> 'name'), ''),
          nullif(btrim(account ->> 'username'), ''),
          'Müşterimiz'
        ),
        '[[:cntrl:]]+',
        ' ',
        'g'
      ),
      80
    ) as customer_name,
    lower(coalesce(account ->> 'whatsappOptOut', 'false')) = 'true'
      or lower(coalesce(account ->> 'marketingOptOut', 'false')) = 'true'
      or lower(coalesce(account ->> 'announcementOptOut', 'false')) = 'true'
      or lower(coalesce(account ->> 'whatsappConsent', 'true')) = 'false'
      or lower(coalesce(account ->> 'marketingConsent', 'true')) = 'false'
      or lower(coalesce(account ->> 'receiveWhatsappAnnouncements', 'true')) = 'false'
      as opted_out
  from account_entries
),
account_without_00 as (
  select
    account,
    customer_name,
    opted_out,
    case when raw_phone like '00%' then substr(raw_phone, 3) else raw_phone end as phone
  from account_raw
),
account_without_local_zero as (
  select
    account,
    customer_name,
    opted_out,
    case when phone like '0%' then '9' || phone else phone end as phone
  from account_without_00
),
normalized_accounts as (
  select
    customer_name,
    opted_out,
    case when phone like '5%' then '90' || phone else phone end as phone
  from account_without_local_zero
),
opted_out_phones as (
  select distinct phone
  from normalized_accounts
  where opted_out
    and phone ~ '^[1-9][0-9]{7,14}$'
),
appointment_raw as (
  select
    regexp_replace(coalesce(appointments.phone, ''), '[^0-9]', '', 'g') as raw_phone,
    left(
      regexp_replace(
        coalesce(nullif(btrim(appointments.customer_name), ''), 'Müşterimiz'),
        '[[:cntrl:]]+',
        ' ',
        'g'
      ),
      80
    ) as customer_name,
    appointments.id
  from public.appointments
),
appointment_without_00 as (
  select
    customer_name,
    id,
    case when raw_phone like '00%' then substr(raw_phone, 3) else raw_phone end as phone
  from appointment_raw
),
appointment_without_local_zero as (
  select
    customer_name,
    id,
    case when phone like '0%' then '9' || phone else phone end as phone
  from appointment_without_00
),
normalized_appointments as (
  select
    customer_name,
    id,
    case when phone like '5%' then '90' || phone else phone end as phone
  from appointment_without_local_zero
),
candidates as (
  select phone, customer_name, 1 as source_priority, null::text as appointment_id
  from normalized_accounts
  where not opted_out
    and phone ~ '^[1-9][0-9]{7,14}$'
    and not exists (
      select 1 from opted_out_phones excluded where excluded.phone = normalized_accounts.phone
    )

  union all

  select appointments.phone, appointments.customer_name, 2, appointments.id::text
  from normalized_appointments appointments
  where appointments.phone ~ '^[1-9][0-9]{7,14}$'
    and not exists (
      select 1 from opted_out_phones excluded where excluded.phone = appointments.phone
    )
),
deduplicated as (
  select distinct on (phone)
    phone,
    customer_name
  from candidates
  order by phone, source_priority, appointment_id desc nulls last, customer_name
)
select
  'mabel_reopening_2026_08_18_v2',
  phone,
  coalesce(nullif(btrim(customer_name), ''), 'Müşterimiz')
from deduplicated
where not exists (
  select 1
  from public.broadcast_recipients existing
  where existing.campaign_id = 'mabel_reopening_2026_08_18_v2'
)
on conflict (campaign_id, phone) do nothing;

do $$
begin
  if not exists (
    select 1
    from public.broadcast_recipients
    where campaign_id = 'mabel_reopening_2026_08_18_v2'
  ) then
    raise exception 'broadcast recipient snapshot is empty; migration aborted';
  end if;
end;
$$;

create or replace function public.consume_admin_session_attempt(
  p_attempt_key text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.admin_session_rate_limits%rowtype;
  v_now timestamptz := clock_timestamp();
  v_window integer := least(3600, greatest(60, coalesce(p_window_seconds, 900)));
  v_max integer := least(500, greatest(2, coalesce(p_max_attempts, 5)));
  v_allowed boolean;
  v_retry integer := 0;
begin
  if p_attempt_key is null or char_length(p_attempt_key) not between 1 and 128 then
    raise exception 'invalid attempt key';
  end if;

  insert into public.admin_session_rate_limits (attempt_key, attempt_count, window_started_at, updated_at)
  values (p_attempt_key, 0, v_now, v_now)
  on conflict (attempt_key) do nothing;

  select * into v_row
  from public.admin_session_rate_limits
  where attempt_key = p_attempt_key
  for update;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    v_allowed := false;
    v_retry := greatest(1, ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer);
  elsif v_row.window_started_at + make_interval(secs => v_window) <= v_now then
    update public.admin_session_rate_limits
    set window_started_at = v_now,
        attempt_count = 1,
        blocked_until = null,
        updated_at = v_now
    where attempt_key = p_attempt_key;
    v_allowed := true;
  elsif v_row.attempt_count + 1 > v_max then
    update public.admin_session_rate_limits
    set attempt_count = v_row.attempt_count + 1,
        blocked_until = v_now + make_interval(secs => v_window),
        updated_at = v_now
    where attempt_key = p_attempt_key;
    v_allowed := false;
    v_retry := v_window;
  else
    update public.admin_session_rate_limits
    set attempt_count = v_row.attempt_count + 1,
        blocked_until = null,
        updated_at = v_now
    where attempt_key = p_attempt_key;
    v_allowed := true;
  end if;

  return query select v_allowed, v_retry;
end;
$$;

create or replace function public.clear_admin_session_attempt(p_attempt_key text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.admin_session_rate_limits
  where attempt_key = p_attempt_key;
$$;

create or replace function public.claim_broadcast_campaign(
  p_campaign_id text,
  p_template_name text,
  p_template_parameters jsonb,
  p_recipient_count integer,
  p_lease_seconds integer default 900
)
returns table (
  acquired boolean,
  run_token uuid,
  campaign_state text,
  lock_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease integer := least(3600, greatest(60, coalesce(p_lease_seconds, 900)));
  v_requested_token uuid := gen_random_uuid();
  v_row public.broadcast_campaigns%rowtype;
begin
  if p_campaign_id is null or p_campaign_id !~ '^[a-z0-9_:-]{1,128}$' then
    raise exception 'invalid campaign id';
  end if;
  if p_template_name is null or p_template_name !~ '^[a-z0-9_]{1,512}$' then
    raise exception 'invalid template name';
  end if;
  if p_template_parameters is null or jsonb_typeof(p_template_parameters) <> 'array' then
    raise exception 'invalid template parameters';
  end if;

  insert into public.broadcast_campaigns (
    campaign_id,
    template_name,
    template_parameters,
    state,
    run_token,
    locked_until,
    attempt_count,
    recipient_count,
    started_at,
    finished_at,
    last_error,
    created_at,
    updated_at
  ) values (
    p_campaign_id,
    p_template_name,
    p_template_parameters,
    'running',
    v_requested_token,
    v_now + make_interval(secs => v_lease),
    1,
    greatest(0, coalesce(p_recipient_count, 0)),
    v_now,
    null,
    null,
    v_now,
    v_now
  )
  on conflict (campaign_id) do update
  set template_name = excluded.template_name,
      template_parameters = excluded.template_parameters,
      state = 'running',
      run_token = excluded.run_token,
      locked_until = excluded.locked_until,
      attempt_count = public.broadcast_campaigns.attempt_count + 1,
      recipient_count = excluded.recipient_count,
      started_at = v_now,
      finished_at = null,
      last_error = null,
      updated_at = v_now
  where public.broadcast_campaigns.state <> 'running'
     or public.broadcast_campaigns.locked_until is null
     or public.broadcast_campaigns.locked_until <= v_now
  returning * into v_row;

  if not found then
    select * into v_row
    from public.broadcast_campaigns
    where campaign_id = p_campaign_id;
  end if;

  return query
  select v_row.run_token = v_requested_token,
         v_row.run_token,
         v_row.state,
         v_row.locked_until;
end;
$$;

create or replace function public.renew_broadcast_campaign(
  p_campaign_id text,
  p_run_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_renewed boolean := false;
  v_lease integer := least(3600, greatest(60, coalesce(p_lease_seconds, 900)));
begin
  update public.broadcast_campaigns
  set locked_until = clock_timestamp() + make_interval(secs => v_lease),
      updated_at = clock_timestamp()
  where campaign_id = p_campaign_id
    and run_token = p_run_token
    and state = 'running'
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

create or replace function public.reserve_broadcast_message(
  p_campaign_id text,
  p_run_token uuid,
  p_phone text,
  p_template_name text
)
returns table (claimed boolean, log_id bigint, log_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log public.message_logs%rowtype;
  v_dedupe_key text;
begin
  if p_phone is null or p_phone !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid recipient phone';
  end if;

  perform 1
  from public.broadcast_campaigns campaign
  join public.broadcast_recipients recipient
    on recipient.campaign_id = campaign.campaign_id
   and recipient.phone = p_phone
  where campaign.campaign_id = p_campaign_id
    and campaign.template_name = p_template_name
    and campaign.run_token = p_run_token
    and campaign.state = 'running'
    and campaign.locked_until > clock_timestamp();
  if not found then
    raise exception 'broadcast lease not held';
  end if;

  v_dedupe_key := 'announcement:' || p_campaign_id || ':' || p_phone;

  insert into public.message_logs (
    event,
    phone,
    template_name,
    status,
    dedupe_key,
    campaign_id
  ) values (
    'customer_announcement',
    p_phone,
    p_template_name,
    'pending',
    v_dedupe_key,
    p_campaign_id
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into v_log;

  if found then
    return query select true, v_log.id, v_log.status;
    return;
  end if;

  select * into v_log
  from public.message_logs
  where dedupe_key = v_dedupe_key;

  return query select false, v_log.id, v_log.status;
end;
$$;

create or replace function public.finalize_broadcast_message(
  p_log_id bigint,
  p_status text,
  p_provider_response jsonb default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean := false;
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'invalid final message status';
  end if;

  update public.message_logs
  set status = p_status,
      provider_response = case when p_status = 'sent' then p_provider_response else null end,
      error_message = case when p_status = 'failed' then left(coalesce(p_error_message, 'Unknown error'), 2000) else null end
  where id = p_log_id
    and campaign_id is not null
    and status = 'pending'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

create or replace function public.complete_broadcast_campaign(
  p_campaign_id text,
  p_run_token uuid,
  p_sent_count integer,
  p_failed_count integer,
  p_pending_count integer,
  p_processing_count integer,
  p_skipped_count integer,
  p_last_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completed boolean := false;
  v_state text;
begin
  v_state := case
    when nullif(trim(coalesce(p_last_error, '')), '') is not null then 'failed'
    when greatest(0, coalesce(p_pending_count, 0)) > 0 then 'partial'
    when greatest(0, coalesce(p_processing_count, 0)) > 0 then 'partial'
    when greatest(0, coalesce(p_failed_count, 0)) > 0 and greatest(0, coalesce(p_sent_count, 0)) = 0 then 'failed'
    when greatest(0, coalesce(p_failed_count, 0)) > 0 then 'partial'
    else 'completed'
  end;

  update public.broadcast_campaigns
  set state = v_state,
      sent_count = greatest(0, coalesce(p_sent_count, 0)),
      failed_count = greatest(0, coalesce(p_failed_count, 0)),
      pending_count = greatest(0, coalesce(p_pending_count, 0)),
      processing_count = greatest(0, coalesce(p_processing_count, 0)),
      skipped_count = greatest(0, coalesce(p_skipped_count, 0)),
      last_error = left(nullif(trim(coalesce(p_last_error, '')), ''), 2000),
      locked_until = null,
      finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where campaign_id = p_campaign_id
    and run_token = p_run_token
    and state = 'running'
  returning true into v_completed;

  return coalesce(v_completed, false);
end;
$$;

revoke all on function public.consume_admin_session_attempt(text, integer, integer) from public, anon, authenticated;
revoke all on function public.clear_admin_session_attempt(text) from public, anon, authenticated;
revoke all on function public.claim_broadcast_campaign(text, text, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.renew_broadcast_campaign(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_broadcast_message(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finalize_broadcast_message(bigint, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.complete_broadcast_campaign(text, uuid, integer, integer, integer, integer, integer, text) from public, anon, authenticated;

grant execute on function public.consume_admin_session_attempt(text, integer, integer) to service_role;
grant execute on function public.clear_admin_session_attempt(text) to service_role;
grant execute on function public.claim_broadcast_campaign(text, text, jsonb, integer, integer) to service_role;
grant execute on function public.renew_broadcast_campaign(text, uuid, integer) to service_role;
grant execute on function public.reserve_broadcast_message(text, uuid, text, text) to service_role;
grant execute on function public.finalize_broadcast_message(bigint, text, jsonb, text) to service_role;
grant execute on function public.complete_broadcast_campaign(text, uuid, integer, integer, integer, integer, integer, text) to service_role;

commit;
