create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

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
      'apikey', 'sb_publishable_KfbRV__Miliq9HF_tJ_oIw_Sl0aYbw5',
      'Authorization', 'Bearer sb_publishable_KfbRV__Miliq9HF_tJ_oIw_Sl0aYbw5'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
