begin;

-- Keep the cron credential only in Vault. The Edge Function verifies the
-- presented value through a service-role-only RPC, so the secret never needs
-- to be copied into source control or an Edge Function environment variable.
do $$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'appointment_reminder_cron_secret'
  ) then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(48), 'base64'),
      'appointment_reminder_cron_secret',
      'Authenticates the appointment reminder pg_cron request'
    );
  end if;
end;
$$;

create or replace function public.verify_appointment_reminder_cron_secret(
  p_secret text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected text;
  v_actual_hash bytea;
  v_expected_hash bytea;
  v_difference integer := 0;
  v_index integer;
begin
  if p_secret is null
     or char_length(p_secret) < 32
     or char_length(p_secret) > 512
     or p_secret ~ '[[:cntrl:]]' then
    return false;
  end if;

  select decrypted_secret
    into v_expected
  from vault.decrypted_secrets
  where name = 'appointment_reminder_cron_secret'
  order by created_at desc
  limit 1;

  if v_expected is null then
    return false;
  end if;

  v_actual_hash := extensions.digest(p_secret, 'sha256');
  v_expected_hash := extensions.digest(v_expected, 'sha256');

  -- Compare every hash byte so a caller cannot learn the secret from an
  -- early-exit string comparison.
  for v_index in 0..31 loop
    v_difference := v_difference |
      (pg_catalog.get_byte(v_actual_hash, v_index) #
       pg_catalog.get_byte(v_expected_hash, v_index));
  end loop;

  return v_difference = 0;
end;
$$;

create or replace function public.reserve_appointment_reminder(
  p_appointment_id bigint,
  p_phone text,
  p_template_name text,
  p_dedupe_key text
)
returns table (
  claimed boolean,
  log_id bigint,
  log_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_log public.message_logs%rowtype;
  v_phone text;
  v_expected_dedupe text;
begin
  if p_appointment_id is null or p_appointment_id <= 0 then
    raise exception 'invalid appointment id';
  end if;
  if p_phone is null or p_phone !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid recipient phone';
  end if;
  if p_template_name is null
     or char_length(p_template_name) > 255
     or p_template_name !~ '^[a-z0-9_]+$' then
    raise exception 'invalid reminder template';
  end if;

  select *
    into v_appointment
  from public.appointments
  where id = p_appointment_id
  for update;

  if not found or v_appointment.status <> 'active' then
    raise exception 'appointment is not active';
  end if;

  if v_appointment.appointment_date is null
     or v_appointment.appointment_time is null
     or v_appointment.appointment_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'invalid appointment schedule';
  end if;

  v_phone := pg_catalog.regexp_replace(
    coalesce(v_appointment.phone, ''),
    '[^0-9]',
    '',
    'g'
  );
  if left(v_phone, 2) = '00' then
    v_phone := substring(v_phone from 3);
  end if;
  if left(v_phone, 1) = '0' then
    v_phone := '9' || v_phone;
  end if;
  if left(v_phone, 1) = '5' then
    v_phone := '90' || v_phone;
  end if;

  if v_phone <> p_phone then
    raise exception 'recipient phone mismatch';
  end if;

  v_expected_dedupe :=
    'appointment_reminder:' || p_appointment_id::text || ':' ||
    v_appointment.appointment_date::text || ':' ||
    v_appointment.appointment_time::text;

  if p_dedupe_key is distinct from v_expected_dedupe then
    raise exception 'invalid reminder dedupe key';
  end if;

  insert into public.message_logs (
    appointment_id,
    event,
    phone,
    template_name,
    status,
    dedupe_key
  )
  values (
    p_appointment_id,
    'appointment_reminder',
    p_phone,
    p_template_name,
    'pending',
    v_expected_dedupe
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into v_log;

  if found then
    return query select true, v_log.id, v_log.status;
    return;
  end if;

  select *
    into v_log
  from public.message_logs
  where dedupe_key = v_expected_dedupe;

  return query select false, v_log.id, v_log.status;
end;
$$;

create or replace function public.finalize_appointment_reminder(
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
    raise exception 'invalid reminder final status';
  end if;

  update public.message_logs
  set status = p_status,
      provider_response = case
        when p_status = 'sent' then p_provider_response
        else null
      end,
      error_message = case
        when p_status = 'failed'
          then left(coalesce(nullif(btrim(p_error_message), ''), 'Unknown error'), 1000)
        else null
      end
  where id = p_log_id
    and event = 'appointment_reminder'
    and campaign_id is null
    and status = 'pending'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.verify_appointment_reminder_cron_secret(text)
  from public, anon, authenticated, authenticator;
revoke all on function public.reserve_appointment_reminder(bigint, text, text, text)
  from public, anon, authenticated, authenticator;
revoke all on function public.finalize_appointment_reminder(bigint, text, jsonb, text)
  from public, anon, authenticated, authenticator;

grant execute on function public.verify_appointment_reminder_cron_secret(text)
  to service_role;
grant execute on function public.reserve_appointment_reminder(bigint, text, text, text)
  to service_role;
grant execute on function public.finalize_appointment_reminder(bigint, text, jsonb, text)
  to service_role;

-- Replace only the known reminder job. History remains in cron.job_run_details.
do $$
declare
  v_job_id bigint;
begin
  select jobid
    into v_job_id
  from cron.job
  where jobname = 'send-appointment-reminders-every-10-minutes'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end;
$$;

select cron.schedule(
  'send-appointment-reminders-every-10-minutes',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := 'https://qtyehohkrnxudeeeuuyy.supabase.co/functions/v1/send-appointment-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'appointment_reminder_cron_secret'
        order by created_at desc
        limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id;
  $cron$
);

commit;
