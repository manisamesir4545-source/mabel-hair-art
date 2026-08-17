begin;

alter table public.broadcast_campaigns
  add column if not exists series_id text,
  add column if not exists round_number integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'broadcast_campaigns_series_id_check'
      and conrelid = 'public.broadcast_campaigns'::regclass
  ) then
    alter table public.broadcast_campaigns
      add constraint broadcast_campaigns_series_id_check
      check (series_id is null or series_id ~ '^[a-z0-9_:-]{1,96}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'broadcast_campaigns_round_number_check'
      and conrelid = 'public.broadcast_campaigns'::regclass
  ) then
    alter table public.broadcast_campaigns
      add constraint broadcast_campaigns_round_number_check
      check (round_number is null or round_number > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'broadcast_campaigns_round_pair_check'
      and conrelid = 'public.broadcast_campaigns'::regclass
  ) then
    alter table public.broadcast_campaigns
      add constraint broadcast_campaigns_round_pair_check
      check ((series_id is null) = (round_number is null));
  end if;
end;
$$;

-- Preserve the completed first delivery as immutable round 1. On a fresh
-- database, prepare the pre-existing recipient snapshot as an idle first round.
insert into public.broadcast_campaigns (
  campaign_id,
  template_name,
  template_parameters,
  state,
  recipient_count,
  pending_count,
  series_id,
  round_number
)
select
  'mabel_reopening_2026_08_18_v2',
  'mabel_calisma_bilgisi_v2',
  jsonb_build_array('customer_name', '19 Ağustos 2026'),
  'idle',
  count(*)::integer,
  count(*)::integer,
  'mabel_reopening_2026_08_18_v2',
  1
from public.broadcast_recipients
where campaign_id = 'mabel_reopening_2026_08_18_v2'
having count(*) > 0
on conflict (campaign_id) do nothing;

update public.broadcast_campaigns
set series_id = 'mabel_reopening_2026_08_18_v2',
    round_number = 1,
    updated_at = clock_timestamp()
where campaign_id = 'mabel_reopening_2026_08_18_v2'
  and (series_id is null or round_number is null);

-- Keep the reusable series configuration separate from round 1's immutable
-- audit metadata. The first live round used a mojibake date parameter; future
-- rounds must use the corrected UTF-8 value without rewriting that history.
create table if not exists public.broadcast_series (
  series_id text primary key,
  seed_campaign_id text not null references public.broadcast_campaigns(campaign_id),
  template_name text not null,
  template_parameters jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (series_id ~ '^[a-z0-9_:-]{1,96}$'),
  check (
    char_length(template_name) between 1 and 512
    and template_name ~ '^[a-z0-9_]+$'
  ),
  check (jsonb_typeof(template_parameters) = 'array')
);

insert into public.broadcast_series (
  series_id,
  seed_campaign_id,
  template_name,
  template_parameters
) values (
  'mabel_reopening_2026_08_18_v2',
  'mabel_reopening_2026_08_18_v2',
  'mabel_calisma_bilgisi_v2',
  jsonb_build_array('customer_name', '19 Ağustos 2026')
)
on conflict (series_id) do update
set seed_campaign_id = excluded.seed_campaign_id,
    template_name = excluded.template_name,
    template_parameters = excluded.template_parameters,
    updated_at = clock_timestamp();

create unique index if not exists broadcast_campaigns_series_round_idx
  on public.broadcast_campaigns (series_id, round_number)
  where series_id is not null and round_number is not null;

create index if not exists broadcast_campaigns_series_latest_idx
  on public.broadcast_campaigns (series_id, round_number desc)
  where series_id is not null;

create table if not exists public.broadcast_round_requests (
  series_id text not null,
  request_id uuid not null,
  campaign_id text not null references public.broadcast_campaigns(campaign_id),
  created_at timestamptz not null default now(),
  primary key (series_id, request_id),
  check (series_id ~ '^[a-z0-9_:-]{1,96}$')
);

create index if not exists broadcast_round_requests_campaign_idx
  on public.broadcast_round_requests (campaign_id);

-- Future opt-outs belong in this service-only table. Reusable rounds never
-- derive inclusion or suppression from the client-writable app_state blob.
create table if not exists public.broadcast_suppressions (
  phone text primary key,
  reason text not null default 'opt_out',
  created_at timestamptz not null default now(),
  check (phone ~ '^[1-9][0-9]{7,14}$'),
  check (char_length(reason) between 1 and 200)
);

alter table public.broadcast_round_requests enable row level security;
alter table public.broadcast_series enable row level security;
alter table public.broadcast_suppressions enable row level security;

revoke all on table public.broadcast_round_requests from public, anon, authenticated;
revoke all on table public.broadcast_series from public, anon, authenticated;
revoke all on table public.broadcast_suppressions from public, anon, authenticated;
grant select, insert on table public.broadcast_round_requests to service_role;
grant select on table public.broadcast_series to service_role;
grant select, insert, update, delete on table public.broadcast_suppressions
  to service_role;

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
  v_now timestamptz := clock_timestamp();
  v_series public.broadcast_series%rowtype;
  v_latest public.broadcast_campaigns%rowtype;
  v_campaign_id text;
  v_round_number integer;
  v_recipient_count integer := 0;
begin
  if p_series_id is null or p_series_id !~ '^[a-z0-9_:-]{1,96}$' then
    raise exception 'invalid broadcast series';
  end if;
  if p_request_id is null then
    raise exception 'broadcast request id is required';
  end if;
  if p_template_name is null
     or char_length(p_template_name) not between 1 and 512
     or p_template_name !~ '^[a-z0-9_]+$' then
    raise exception 'invalid template name';
  end if;
  if p_template_parameters is null or jsonb_typeof(p_template_parameters) <> 'array' then
    raise exception 'invalid template parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('broadcast-round:' || p_series_id, 0));

  select series.*
  into v_series
  from public.broadcast_series series
  where series.series_id = p_series_id
  for update;

  if not found then
    raise exception 'broadcast series is not configured';
  end if;
  if v_series.template_name <> p_template_name
     or v_series.template_parameters <> p_template_parameters then
    raise exception 'broadcast template does not match the series';
  end if;

  select campaign.*
  into v_latest
  from public.broadcast_round_requests request
  join public.broadcast_campaigns campaign
    on campaign.campaign_id = request.campaign_id
  where request.series_id = p_series_id
    and request.request_id = p_request_id;

  if found then
    return query
    select
      v_latest.campaign_id,
      v_latest.round_number,
      v_latest.recipient_count,
      false;
    return;
  end if;

  select campaign.*
  into v_latest
  from public.broadcast_campaigns campaign
  where campaign.series_id = p_series_id
  order by campaign.round_number desc
  limit 1
  for update;

  if not found then
    raise exception 'broadcast series has no recipient snapshot';
  end if;

  -- A prepared/running/incomplete round is reused. Mapping the request makes
  -- network retries idempotent even after that round later completes.
  if v_latest.state in ('idle', 'running') or v_latest.pending_count > 0 then
    insert into public.broadcast_round_requests (
      series_id,
      request_id,
      campaign_id,
      created_at
    ) values (
      p_series_id,
      p_request_id,
      v_latest.campaign_id,
      v_now
    )
    on conflict (series_id, request_id) do nothing;

    return query
    select
      v_latest.campaign_id,
      v_latest.round_number,
      v_latest.recipient_count,
      false;
    return;
  end if;

  if v_latest.processing_count > 0 or exists (
    select 1
    from public.message_logs log
    where log.campaign_id = v_latest.campaign_id
      and log.status = 'pending'
  ) then
    raise exception 'broadcast round has uncertain recipients';
  end if;

  if not exists (
    select 1
    from public.broadcast_recipients recipient
    where recipient.campaign_id = v_series.seed_campaign_id
  ) then
    raise exception 'broadcast series seed snapshot is missing';
  end if;

  v_round_number := v_latest.round_number + 1;
  v_campaign_id := p_series_id || ':r' || v_round_number::text;
  if char_length(v_campaign_id) > 128 then
    raise exception 'broadcast campaign id is too long';
  end if;

  insert into public.broadcast_recipients (campaign_id, phone, customer_name)
  select
    v_campaign_id,
    source.phone,
    source.customer_name
  from public.broadcast_recipients source
  where source.campaign_id = v_series.seed_campaign_id
    and not exists (
      select 1
      from public.broadcast_suppressions excluded
      where excluded.phone = source.phone
    );

  get diagnostics v_recipient_count = row_count;
  if v_recipient_count <= 0 then
    raise exception 'broadcast round has no eligible recipients';
  end if;

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
    p_template_name,
    p_template_parameters,
    'idle',
    v_recipient_count,
    v_recipient_count,
    p_series_id,
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
    p_series_id,
    p_request_id,
    v_campaign_id,
    v_now
  );

  return query
  select v_campaign_id, v_round_number, v_recipient_count, true;
end;
$$;

-- Campaign rows must be prepared by prepare_broadcast_round. Completed rounds
-- are immutable; only idle/incomplete or expired-running rounds can be claimed.
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
  if p_template_name is null
     or char_length(p_template_name) not between 1 and 512
     or p_template_name !~ '^[a-z0-9_]+$' then
    raise exception 'invalid template name';
  end if;
  if p_template_parameters is null or jsonb_typeof(p_template_parameters) <> 'array' then
    raise exception 'invalid template parameters';
  end if;

  update public.broadcast_campaigns campaign
  set state = 'running',
      run_token = v_requested_token,
      locked_until = v_now + make_interval(secs => v_lease),
      attempt_count = campaign.attempt_count + 1,
      recipient_count = p_recipient_count,
      started_at = v_now,
      finished_at = null,
      last_error = null,
      updated_at = v_now
  where campaign.campaign_id = p_campaign_id
    and campaign.template_name = p_template_name
    and campaign.template_parameters = p_template_parameters
    and campaign.series_id is not null
    and campaign.round_number is not null
    and not exists (
      select 1
      from public.broadcast_campaigns newer
      where newer.series_id = campaign.series_id
        and newer.round_number > campaign.round_number
    )
    and p_recipient_count = (
      select count(*)::integer
      from public.broadcast_recipients recipient
      where recipient.campaign_id = p_campaign_id
    )
    and campaign.pending_count > 0
    and (
      campaign.state in ('idle', 'partial', 'failed')
      or (
        campaign.state = 'running'
        and (campaign.locked_until is null or campaign.locked_until <= v_now)
      )
    )
  returning campaign.* into v_row;

  if not found then
    select campaign.*
    into v_row
    from public.broadcast_campaigns campaign
    where campaign.campaign_id = p_campaign_id;
  end if;

  return query
  select
    coalesce(v_row.run_token = v_requested_token, false),
    v_row.run_token,
    v_row.state,
    v_row.locked_until;
end;
$$;

revoke all on function public.prepare_broadcast_round(text, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_broadcast_campaign(text, text, jsonb, integer, integer)
  from public, anon, authenticated;

grant execute on function public.prepare_broadcast_round(text, uuid, text, jsonb)
  to service_role;
grant execute on function public.claim_broadcast_campaign(text, text, jsonb, integer, integer)
  to service_role;

commit;
