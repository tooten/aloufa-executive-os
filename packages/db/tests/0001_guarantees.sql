\set ON_ERROR_STOP 0
insert into auth.users values ('00000000-0000-0000-0000-00000000000f'), ('00000000-0000-0000-0000-00000000000a');
insert into profiles values ('00000000-0000-0000-0000-00000000000f','Fondateur','founder','en'), ('00000000-0000-0000-0000-00000000000a','Chris','operator','fr');
insert into executives (key,name,mission,status) values ('ceo','CEO','Brief','active'),('cfo','CFO','Revenu','active');
insert into agent_runs (id, executive) values ('11111111-1111-1111-1111-111111111111','cfo');
insert into decisions (id, proposed_by, run_id, title, rationale, options, recommended_option)
  values ('22222222-2222-2222-2222-222222222222','cfo','11111111-1111-1111-1111-111111111111','Test','r','[]','a');
-- 1. opérateur tente d'approuver : doit échouer
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a', false);
update decisions set status='approved' where id='22222222-2222-2222-2222-222222222222';
-- 2. fondateur rejette sans raison : doit échouer
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000f', false);
update decisions set status='rejected' where id='22222222-2222-2222-2222-222222222222';
-- 3. fondateur approuve : doit passer, decided_by renseigné
update decisions set status='approved', chosen_option='a' where id='22222222-2222-2222-2222-222222222222';
select 'T3', status, decided_by is not null as signed from decisions;
-- 4. constat sans preuve : doit échouer
insert into findings (run_id, executive, title, body, evidence) values ('11111111-1111-1111-1111-111111111111','cfo','x','y','[]');
-- 5. contenu publié sans ig_media_id : doit échouer
insert into content_items (format, status) values ('reel','published');
-- 6. file de jobs
insert into jobs (run_id) values ('11111111-1111-1111-1111-111111111111');
select 'T6', id, status, attempts from claim_job();
select 'T6b', (claim_job()).id is null as queue_empty;
-- 7. audit
select 'T7', count(*) from audit_log where table_name='decisions';
