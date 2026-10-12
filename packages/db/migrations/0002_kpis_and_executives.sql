-- Aloufa Executive OS, migration 0002 : calcul des KPIs en SQL et dirigeants pré-configurés
-- Règle : le modèle lit kpi_daily, il ne calcule jamais un KPI.
-- Fenêtre glissante de 7 jours qui se termine au jour d inclus, jours en heure de Washington.

create or replace function local_day(ts timestamptz) returns date
language sql immutable as $$ select (ts at time zone 'America/New_York')::date $$;

-- Statuts WooCommerce comptés comme encaissés
create or replace function is_paid_status(s text) returns boolean
language sql immutable as $$ select s in ('completed', 'processing') $$;

create or replace function compute_kpis(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare d date; v_days integer := 0;
begin
  delete from kpi_daily where day between p_from and p_to and kpi_key not like 'freshness_h:%';

  for d in select generate_series(p_from, p_to, interval '1 day')::date loop

    -- Instagram compte. reach ne s'additionne pas sur plusieurs jours : seul reach_1d est publié.
    insert into kpi_daily (day, kpi_key, value, source)
    select d, k, v, 'instagram_account'::dataset_type from (
      select 'reach_1d' k, (select reach::numeric from instagram_account_daily where day = d) v
      union all select 'views_7d', sum(views) from instagram_account_daily where day between d - 6 and d having count(*) > 0
      union all select 'profile_visits_7d', sum(profile_visits) from instagram_account_daily where day between d - 6 and d having count(*) > 0
      union all select 'follows_net_7d', sum(coalesce(follows, 0) - coalesce(unfollows, 0)) from instagram_account_daily where day between d - 6 and d having count(*) > 0
      union all select 'link_taps_7d', sum(profile_links_taps) from instagram_account_daily where day between d - 6 and d having count(*) > 0
    ) x where v is not null;

    -- Instagram publications : dernier instantané connu à la date d de chaque contenu publié dans la fenêtre
    insert into kpi_daily (day, kpi_key, value, source)
    select d, k, v, 'instagram_media'::dataset_type from (
      with latest as (
        select distinct on (m.content_id) m.*, c.format
        from content_metrics m join content_items c on c.id = m.content_id
        where local_day(c.published_at) between d - 6 and d and local_day(m.captured_at) <= d
        order by m.content_id, m.captured_at desc
      )
      select 'save_rate_7d' k, sum(saved)::numeric / nullif(sum(reach), 0) v from latest
      union all select 'share_rate_7d', sum(shares)::numeric / nullif(sum(reach), 0) from latest
      union all select 'watch_time_avg_7d', avg(avg_watch_time_s) from latest where format = 'reel'
      union all select 'skip_rate_7d', avg(skip_rate) from latest where format = 'reel'
      union all select 'posts_published_7d', count(*)::numeric from latest
    ) x where v is not null;

    -- Commandes
    insert into kpi_daily (day, kpi_key, value, source)
    select d, k, v, 'woocommerce_orders'::dataset_type from (
      with paid as (select * from orders where is_paid_status(status)),
           win as (select * from paid where local_day(ordered_at) between d - 6 and d),
           firsts as (select customer_hash, min(local_day(ordered_at)) first_day from paid group by customer_hash),
           prev_c as (select distinct customer_hash from paid where local_day(ordered_at) between d - 13 and d - 7),
           cur_c as (select distinct customer_hash from win),
           spend as (select sum(spend) s from ad_spend_daily where day between d - 6 and d),
           news as (select count(*) nb from firsts where first_day between d - 6 and d)
      select 'revenue_7d' k, sum(total) v from win having count(*) > 0
      union all select 'orders_7d', count(*)::numeric from win
      union all select 'aov_7d', sum(total) / nullif(count(*), 0) from win
      union all select 'new_customers_7d', (select nb from news)::numeric
      union all select 'retention_w', (select count(*) from prev_c join cur_c using (customer_hash))::numeric
                                      / nullif((select count(*) from prev_c), 0)
      union all select 'cac_7d', (select s from spend) / nullif((select nb from news), 0)
      union all select 'attributed_orders_7d', count(*) filter (where lower(utm_source) = 'instagram' or coupon is not null)::numeric from win
      union all select 'plan_mix:' || coalesce(plan, 'inconnu'), count(*)::numeric / nullif(sum(count(*)) over (), 0) from win group by plan
    ) x where v is not null and exists (select 1 from orders);

    v_days := v_days + 1;
  end loop;

  -- Fraîcheur par source, en heures, au moment du calcul
  delete from kpi_daily where kpi_key like 'freshness_h:%';
  insert into kpi_daily (day, kpi_key, value, source)
  select local_day(now()), 'freshness_h:' || type, extract(epoch from now() - max(loaded_at)) / 3600, type
  from datasets where status = 'loaded' group by type;

  return v_days;
end $$;

-- Seul compute_kpis écrit kpi_daily : personne d'autre n'a le droit d'écriture
revoke insert, update, delete on kpi_daily from public, authenticated, anon;

-- ---------------------------------------------------------------- dirigeants
insert into executives (key, name, mission, status, required_datasets, reviewer, allowed_tools, autonomy_policy) values
('ceo', 'CEO', 'Brief hebdomadaire, priorités, arbitrage des désaccords', 'active', '{}', null,
  '{query_kpis,query_findings,query_decisions,propose_decision,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","review":"arbitration","alert_without_review":true,"create_task":"via_approved_decision","spend":"never","publish":"never","message_customer":"never"}'),
('cmo', 'CMO', 'Funnel Instagram et acquisition', 'dormant', '{instagram_account}', 'ceo',
  '{query_kpis,query_content,read_brand_doc,propose_decision,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","review":"creative_director","alert_without_review":false,"create_task":"via_approved_decision","spend":"never","publish":"never","message_customer":"never"}'),
('creative_director', 'Creative Director', 'Performance créative et pipeline de contenus', 'dormant', '{instagram_media}', 'cmo',
  '{query_kpis,query_content,read_brand_doc,propose_decision,draft_brief,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","review":"none","alert_without_review":false,"calendar":"propose","brief":"alone","canva":"via_approved_task","create_task":"via_approved_decision","spend":"never","publish":"never","message_customer":"never"}'),
('cfo', 'CFO', 'Revenu, économie unitaire, rétention', 'dormant', '{woocommerce_orders}', 'ceo',
  '{query_kpis,query_orders,propose_decision,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","review":"budgets","alert_without_review":true,"create_task":"via_approved_decision","spend":"never","publish":"never","message_customer":"never"}'),
('coo', 'COO', 'Capacité de production, livraison, réclamations', 'dormant', '{operations}', 'ceo',
  '{query_kpis,propose_decision,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","spend":"never","publish":"never","message_customer":"never"}'),
('cto', 'CTO', 'Qualité des données, tracking, attribution', 'dormant', '{}', 'ceo',
  '{query_kpis,query_datasets,propose_decision,flag_missing_data}',
  '{"read":"alone","propose_decision":"alone","spend":"never","publish":"never","message_customer":"never"}')
on conflict (key) do nothing;

-- Un dirigeant passe actif quand toutes ses sources ont au moins un dataset chargé
create or replace function activate_executives() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'loaded' then
    update executives e set status = 'active', updated_at = now()
    where e.status = 'dormant'
      and cardinality(e.required_datasets) > 0
      and not exists (
        select 1 from unnest(e.required_datasets) r(t)
        where not exists (select 1 from datasets ds where ds.type = r.t and ds.status = 'loaded'));
  end if;
  return new;
end $$;

create trigger datasets_activate after insert or update of status on datasets
  for each row execute function activate_executives();
