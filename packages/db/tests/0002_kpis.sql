-- Jeu d'essai fictif, résultats attendus calculés à la main en commentaire
\set ON_ERROR_STOP 1
insert into datasets (id, type, file_path, status) values
 ('d0000000-0000-0000-0000-000000000001','woocommerce_orders','test/orders.csv','uploaded'),
 ('d0000000-0000-0000-0000-000000000002','instagram_account','test/ig.csv','uploaded'),
 ('d0000000-0000-0000-0000-000000000003','instagram_media','test/media.csv','uploaded');
-- Semaine 1 (1 au 7 oct) : clients A, B. Semaine 2 (8 au 14 oct) : A revient, C nouveau, D annulé
insert into orders (external_id, ordered_at, status, plan, total, customer_hash, coupon, utm_source, dataset_id) values
 ('1','2026-10-02 12:00-04','completed','Standard',110,'A',null,null,'d0000000-0000-0000-0000-000000000001'),
 ('2','2026-10-03 12:00-04','completed','Light',80,'B',null,null,'d0000000-0000-0000-0000-000000000001'),
 ('3','2026-10-09 12:00-04','completed','Standard',110,'A',null,'instagram','d0000000-0000-0000-0000-000000000001'),
 ('4','2026-10-10 12:00-04','processing','Premium',150,'C','IG10',null,'d0000000-0000-0000-0000-000000000001'),
 ('5','2026-10-11 12:00-04','cancelled','Premium',150,'D',null,null,'d0000000-0000-0000-0000-000000000001'),
 ('6','2026-10-14 23:30-04','completed','Standard',110,'C',null,null,'d0000000-0000-0000-0000-000000000001');
insert into ad_spend_daily (day, campaign, spend, dataset_id) values ('2026-10-12','test',60,'d0000000-0000-0000-0000-000000000001');
insert into instagram_account_daily (day, reach, views, profile_visits, follows, unfollows, profile_links_taps, dataset_id)
select d, 100, 200, 10, 5, 2, 3, 'd0000000-0000-0000-0000-000000000002' from generate_series('2026-10-08'::date,'2026-10-14','1 day') d;
insert into content_items (id, ig_media_id, format, published_at, status) values
 ('c0000000-0000-0000-0000-000000000001','m1','reel','2026-10-09 10:00-04','published'),
 ('c0000000-0000-0000-0000-000000000002','m2','post','2026-10-12 10:00-04','published');
insert into content_metrics (content_id, captured_at, views, reach, saved, shares, avg_watch_time_s, skip_rate, dataset_id) values
 ('c0000000-0000-0000-0000-000000000001','2026-10-10 10:00-04',500,400,10,4,6.0,0.5,'d0000000-0000-0000-0000-000000000003'),
 ('c0000000-0000-0000-0000-000000000001','2026-10-14 10:00-04',900,800,30,10,7.0,0.4,'d0000000-0000-0000-0000-000000000003'),
 ('c0000000-0000-0000-0000-000000000002','2026-10-14 10:00-04',300,200,10,10,null,null,'d0000000-0000-0000-0000-000000000003');
update datasets set status='loaded', loaded_at=now();
select compute_kpis('2026-10-14','2026-10-14') as jours_calcules;
-- Attendu au 14 oct : revenue_7d 370 (110+150+110, l'annulée exclue), orders_7d 3, aov 123.33,
-- new_customers_7d 1 (C), retention_w 0.5 (A revient sur A,B), cac_7d 60, attributed_orders_7d 2 (utm + coupon),
-- plan_mix Standard 0.667 Premium 0.333, views_7d 1400, follows_net_7d 21, link_taps_7d 21,
-- save_rate_7d 40/1000 = 0.04, share_rate_7d 20/1000 = 0.02, watch_time 7.0, skip 0.4, posts 2
select kpi_key, round(value, 3) from kpi_daily where day='2026-10-14' order by kpi_key;
select key, status from executives order by key;
