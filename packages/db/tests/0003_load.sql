\set ON_ERROR_STOP 1
-- 1. Premier import de commandes : le CFO dormant se réveille et reçoit l'événement
insert into datasets (id, type, file_path, status) values ('e0000000-0000-0000-0000-000000000001','woocommerce_orders','t/a.csv','validated');
select load_dataset('e0000000-0000-0000-0000-000000000001',
 '[{"external_id":"1","ordered_at":"2026-10-02T16:00:00Z","status":"completed","plan":"Standard","total":110,"customer_hash":"h1"},
   {"external_id":"2","ordered_at":"2026-10-03T16:00:00Z","status":"completed","plan":"Light","total":80,"customer_hash":"h2"}]') as ev \gset
select 'T1 event', type, routed_to, payload->>'rows' as lignes from events where id = :'ev';
select 'T1 cfo', status from executives where key='cfo';
select 'T1 dataset', status, row_count, period_start, period_end from datasets where id='e0000000-0000-0000-0000-000000000001';
-- 2. Réimport : la commande 2 change de statut, pas de doublon
insert into datasets (id, type, file_path, status) values ('e0000000-0000-0000-0000-000000000002','woocommerce_orders','t/b.csv','validated');
select load_dataset('e0000000-0000-0000-0000-000000000002', '[{"external_id":"2","ordered_at":"2026-10-03T16:00:00Z","status":"refunded","plan":"Light","total":80,"customer_hash":"h2"}]') is not null as t2;
select 'T2 commandes', count(*), string_agg(status, ',' order by external_id) from orders;
-- 3. Recharger un dataset déjà chargé est refusé
\set ON_ERROR_STOP 0
select load_dataset('e0000000-0000-0000-0000-000000000002', '[]');
-- 4. Une ligne invalide annule tout l'import
insert into datasets (id, type, file_path, status) values ('e0000000-0000-0000-0000-000000000003','woocommerce_orders','t/c.csv','validated');
select load_dataset('e0000000-0000-0000-0000-000000000003', '[{"external_id":"9","ordered_at":"2026-10-04T16:00:00Z","status":"completed","total":10,"customer_hash":"h9"},{"external_id":"10","ordered_at":"pas une date","status":"completed","total":10,"customer_hash":"h9"}]');
\set ON_ERROR_STOP 1
select 'T4 aucune trace', count(*) filter (where external_id='9') as cmd9, (select status from datasets where id='e0000000-0000-0000-0000-000000000003') from orders;
-- 5. Publications : contenu créé puis instantané de métriques, KPI calculé
insert into datasets (id, type, file_path, status) values ('e0000000-0000-0000-0000-000000000004','instagram_media','t/m.csv','validated');
select load_dataset('e0000000-0000-0000-0000-000000000004', '[{"ig_media_id":"m1","format":"reel","published_at":"2026-10-09T14:00:00Z","views":900,"reach":800,"saved":40,"shares":8,"avg_watch_time_s":7.5,"skip_rate":0.41}]', '2026-10-11T12:00:00Z') is not null as t5;
select 'T5', c.status, c.format, m.reach from content_items c join content_metrics m on m.content_id=c.id;
select 'T5 kpi', kpi_key, round(value,3) from kpi_daily where day='2026-10-11' and kpi_key in ('save_rate_7d','revenue_7d','orders_7d') order by 2;
select 'T5 activés', string_agg(key::text, ',' order by key) from executives where status='active';
