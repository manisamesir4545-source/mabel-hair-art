-- PostgreSQL ARE quantifier bounds cannot exceed 255. Keep the 512-character
-- application limit as a length check and validate the character set separately.
alter table public.broadcast_campaigns
  drop constraint if exists broadcast_campaigns_template_name_check;

alter table public.broadcast_campaigns
  add constraint broadcast_campaigns_template_name_check
  check (
    char_length(template_name) between 1 and 512
    and template_name ~ '^[a-z0-9_]+$'
  );

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

revoke all on function public.claim_broadcast_campaign(
  text,
  text,
  jsonb,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.claim_broadcast_campaign(
  text,
  text,
  jsonb,
  integer,
  integer
) to service_role;
