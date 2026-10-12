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
