begin;

-- Meta accepting a message is not the same as the recipient receiving it.
-- Keep the existing send-attempt status in message_logs.status and track the
-- provider lifecycle separately.
alter table public.message_logs
  add column if not exists provider_message_id text,
  add column if not exists delivery_status text,
  add column if not exists delivery_status_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists provider_sent_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists delivery_failed_at timestamptz,
  add column if not exists provider_event_updated_at timestamptz,
  add column if not exists delivery_error_code text,
  add column if not exists delivery_error_title text,
  add column if not exists delivery_error_message text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'message_logs_provider_message_id_check'
      and conrelid = 'public.message_logs'::regclass
  ) then
    alter table public.message_logs
      add constraint message_logs_provider_message_id_check
      check (
        provider_message_id is null
        or (
          provider_message_id = btrim(provider_message_id)
          and char_length(provider_message_id) between 1 and 512
          and provider_message_id !~ '[[:space:][:cntrl:]]'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'message_logs_delivery_status_check'
      and conrelid = 'public.message_logs'::regclass
  ) then
    alter table public.message_logs
      add constraint message_logs_delivery_status_check
      check (
        delivery_status is null
        or delivery_status in ('sent', 'delivered', 'read', 'failed', 'deleted')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'message_logs_delivery_error_fields_check'
      and conrelid = 'public.message_logs'::regclass
  ) then
    alter table public.message_logs
      add constraint message_logs_delivery_error_fields_check
      check (
        (delivery_error_code is null or (
          char_length(delivery_error_code) between 1 and 64
          and delivery_error_code ~ '^[0-9A-Za-z_.:-]+$'
        ))
        and (delivery_error_title is null or (
          char_length(delivery_error_title) between 1 and 256
          and delivery_error_title !~ '[[:cntrl:]]'
        ))
        and (delivery_error_message is null or (
          char_length(delivery_error_message) between 1 and 1000
          and delivery_error_message !~ '[[:cntrl:]]'
        ))
      );
  end if;
end
$$;

-- Backfill only structurally valid provider IDs. If legacy data somehow
-- contains the same WAMID more than once, the earliest row becomes canonical
-- so the unique index can still be installed safely.
with candidates as (
  select
    log.id,
    btrim(log.provider_response #>> '{messages,0,id}') as provider_message_id,
    row_number() over (
      partition by btrim(log.provider_response #>> '{messages,0,id}')
      order by log.created_at, log.id
    ) as occurrence
  from public.message_logs log
  where jsonb_typeof(log.provider_response) = 'object'
    and jsonb_typeof(log.provider_response -> 'messages') = 'array'
    and jsonb_array_length(log.provider_response -> 'messages') > 0
    and jsonb_typeof(log.provider_response -> 'messages' -> 0 -> 'id') = 'string'
), valid_candidates as (
  select candidate.id, candidate.provider_message_id
  from candidates candidate
  where candidate.occurrence = 1
    and char_length(candidate.provider_message_id) between 1 and 512
    and candidate.provider_message_id !~ '[[:space:][:cntrl:]]'
)
update public.message_logs log
set provider_message_id = candidate.provider_message_id,
    accepted_at = coalesce(log.accepted_at, log.created_at)
from valid_candidates candidate
where log.id = candidate.id
  and log.provider_message_id is null;

create unique index if not exists message_logs_provider_message_id_uidx
  on public.message_logs (provider_message_id)
  where provider_message_id is not null;

create index if not exists message_logs_campaign_delivery_status_idx
  on public.message_logs (campaign_id, delivery_status)
  where campaign_id is not null;

-- Store each provider event before attempting to match it to a send log. This
-- closes the race where Meta posts a status before the send function commits
-- the API response containing the WAMID.
create table if not exists public.whatsapp_status_event_inbox (
  provider_message_id text not null,
  delivery_status text not null,
  event_at timestamptz not null,
  delivery_error_code text,
  delivery_error_title text,
  delivery_error_message text,
  received_at timestamptz not null default clock_timestamp(),
  primary key (provider_message_id, delivery_status, event_at),
  constraint whatsapp_status_event_inbox_provider_id_check check (
    provider_message_id = btrim(provider_message_id)
    and char_length(provider_message_id) between 1 and 512
    and provider_message_id !~ '[[:space:][:cntrl:]]'
  ),
  constraint whatsapp_status_event_inbox_status_check check (
    delivery_status in ('sent', 'delivered', 'read', 'failed', 'deleted')
  ),
  constraint whatsapp_status_event_inbox_error_fields_check check (
    (delivery_error_code is null or (
      char_length(delivery_error_code) between 1 and 64
      and delivery_error_code ~ '^[0-9A-Za-z_.:-]+$'
    ))
    and (delivery_error_title is null or (
      char_length(delivery_error_title) between 1 and 256
      and delivery_error_title !~ '[[:cntrl:]]'
    ))
    and (delivery_error_message is null or (
      char_length(delivery_error_message) between 1 and 1000
      and delivery_error_message !~ '[[:cntrl:]]'
    ))
    and (
      delivery_status = 'failed'
      or (
        delivery_error_code is null
        and delivery_error_title is null
        and delivery_error_message is null
      )
    )
  )
);

alter table public.whatsapp_status_event_inbox enable row level security;
alter table public.whatsapp_status_event_inbox force row level security;

revoke all on table public.whatsapp_status_event_inbox
  from public, anon, authenticated, authenticator, service_role;

create or replace function public.whatsapp_delivery_status_rank(p_status text)
returns integer
language sql
immutable
strict
security definer
set search_path = ''
as $$
  select case p_status
    when 'sent' then 10
    when 'failed' then 15
    when 'delivered' then 20
    when 'read' then 30
    when 'deleted' then 40
    else -1
  end;
$$;

create or replace function public.whatsapp_status_event_aggregate(
  p_provider_message_id text
)
returns table (
  delivery_status text,
  delivery_status_at timestamptz,
  provider_sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  deleted_at timestamptz,
  delivery_failed_at timestamptz,
  provider_event_updated_at timestamptz,
  delivery_error_code text,
  delivery_error_title text,
  delivery_error_message text
)
language sql
stable
security definer
set search_path = ''
as $$
  with matching_events as (
    select event.*
    from public.whatsapp_status_event_inbox event
    where event.provider_message_id = p_provider_message_id
  ), current_event as (
    select event.delivery_status, event.event_at
    from matching_events event
    order by
      public.whatsapp_delivery_status_rank(event.delivery_status) desc,
      event.event_at asc
    limit 1
  ), failed_event as (
    select
      event.delivery_error_code,
      event.delivery_error_title,
      event.delivery_error_message
    from matching_events event
    where event.delivery_status = 'failed'
    order by event.event_at desc
    limit 1
  ), milestones as (
    select
      min(event.event_at) filter (where event.delivery_status = 'sent') as provider_sent_at,
      min(event.event_at) filter (where event.delivery_status = 'delivered') as delivered_at,
      min(event.event_at) filter (where event.delivery_status = 'read') as read_at,
      min(event.event_at) filter (where event.delivery_status = 'deleted') as deleted_at,
      min(event.event_at) filter (where event.delivery_status = 'failed') as delivery_failed_at,
      max(event.event_at) as provider_event_updated_at
    from matching_events event
  )
  select
    current_event.delivery_status,
    current_event.event_at,
    milestones.provider_sent_at,
    milestones.delivered_at,
    milestones.read_at,
    milestones.deleted_at,
    milestones.delivery_failed_at,
    milestones.provider_event_updated_at,
    failed_event.delivery_error_code,
    failed_event.delivery_error_title,
    failed_event.delivery_error_message
  from current_event
  cross join milestones
  left join failed_event on true;
$$;

create or replace function public.message_logs_sync_whatsapp_tracking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_explicit_candidate text := nullif(btrim(new.provider_message_id), '');
  v_candidate text;
  v_response_candidate text;
  v_from_provider_response boolean := false;
  v_aggregate record;
begin
  v_candidate := v_explicit_candidate;

  if jsonb_typeof(new.provider_response) = 'object'
     and jsonb_typeof(new.provider_response -> 'messages') = 'array'
     and jsonb_array_length(new.provider_response -> 'messages') > 0
     and jsonb_typeof(new.provider_response -> 'messages' -> 0 -> 'id') = 'string' then
    v_response_candidate := nullif(
      btrim(new.provider_response #>> '{messages,0,id}'),
      ''
    );
    if v_response_candidate is not null
       and char_length(v_response_candidate) <= 512
       and v_response_candidate !~ '[[:space:][:cntrl:]]' then
      v_candidate := v_response_candidate;
      v_from_provider_response := true;
    end if;
  end if;

  if v_candidate is not null then
    if char_length(v_candidate) > 512
       or v_candidate ~ '[[:space:][:cntrl:]]' then
      raise exception 'invalid provider message id';
    end if;
  end if;

  new.provider_message_id := v_candidate;

  if new.provider_message_id is null then
    return new;
  end if;

  -- Serialize API finalization and webhook ingestion for this WAMID. Without
  -- this lock, two concurrent transactions could each miss the other's row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.provider_message_id, 0)
  );

  if v_from_provider_response or new.status = 'sent' then
    new.accepted_at := coalesce(new.accepted_at, new.created_at, clock_timestamp());
  end if;

  select * into v_aggregate
  from public.whatsapp_status_event_aggregate(new.provider_message_id);

  if not found then
    return new;
  end if;

  if public.whatsapp_delivery_status_rank(v_aggregate.delivery_status)
     > coalesce(public.whatsapp_delivery_status_rank(new.delivery_status), -1) then
    new.delivery_status := v_aggregate.delivery_status;
    new.delivery_status_at := v_aggregate.delivery_status_at;
  elsif v_aggregate.delivery_status = new.delivery_status then
    new.delivery_status_at := case
      when new.delivery_status_at is null then v_aggregate.delivery_status_at
      when v_aggregate.delivery_status_at is null then new.delivery_status_at
      else least(new.delivery_status_at, v_aggregate.delivery_status_at)
    end;
  end if;

  new.provider_sent_at := case
    when new.provider_sent_at is null then v_aggregate.provider_sent_at
    when v_aggregate.provider_sent_at is null then new.provider_sent_at
    else least(new.provider_sent_at, v_aggregate.provider_sent_at)
  end;
  new.delivered_at := case
    when new.delivered_at is null then v_aggregate.delivered_at
    when v_aggregate.delivered_at is null then new.delivered_at
    else least(new.delivered_at, v_aggregate.delivered_at)
  end;
  new.read_at := case
    when new.read_at is null then v_aggregate.read_at
    when v_aggregate.read_at is null then new.read_at
    else least(new.read_at, v_aggregate.read_at)
  end;
  new.deleted_at := case
    when new.deleted_at is null then v_aggregate.deleted_at
    when v_aggregate.deleted_at is null then new.deleted_at
    else least(new.deleted_at, v_aggregate.deleted_at)
  end;
  new.delivery_failed_at := case
    when new.delivery_failed_at is null then v_aggregate.delivery_failed_at
    when v_aggregate.delivery_failed_at is null then new.delivery_failed_at
    else least(new.delivery_failed_at, v_aggregate.delivery_failed_at)
  end;
  new.provider_event_updated_at := case
    when new.provider_event_updated_at is null then v_aggregate.provider_event_updated_at
    when v_aggregate.provider_event_updated_at is null then new.provider_event_updated_at
    else greatest(new.provider_event_updated_at, v_aggregate.provider_event_updated_at)
  end;
  new.delivery_error_code := coalesce(
    v_aggregate.delivery_error_code,
    new.delivery_error_code
  );
  new.delivery_error_title := coalesce(
    v_aggregate.delivery_error_title,
    new.delivery_error_title
  );
  new.delivery_error_message := coalesce(
    v_aggregate.delivery_error_message,
    new.delivery_error_message
  );

  return new;
end;
$$;

drop trigger if exists message_logs_sync_whatsapp_tracking
  on public.message_logs;

create trigger message_logs_sync_whatsapp_tracking
before insert or update of provider_response, provider_message_id, status
on public.message_logs
for each row
execute function public.message_logs_sync_whatsapp_tracking();

-- Preserve the existing RPC contract while taking the same WAMID lock before
-- PostgreSQL locks the message_logs row. This lock order prevents a deadlock
-- with a status webhook that arrives during API finalization.
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
  v_provider_message_id text;
  v_updated boolean := false;
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'invalid final message status';
  end if;

  if p_status = 'sent'
     and jsonb_typeof(p_provider_response) = 'object'
     and jsonb_typeof(p_provider_response -> 'messages') = 'array'
     and jsonb_array_length(p_provider_response -> 'messages') > 0
     and jsonb_typeof(p_provider_response -> 'messages' -> 0 -> 'id') = 'string' then
    v_provider_message_id := nullif(
      btrim(p_provider_response #>> '{messages,0,id}'),
      ''
    );
    if v_provider_message_id is not null
       and char_length(v_provider_message_id) <= 512
       and v_provider_message_id !~ '[[:space:][:cntrl:]]' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_provider_message_id, 0)
      );
    end if;
  end if;

  update public.message_logs
  set status = p_status,
      provider_response = case
        when p_status = 'sent' then p_provider_response
        else null
      end,
      error_message = case
        when p_status = 'failed'
          then left(coalesce(p_error_message, 'Unknown error'), 2000)
        else null
      end
  where id = p_log_id
    and campaign_id is not null
    and status = 'pending'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

create or replace function public.record_whatsapp_status_event(
  p_provider_message_id text,
  p_status text,
  p_event_at timestamptz,
  p_error_code text default null,
  p_error_title text default null,
  p_error_message text default null
)
returns table (matched boolean, current_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_message_id text := nullif(btrim(p_provider_message_id), '');
  v_status text := lower(nullif(btrim(p_status), ''));
  v_error_code text;
  v_error_title text;
  v_error_message text;
  v_aggregate record;
  v_matched boolean := false;
  v_current_status text;
begin
  if v_provider_message_id is null
     or char_length(v_provider_message_id) > 512
     or v_provider_message_id ~ '[[:space:][:cntrl:]]' then
    raise exception 'invalid provider message id';
  end if;

  if v_status not in ('sent', 'delivered', 'read', 'failed', 'deleted') then
    raise exception 'invalid delivery status';
  end if;

  if p_event_at is null
     or p_event_at < timestamptz '2000-01-01 00:00:00+00'
     or p_event_at > clock_timestamp() + interval '1 day' then
    raise exception 'invalid provider event timestamp';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_provider_message_id, 0)
  );

  if v_status = 'failed' then
    v_error_code := nullif(left(regexp_replace(
      btrim(coalesce(p_error_code, '')),
      '[^0-9A-Za-z_.:-]',
      '',
      'g'
    ), 64), '');
    v_error_title := nullif(left(regexp_replace(
      btrim(coalesce(p_error_title, '')),
      '[[:cntrl:]]+',
      ' ',
      'g'
    ), 256), '');
    v_error_message := nullif(left(regexp_replace(
      btrim(coalesce(p_error_message, '')),
      '[[:cntrl:]]+',
      ' ',
      'g'
    ), 1000), '');
  end if;

  insert into public.whatsapp_status_event_inbox (
    provider_message_id,
    delivery_status,
    event_at,
    delivery_error_code,
    delivery_error_title,
    delivery_error_message
  ) values (
    v_provider_message_id,
    v_status,
    p_event_at,
    v_error_code,
    v_error_title,
    v_error_message
  )
  on conflict (provider_message_id, delivery_status, event_at) do nothing;

  select * into v_aggregate
  from public.whatsapp_status_event_aggregate(v_provider_message_id);

  update public.message_logs log
  set delivery_status = case
        when public.whatsapp_delivery_status_rank(v_aggregate.delivery_status)
             > coalesce(public.whatsapp_delivery_status_rank(log.delivery_status), -1)
          then v_aggregate.delivery_status
        else log.delivery_status
      end,
      delivery_status_at = case
        when public.whatsapp_delivery_status_rank(v_aggregate.delivery_status)
             > coalesce(public.whatsapp_delivery_status_rank(log.delivery_status), -1)
          then v_aggregate.delivery_status_at
        when v_aggregate.delivery_status = log.delivery_status then
          case
            when log.delivery_status_at is null then v_aggregate.delivery_status_at
            when v_aggregate.delivery_status_at is null then log.delivery_status_at
            else least(log.delivery_status_at, v_aggregate.delivery_status_at)
          end
        else log.delivery_status_at
      end,
      provider_sent_at = case
        when log.provider_sent_at is null then v_aggregate.provider_sent_at
        when v_aggregate.provider_sent_at is null then log.provider_sent_at
        else least(log.provider_sent_at, v_aggregate.provider_sent_at)
      end,
      delivered_at = case
        when log.delivered_at is null then v_aggregate.delivered_at
        when v_aggregate.delivered_at is null then log.delivered_at
        else least(log.delivered_at, v_aggregate.delivered_at)
      end,
      read_at = case
        when log.read_at is null then v_aggregate.read_at
        when v_aggregate.read_at is null then log.read_at
        else least(log.read_at, v_aggregate.read_at)
      end,
      deleted_at = case
        when log.deleted_at is null then v_aggregate.deleted_at
        when v_aggregate.deleted_at is null then log.deleted_at
        else least(log.deleted_at, v_aggregate.deleted_at)
      end,
      delivery_failed_at = case
        when log.delivery_failed_at is null then v_aggregate.delivery_failed_at
        when v_aggregate.delivery_failed_at is null then log.delivery_failed_at
        else least(log.delivery_failed_at, v_aggregate.delivery_failed_at)
      end,
      provider_event_updated_at = case
        when log.provider_event_updated_at is null then v_aggregate.provider_event_updated_at
        when v_aggregate.provider_event_updated_at is null then log.provider_event_updated_at
        else greatest(log.provider_event_updated_at, v_aggregate.provider_event_updated_at)
      end,
      delivery_error_code = coalesce(
        v_aggregate.delivery_error_code,
        log.delivery_error_code
      ),
      delivery_error_title = coalesce(
        v_aggregate.delivery_error_title,
        log.delivery_error_title
      ),
      delivery_error_message = coalesce(
        v_aggregate.delivery_error_message,
        log.delivery_error_message
      )
  where log.provider_message_id = v_provider_message_id
  returning true, log.delivery_status
  into v_matched, v_current_status;

  return query
  select coalesce(v_matched, false), v_current_status;
end;
$$;

create or replace function public.get_broadcast_delivery_summary(
  p_campaign_id text
)
returns table (
  total_count bigint,
  accepted_count bigint,
  sent_count bigint,
  delivered_count bigint,
  read_count bigint,
  deleted_count bigint,
  delivery_failed_count bigint,
  unknown_count bigint,
  api_failed_count bigint,
  pending_count bigint,
  skipped_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_campaign_id is null
     or p_campaign_id !~ '^[a-z0-9_:-]{1,128}$' then
    raise exception 'invalid campaign id';
  end if;

  return query
  select
    count(*)::bigint,
    count(*) filter (where log.status = 'sent')::bigint,
    count(*) filter (where log.delivery_status = 'sent')::bigint,
    count(*) filter (where log.delivery_status = 'delivered')::bigint,
    count(*) filter (where log.delivery_status = 'read')::bigint,
    count(*) filter (where log.delivery_status = 'deleted')::bigint,
    count(*) filter (where log.delivery_status = 'failed')::bigint,
    count(*) filter (
      where log.status = 'sent' and log.delivery_status is null
    )::bigint,
    count(*) filter (where log.status = 'failed')::bigint,
    count(*) filter (where log.status = 'pending')::bigint,
    count(*) filter (where log.status = 'skipped')::bigint
  from public.message_logs log
  where log.campaign_id = p_campaign_id;
end;
$$;

revoke all on function public.whatsapp_delivery_status_rank(text)
  from public, anon, authenticated, authenticator, service_role;
revoke all on function public.whatsapp_status_event_aggregate(text)
  from public, anon, authenticated, authenticator, service_role;
revoke all on function public.message_logs_sync_whatsapp_tracking()
  from public, anon, authenticated, authenticator, service_role;
revoke all on function public.finalize_broadcast_message(bigint, text, jsonb, text)
  from public, anon, authenticated, authenticator;
revoke all on function public.record_whatsapp_status_event(
  text,
  text,
  timestamptz,
  text,
  text,
  text
) from public, anon, authenticated, authenticator;
revoke all on function public.get_broadcast_delivery_summary(text)
  from public, anon, authenticated, authenticator;

grant execute on function public.record_whatsapp_status_event(
  text,
  text,
  timestamptz,
  text,
  text,
  text
) to service_role;
grant execute on function public.finalize_broadcast_message(bigint, text, jsonb, text)
  to service_role;
grant execute on function public.get_broadcast_delivery_summary(text)
  to service_role;

commit;
