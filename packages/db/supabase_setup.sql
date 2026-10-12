-- Aloufa Executive OS : installation complète de la base (migrations 0001 à 0004)
-- À coller tel quel dans Supabase > SQL Editor > New query, puis Run. Une seule fois.

-- Aloufa Executive OS, migration 0001 : modèle d'objets
-- Source : doc "Aloufa Executive OS : architecture produit", sections 4 à 11.
-- Règles portées par la base, pas par l'interface :
--   * une décision ne passe en approuvée que par un compte de rôle fondateur
--   * un contenu ne passe en publié que s'il a un ig_media_id
--   * les KPIs sont calculés en SQL (kpi_daily), jamais écrits par un dirigeant
--   * rien ne s'efface : audit_log sur toutes les tables métier

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type app_role         as enum ('operator', 'founder');
create type ui_locale        as enum ('fr', 'en');
create type executive_key    as enum ('ceo', 'cmo', 'creative_director', 'cfo', 'coo', 'cto');
create type executive_status as enum ('dormant', 'active', 'suspended');
create type dataset_type     as enum ('instagram_account', 'instagram_media', 'meta_ads', 'woocommerce_orders', 'brand_doc', 'operations');
create type dataset_status   as enum ('uploaded', 'mapped', 'validated', 'loaded', 'rejected');
create type event_type       as enum ('dataset_loaded', 'weekly_tick', 'question', 'disagreement', 'task_assigned', 'monthly_tick');
create type event_status     as enum ('pending', 'routed', 'done', 'failed');
create type run_status       as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type run_kind         as enum ('analysis', 'review', 'arbitration', 'answer', 'brief');
create type finding_severity as enum ('info', 'watch', 'alert');
create type decision_status  as enum ('proposed', 'in_review', 'approved', 'rejected', 'deferred', 'superseded', 'revoked');
create type content_format   as enum ('reel', 'post', 'carousel', 'story');
create type content_status   as enum ('idea', 'briefed', 'approved', 'in_production', 'to_review', 'needs_revision', 'ready_to_publish', 'published', 'analyzed', 'archived');
create type content_language as enum ('en', 'fr', 'bilingual', 'neutral');
create type task_status      as enum ('todo', 'in_progress', 'done', 'cancelled');
create type experiment_status as enum ('planned', 'running', 'concluded', 'abandoned');
create type job_status       as enum ('queued', 'leased', 'done', 'failed');

-- ---------------------------------------------------------------- profils et rôles
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role        app_role not null,
  locale      ui_locale not null default 'fr',
  created_at  timestamptz not null default now()
);

create or replace function current_app_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------- dirigeants
create table executives (
  key                   executive_key primary key,
  name                  text not null,
  mission               text not null,
  status                executive_status not null default 'dormant',
  required_datasets     dataset_type[] not null default '{}',
  reviewer              executive_key references executives (key),
  allowed_tools         text[] not null default '{}',
  autonomy_policy       jsonb not null default '{}'::jsonb,
  prompt_version        text not null default 'v1',
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------- données importées
create table datasets (
  id            uuid primary key default gen_random_uuid(),
  type          dataset_type not null,
  file_path     text not null,                 -- Storage privé
  period_start  date,
  period_end    date,
  column_mapping jsonb not null default '{}'::jsonb,
  quality_report jsonb not null default '{}'::jsonb,
  row_count     integer not null default 0,
  rejected_count integer not null default 0,
  status        dataset_status not null default 'uploaded',
  uploaded_by   uuid references profiles (id),
  created_at    timestamptz not null default now(),
  loaded_at     timestamptz
);

create table instagram_account_daily (
  day               date primary key,
  reach             integer,
  views             integer,
  accounts_engaged  integer,
  profile_visits    integer,
  follows           integer,
  unfollows         integer,
  profile_links_taps integer,
  dataset_id        uuid not null references datasets (id),
  captured_at       timestamptz not null default now()
);

create table content_items (
  id              uuid primary key default gen_random_uuid(),
  ig_media_id     text unique,
  permalink       text,
  format          content_format not null,
  published_at    timestamptz,
  language        content_language,
  pillar          text,
  hook_type       text,
  hook_text       text,
  concept         jsonb,          -- format concept : objectif, audience, insight, big idea, hooks, métrique, hypothèse, risques
  brief           jsonb,
  canva_url       text,
  status          content_status not null default 'idea',
  success_metric  text,
  decision_id     uuid,           -- FK posée plus bas
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint published_requires_media
    check (status not in ('published', 'analyzed') or ig_media_id is not null)
);

create table content_metrics (
  id              bigint generated always as identity primary key,
  content_id      uuid not null references content_items (id) on delete cascade,
  captured_at     timestamptz not null,
  views           integer,
  reach           integer,
  saved           integer,
  shares          integer,
  comments        integer,
  likes           integer,
  profile_visits  integer,
  follows         integer,
  avg_watch_time_s numeric,       -- Reels seulement
  skip_rate       numeric,        -- Reels seulement
  dataset_id      uuid not null references datasets (id),
  unique (content_id, captured_at)
);

create table orders (
  id              uuid primary key default gen_random_uuid(),
  external_id     text not null unique,
  ordered_at      timestamptz not null,
  status          text not null,
  plan            text,
  total           numeric(12, 2) not null,
  currency        char(3) not null default 'USD',
  customer_hash   text not null,  -- sha256 de l'email normalisé, calculé à l'import
  coupon          text,
  utm_source      text,
  utm_campaign    text,
  dataset_id      uuid not null references datasets (id)
);

create table ad_spend_daily (
  day          date not null,
  campaign     text not null,
  spend        numeric(12, 2) not null,
  impressions  integer,
  results      integer,
  currency     char(3) not null default 'USD',
  dataset_id   uuid not null references datasets (id),
  primary key (day, campaign)
);

-- KPIs : écrits uniquement par la fonction SQL de calcul (migration 0002)
create table kpi_daily (
  day          date not null,
  kpi_key      text not null,
  value        numeric,
  source       dataset_type,
  computed_at  timestamptz not null default now(),
  primary key (day, kpi_key)
);

create table brand_docs (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  title       text not null,
  file_path   text not null,
  verified    boolean not null default false,   -- seul un doc vérifié est lu par les dirigeants
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- boucle exécutive
create table events (
  id          uuid primary key default gen_random_uuid(),
  type        event_type not null,
  payload     jsonb not null default '{}'::jsonb,
  routed_to   executive_key[] not null default '{}',
  status      event_status not null default 'pending',
  created_by  uuid references profiles (id),
  created_at  timestamptz not null default now()
);

create table agent_runs (
  id              uuid primary key default gen_random_uuid(),
  executive       executive_key not null references executives (key),
  event_id        uuid references events (id),
  kind            run_kind not null default 'analysis',
  status          run_status not null default 'queued',
  locale          ui_locale not null default 'fr',
  input           jsonb not null default '{}'::jsonb,
  transcript      jsonb not null default '[]'::jsonb,   -- chaque appel d'outil et sa réponse
  output          jsonb,                                -- sortie finale validée par schéma
  error           text,
  model           text,
  prompt_version  text,
  input_tokens    integer,
  output_tokens   integer,
  cost_usd        numeric(10, 4),
  attempt         smallint not null default 1,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table findings (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references agent_runs (id),
  executive   executive_key not null references executives (key),
  title       text not null,
  body        text not null,
  severity    finding_severity not null default 'info',
  confidence  numeric check (confidence between 0 and 1),
  evidence    jsonb not null,     -- [{table, ids[], query_name, params}]
  kpi_keys    text[] not null default '{}',
  created_at  timestamptz not null default now(),
  constraint evidence_required check (jsonb_array_length(evidence) > 0)
);

create table decisions (
  id                 uuid primary key default gen_random_uuid(),
  proposed_by        executive_key not null references executives (key),
  run_id             uuid not null references agent_runs (id),
  title              text not null,
  rationale          text not null,
  options            jsonb not null,           -- [{key, label, impact, risk}]
  recommended_option text not null,
  finding_ids        uuid[] not null default '{}',
  reviews            jsonb not null default '[]'::jsonb,  -- [{reviewer, scores, position, run_id}]
  arbitration        jsonb,                    -- position du CEO en cas de désaccord
  status             decision_status not null default 'proposed',
  chosen_option      text,
  decided_by         uuid references profiles (id),
  decided_at         timestamptz,
  decision_note      text,                     -- raison obligatoire en cas de rejet
  supersedes         uuid references decisions (id),
  created_at         timestamptz not null default now(),
  constraint rejection_needs_reason
    check (status <> 'rejected' or coalesce(length(decision_note), 0) > 0)
);

alter table content_items
  add constraint content_items_decision_fk foreign key (decision_id) references decisions (id);

create table tasks (
  id              uuid primary key default gen_random_uuid(),
  decision_id     uuid not null references decisions (id),
  owner_profile   uuid references profiles (id),
  owner_executive executive_key references executives (key),
  title           text not null,
  due_on          date,
  status          task_status not null default 'todo',
  created_at      timestamptz not null default now(),
  constraint one_owner check ((owner_profile is null) <> (owner_executive is null))
);

create table experiments (
  id             uuid primary key default gen_random_uuid(),
  owner          executive_key not null references executives (key),
  hypothesis     text not null,
  variants       jsonb not null,
  success_metric text not null,
  starts_on      date,
  ends_on        date,
  status         experiment_status not null default 'planned',
  result         jsonb,
  learnings      text,
  decision_id    uuid references decisions (id),
  created_at     timestamptz not null default now()
);

-- File de jobs du worker : une table, un bail, des essais
create table jobs (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references agent_runs (id) on delete cascade,
  status       job_status not null default 'queued',
  lease_until  timestamptz,
  attempts     smallint not null default 0,
  max_attempts smallint not null default 2,
  created_at   timestamptz not null default now()
);
create index jobs_queue_idx on jobs (status, created_at) where status = 'queued';

-- Le worker réclame un job sans collision entre processus
create or replace function claim_job(lease_seconds integer default 600)
returns jobs language plpgsql as $$
declare j jobs;
begin
  update jobs set status = 'leased',
                  lease_until = now() + make_interval(secs => lease_seconds),
                  attempts = attempts + 1
  where id = (
    select id from jobs
    where status = 'queued'
       or (status = 'leased' and lease_until < now() and attempts < max_attempts)
    order by created_at
    for update skip locked
    limit 1
  )
  returning * into j;
  return j;
end $$;

-- ---------------------------------------------------------------- garanties de code
-- Seul un compte fondateur fait passer une décision en approuvée, rejetée ou révoquée.
create or replace function guard_decision_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'rejected', 'revoked') then
    if current_app_role() is distinct from 'founder' then
      raise exception 'decision % : seul le fondateur peut passer en %', new.id, new.status;
    end if;
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;
  return new;
end $$;

create trigger decisions_guard before update on decisions
  for each row execute function guard_decision_status();

-- ---------------------------------------------------------------- audit
create table audit_log (
  id          bigint generated always as identity primary key,
  actor       uuid,             -- profil humain, null pour le worker
  actor_label text not null,    -- 'founder', 'operator', 'worker:cfo'...
  action      text not null,
  table_name  text not null,
  row_id      text not null,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);

create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare label text;
begin
  label := coalesce(current_app_role()::text, current_setting('app.actor', true), 'system');
  insert into audit_log (actor, actor_label, action, table_name, row_id, before, after)
  values (auth.uid(), label, tg_op, tg_table_name,
          coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id'), (to_jsonb(new) ->> 'key')),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_executives after insert or update or delete on executives for each row execute function write_audit();
create trigger audit_decisions  after insert or update or delete on decisions  for each row execute function write_audit();
create trigger audit_tasks      after insert or update or delete on tasks      for each row execute function write_audit();
create trigger audit_content    after insert or update or delete on content_items for each row execute function write_audit();
create trigger audit_datasets   after insert or update or delete on datasets   for each row execute function write_audit();
create trigger audit_brand_docs after insert or update or delete on brand_docs for each row execute function write_audit();

-- ---------------------------------------------------------------- RLS
-- Les humains lisent tout ; les écritures humaines passent par des rôles précis.
-- Le worker utilise la clé service, qui contourne RLS, et ne passe jamais par le navigateur.
do $$
declare t text;
begin
  foreach t in array array['profiles','executives','datasets','instagram_account_daily','content_items',
    'content_metrics','orders','ad_spend_daily','kpi_daily','brand_docs','events','agent_runs',
    'findings','decisions','tasks','experiments','jobs','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (current_app_role() is not null)',
                   t || '_read', t);
  end loop;
end $$;

create policy decisions_founder_update on decisions for update to authenticated
  using (current_app_role() = 'founder') with check (current_app_role() = 'founder');
create policy decisions_operator_defer on decisions for update to authenticated
  using (current_app_role() = 'operator') with check (status in ('proposed', 'in_review', 'deferred'));
create policy tasks_humans_update on tasks for update to authenticated
  using (current_app_role() is not null);
create policy events_humans_insert on events for insert to authenticated
  with check (type = 'question' and created_by = auth.uid());
create policy content_operator_write on content_items for update to authenticated
  using (current_app_role() = 'operator');
create policy executives_operator_update on executives for update to authenticated
  using (current_app_role() = 'operator');
create policy brand_docs_operator_write on brand_docs for all to authenticated
  using (current_app_role() = 'operator') with check (current_app_role() = 'operator');
create policy profiles_self_locale on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = current_app_role());

-- Datasets et tables sources : écrits par les routes API serveur (clé service) après validation.
-- kpi_daily : écrit uniquement par compute_kpis() (migration 0002).

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

-- Aloufa Executive OS, migration 0004 : cycle de vie des runs
-- Un événement en attente devient un run par dirigeant actif routé, chacun avec son job.
-- Le worker (apps/web, route /api/worker/tick) réclame les jobs avec claim_job().

alter table agent_runs add column if not exists parent_run_id uuid references agent_runs (id);
alter table agent_runs add column if not exists decision_id uuid references decisions (id);
create index if not exists agent_runs_event_idx on agent_runs (event_id);
create index if not exists agent_runs_created_idx on agent_runs (created_at);

-- Crée un run et son job. Point d'entrée unique pour mettre du travail en file.
create or replace function enqueue_run(
  p_executive executive_key, p_kind run_kind, p_event uuid, p_input jsonb,
  p_locale ui_locale default 'fr', p_parent uuid default null, p_decision uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  insert into agent_runs (executive, event_id, kind, status, locale, input, parent_run_id, decision_id)
  values (p_executive, p_event, p_kind, 'queued', p_locale, coalesce(p_input, '{}'::jsonb), p_parent, p_decision)
  returning id into v_run;
  insert into jobs (run_id) values (v_run);
  return v_run;
end $$;

-- Langue des sorties : celle du premier compte fondateur, sinon le français
create or replace function output_locale() returns ui_locale
language sql stable security definer set search_path = public as $$
  select coalesce((select locale from profiles where role = 'founder' order by created_at limit 1), 'fr'::ui_locale)
$$;

-- Transforme les événements en attente en runs. Idempotent : un événement n'est routé qu'une fois.
create or replace function route_pending_events() returns integer
language plpgsql security definer set search_path = public as $$
declare e events; k executive_key; n integer := 0; m integer; v_kind run_kind;
begin
  for e in select * from events where status = 'pending' order by created_at for update skip locked loop
    m := 0;
    v_kind := case e.type when 'question' then 'answer'::run_kind else 'analysis'::run_kind end;
    foreach k in array e.routed_to loop
      if exists (select 1 from executives where key = k and status = 'active') then
        perform enqueue_run(k, v_kind, e.id, e.payload, output_locale());
        m := m + 1;
      end if;
    end loop;
    -- aucun dirigeant actif concerné : l'événement est clos, rien à faire
    update events set status = case when m = 0 then 'done'::event_status else 'routed'::event_status end where id = e.id;
    n := n + m;
  end loop;
  return n;
end $$;

-- Événement du lundi : routé vers les dirigeants d'analyse actifs. Le CEO passe après eux (voir le worker).
create or replace function create_weekly_event() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_week date := date_trunc('week', local_day(now()))::date;
begin
  if exists (select 1 from events where type = 'weekly_tick' and payload->>'week' = v_week::text) then
    return null; -- déjà créé cette semaine : le cron peut se déclencher deux fois sans doublon
  end if;
  insert into events (type, payload, routed_to)
  values ('weekly_tick', jsonb_build_object('week', v_week, 'from', v_week - 7, 'to', v_week - 1),
          coalesce((select array_agg(key order by key) from executives where status = 'active' and key in ('cfo', 'cmo', 'creative_director')), '{}'))
  returning id into v_id;
  return v_id;
end $$;

-- Dépense des 7 derniers jours, pour le plafond hebdomadaire
create or replace function spend_last_7_days() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0) from agent_runs where created_at > now() - interval '7 days'
$$;

revoke execute on function enqueue_run(executive_key, run_kind, uuid, jsonb, ui_locale, uuid, uuid) from public, authenticated, anon;
revoke execute on function route_pending_events() from public, authenticated, anon;
revoke execute on function create_weekly_event() from public, authenticated, anon;

-- Vérification : doit afficher 6 dirigeants, CEO actif, les autres dormants
select key, status from executives order by key;
