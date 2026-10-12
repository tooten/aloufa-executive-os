-- Aloufa Executive OS, migration 0003 : chargement atomique d'un import
-- La route web valide et normalise (packages/importer), puis appelle load_dataset une seule fois.
-- Tout réussit ou rien n'est écrit. Un réimport remplace les lignes de même clé, sans doublon.

-- Bucket privé des fichiers importés (Supabase Storage). Ignoré hors Supabase.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('imports', 'imports', false) on conflict (id) do nothing;
  end if;
end $$;

create or replace function load_dataset(p_dataset_id uuid, p_rows jsonb, p_captured_at timestamptz default now())
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ds datasets;
  n integer;
  v_event uuid;
  v_from date;
  v_to date;
begin
  select * into ds from datasets where id = p_dataset_id for update;
  if ds.id is null then raise exception 'dataset % introuvable', p_dataset_id; end if;
  if ds.status = 'loaded' then raise exception 'dataset % déjà chargé', p_dataset_id; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows doit être un tableau JSON'; end if;
  n := jsonb_array_length(p_rows);

  case ds.type
  when 'woocommerce_orders' then
    insert into orders (external_id, ordered_at, status, plan, total, currency, customer_hash, coupon, utm_source, utm_campaign, dataset_id)
    select r->>'external_id', (r->>'ordered_at')::timestamptz, r->>'status', r->>'plan', (r->>'total')::numeric,
           coalesce(r->>'currency', 'USD'), r->>'customer_hash', r->>'coupon', r->>'utm_source', r->>'utm_campaign', ds.id
    from jsonb_array_elements(p_rows) r
    on conflict (external_id) do update set
      ordered_at = excluded.ordered_at, status = excluded.status, plan = excluded.plan, total = excluded.total,
      currency = excluded.currency, customer_hash = excluded.customer_hash, coupon = excluded.coupon,
      utm_source = excluded.utm_source, utm_campaign = excluded.utm_campaign, dataset_id = excluded.dataset_id;
    select min(local_day((r->>'ordered_at')::timestamptz)), max(local_day((r->>'ordered_at')::timestamptz))
      into v_from, v_to from jsonb_array_elements(p_rows) r;

  when 'instagram_account' then
    insert into instagram_account_daily (day, reach, views, accounts_engaged, profile_visits, follows, unfollows, profile_links_taps, dataset_id, captured_at)
    select (r->>'day')::date, (r->>'reach')::int, (r->>'views')::int, (r->>'accounts_engaged')::int, (r->>'profile_visits')::int,
           (r->>'follows')::int, (r->>'unfollows')::int, (r->>'profile_links_taps')::int, ds.id, p_captured_at
    from jsonb_array_elements(p_rows) r
    on conflict (day) do update set
      reach = excluded.reach, views = excluded.views, accounts_engaged = excluded.accounts_engaged,
      profile_visits = excluded.profile_visits, follows = excluded.follows, unfollows = excluded.unfollows,
      profile_links_taps = excluded.profile_links_taps, dataset_id = excluded.dataset_id, captured_at = excluded.captured_at;
    select min((r->>'day')::date), max((r->>'day')::date) into v_from, v_to from jsonb_array_elements(p_rows) r;

  when 'instagram_media' then
    -- un contenu inconnu est créé au statut publié ; un contenu connu garde son statut et son concept
    insert into content_items (ig_media_id, permalink, format, published_at, status)
    select r->>'ig_media_id', r->>'permalink', coalesce(r->>'format', 'post')::content_format, (r->>'published_at')::timestamptz, 'published'
    from jsonb_array_elements(p_rows) r
    on conflict (ig_media_id) do update set
      permalink = coalesce(excluded.permalink, content_items.permalink),
      published_at = coalesce(excluded.published_at, content_items.published_at),
      updated_at = now();
    insert into content_metrics (content_id, captured_at, views, reach, saved, shares, comments, likes, profile_visits, follows, avg_watch_time_s, skip_rate, dataset_id)
    select c.id, p_captured_at, (r->>'views')::int, (r->>'reach')::int, (r->>'saved')::int, (r->>'shares')::int, (r->>'comments')::int,
           (r->>'likes')::int, (r->>'profile_visits')::int, (r->>'follows')::int, (r->>'avg_watch_time_s')::numeric, (r->>'skip_rate')::numeric, ds.id
    from jsonb_array_elements(p_rows) r join content_items c on c.ig_media_id = r->>'ig_media_id'
    on conflict (content_id, captured_at) do nothing;
    select min(local_day((r->>'published_at')::timestamptz)), local_day(p_captured_at) into v_from, v_to from jsonb_array_elements(p_rows) r;

  when 'meta_ads' then
    insert into ad_spend_daily (day, campaign, spend, impressions, results, dataset_id)
    select (r->>'day')::date, r->>'campaign', (r->>'spend')::numeric, (r->>'impressions')::int, (r->>'results')::int, ds.id
    from jsonb_array_elements(p_rows) r
    on conflict (day, campaign) do update set
      spend = excluded.spend, impressions = excluded.impressions, results = excluded.results, dataset_id = excluded.dataset_id;
    select min((r->>'day')::date), max((r->>'day')::date) into v_from, v_to from jsonb_array_elements(p_rows) r;

  else
    raise exception 'type % non chargeable par load_dataset', ds.type;
  end case;

  update datasets set status = 'loaded', loaded_at = now(), row_count = n,
    period_start = coalesce(period_start, v_from), period_end = coalesce(period_end, v_to)
  where id = ds.id;

  -- Les fenêtres de 7 jours et la rétention regardent jusqu'à 13 jours en arrière :
  -- un import modifie les KPIs jusqu'à 13 jours après sa dernière date.
  if v_from is not null then
    perform compute_kpis(v_from, least(v_to + 13, local_day(now())));
  end if;

  insert into events (type, payload, routed_to, status, created_by)
  values ('dataset_loaded',
          jsonb_build_object('dataset_id', ds.id, 'dataset_type', ds.type, 'rows', n, 'period_start', v_from, 'period_end', v_to),
          coalesce((select array_agg(key order by key) from executives where status = 'active' and ds.type = any(required_datasets)), '{}'),
          'pending', ds.uploaded_by)
  returning id into v_event;
  return v_event;
end $$;

revoke execute on function load_dataset(uuid, jsonb, timestamptz) from public, authenticated, anon;
revoke execute on function compute_kpis(date, date) from public, authenticated, anon;
