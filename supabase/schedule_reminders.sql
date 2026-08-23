create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Store the cron credential in Vault. Never put it in source control or an
-- Edge Function environment variable.
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

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
    from cron.job
    where jobname = 'send-appointment-reminders-every-10-minutes'
    limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end $$;

select cron.schedule(
  'send-appointment-reminders-every-10-minutes',
  '*/10 * * * *',
  $$
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
  $$
);
