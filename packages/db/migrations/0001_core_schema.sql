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
