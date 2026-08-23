begin;

-- Create a separate, immutable audit lineage for the address update. The BODY
-- has one runtime parameter (the address). The Maps button is static template
-- metadata and is intentionally absent from template_parameters.
--
-- Source inclusion is copied only from the existing service-only frozen seed;
-- never rebuild this snapshot from client-writable app_state or appointments.
lock table public.broadcast_recipients in share row exclusive mode;
lock table public.broadcast_suppressions in share mode;

do $$
begin
  if not exists (
    select 1
    from public.broadcast_series source_series
    where source_series.series_id = 'mabel_reopening_2026_08_18_v2'
      and source_series.seed_campaign_id = 'mabel_reopening_2026_08_18_v2'
  ) then
    raise exception 'frozen source announcement snapshot is not configured';
  end if;

  if not exists (
    select 1
    from public.broadcast_recipients source
    where source.campaign_id = 'mabel_reopening_2026_08_18_v2'
  ) then
    raise exception 'frozen source announcement snapshot is empty';
  end if;

  -- Never overwrite or append to an existing audit lineage. A partially
  -- applied transaction rolls back, so any existing target means manual review
  -- is required rather than an automatic mutation.
  if exists (
    select 1
    from public.broadcast_series target_series
    where target_series.series_id = 'mabel_is_yeri_adres_guncellemesi_v1'
  ) or exists (
    select 1
    from public.broadcast_campaigns target_campaign
    where target_campaign.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
       or target_campaign.series_id = 'mabel_is_yeri_adres_guncellemesi_v1'
  ) or exists (
    select 1
    from public.broadcast_recipients target_recipient
    where target_recipient.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
  ) then
    raise exception 'service location update audit lineage already exists';
  end if;
end;
$$;

insert into public.broadcast_recipients (
  campaign_id,
  phone,
  customer_name
)
select
  'mabel_is_yeri_adres_guncellemesi_v1',
  source.phone,
  source.customer_name
from public.broadcast_recipients source
where source.campaign_id = 'mabel_reopening_2026_08_18_v2'
  and not exists (
    select 1
    from public.broadcast_suppressions suppressed
    where suppressed.phone = source.phone
  );

do $$
declare
  v_expected_count integer;
  v_snapshot_count integer;
begin
  select count(*)::integer
  into v_expected_count
  from public.broadcast_recipients source
  where source.campaign_id = 'mabel_reopening_2026_08_18_v2'
    and not exists (
      select 1
      from public.broadcast_suppressions suppressed
      where suppressed.phone = source.phone
    );

  select count(*)::integer
  into v_snapshot_count
  from public.broadcast_recipients target
  where target.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1';

  if v_expected_count <= 0 then
    raise exception 'service location update has no eligible recipients';
  end if;
  if v_snapshot_count <> v_expected_count then
    raise exception 'service location update snapshot count mismatch';
  end if;
end;
$$;

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
  'mabel_is_yeri_adres_guncellemesi_v1',
  'is_yeri_adres_guncellemesi',
  jsonb_build_array('Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir'),
  'idle',
  count(*)::integer,
  count(*)::integer,
  'mabel_is_yeri_adres_guncellemesi_v1',
  1
from public.broadcast_recipients target
where target.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
having count(*) > 0;

insert into public.broadcast_series (
  series_id,
  seed_campaign_id,
  template_name,
  template_parameters
) values (
  'mabel_is_yeri_adres_guncellemesi_v1',
  'mabel_is_yeri_adres_guncellemesi_v1',
  'is_yeri_adres_guncellemesi',
  jsonb_build_array('Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir')
);

do $$
declare
  v_recipient_count integer;
begin
  select count(*)::integer
  into v_recipient_count
  from public.broadcast_recipients recipient
  where recipient.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1';

  if not exists (
    select 1
    from public.broadcast_campaigns campaign
    where campaign.campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and campaign.series_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and campaign.round_number = 1
      and campaign.template_name = 'is_yeri_adres_guncellemesi'
      and campaign.template_parameters = jsonb_build_array(
        'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir'
      )
      and campaign.state = 'idle'
      and campaign.recipient_count = v_recipient_count
      and campaign.pending_count = v_recipient_count
      and campaign.sent_count = 0
      and campaign.failed_count = 0
      and campaign.processing_count = 0
      and campaign.skipped_count = 0
  ) then
    raise exception 'service location update campaign fingerprint mismatch';
  end if;

  if not exists (
    select 1
    from public.broadcast_series series
    where series.series_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and series.seed_campaign_id = 'mabel_is_yeri_adres_guncellemesi_v1'
      and series.template_name = 'is_yeri_adres_guncellemesi'
      and series.template_parameters = jsonb_build_array(
        'Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir'
      )
  ) then
    raise exception 'service location update series fingerprint mismatch';
  end if;
end;
$$;

commit;
