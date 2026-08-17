begin;

-- Recheck service-only suppressions in the same statement that reserves the
-- provider send. A suppressed recipient receives a terminal skipped log, so
-- the round can finish without ever calling Meta for that phone.
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

  with suppression as (
    select exists (
      select 1
      from public.broadcast_suppressions blocked
      where blocked.phone = p_phone
    ) as blocked
  )
  insert into public.message_logs (
    event,
    phone,
    template_name,
    status,
    error_message,
    dedupe_key,
    campaign_id
  )
  select
    'customer_announcement',
    p_phone,
    p_template_name,
    case when suppression.blocked then 'skipped' else 'pending' end,
    case when suppression.blocked then 'Recipient suppressed before send' else null end,
    v_dedupe_key,
    p_campaign_id
  from suppression
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into v_log;

  if found then
    return query select v_log.status = 'pending', v_log.id, v_log.status;
    return;
  end if;

  select * into v_log
  from public.message_logs
  where dedupe_key = v_dedupe_key;

  return query select false, v_log.id, v_log.status;
end;
$$;

revoke all on function public.reserve_broadcast_message(text, uuid, text, text)
  from public, anon, authenticated, authenticator;
grant execute on function public.reserve_broadcast_message(text, uuid, text, text)
  to service_role;

-- Supabase's project-level default ACL can grant the login role privileges
-- directly. PostgREST switches to anon/authenticated/service_role before the
-- query, so the authenticator login itself does not need broadcast access.
revoke all on table public.broadcast_campaigns from authenticator;
revoke all on table public.broadcast_recipients from authenticator;
revoke all on table public.broadcast_round_requests from authenticator;
revoke all on table public.broadcast_series from authenticator;
revoke all on table public.broadcast_suppressions from authenticator;
revoke all on table public.message_logs from authenticator;
revoke all on sequence public.message_logs_id_seq from authenticator;

revoke all on function public.prepare_broadcast_round(text, uuid, text, jsonb)
  from authenticator;
revoke all on function public.claim_broadcast_campaign(text, text, jsonb, integer, integer)
  from authenticator;
revoke all on function public.renew_broadcast_campaign(text, uuid, integer)
  from authenticator;
revoke all on function public.finalize_broadcast_message(bigint, text, jsonb, text)
  from authenticator;
revoke all on function public.complete_broadcast_campaign(text, uuid, integer, integer, integer, integer, integer, text)
  from authenticator;

commit;
