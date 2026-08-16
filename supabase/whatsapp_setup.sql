create table if not exists public.message_logs (
  id bigserial primary key,
  appointment_id bigint null,
  event text not null,
  phone text,
  template_name text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider_response jsonb,
  error_message text,
  dedupe_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists message_logs_dedupe_key_idx
  on public.message_logs (dedupe_key)
  where dedupe_key is not null;

alter table public.message_logs enable row level security;

drop policy if exists "Allow public read message_logs" on public.message_logs;

-- Mesaj loglari telefon ve saglayici cevabi gibi kisisel veri icerir.
-- Bu tablo yalnizca service-role kullanan Edge Function'lar tarafindan erisilebilir.
revoke all on table public.message_logs from public, anon, authenticated;
revoke all on sequence public.message_logs_id_seq from public, anon, authenticated;
grant all on table public.message_logs to service_role;
grant usage, select on sequence public.message_logs_id_seq to service_role;

-- Hatirlatma fonksiyonunu zamanlamak icin Supabase Dashboard > Database > Extensions
-- bolumunden pg_cron ve pg_net aktif olmalidir. Sonra Edge Function URL ve anon key ile
-- cron olusturulabilir. Bunu istersen bir sonraki adimda panelden birlikte yapariz.
