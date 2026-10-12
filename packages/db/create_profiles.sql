-- À lancer après avoir créé les comptes dans Supabase > Authentication > Users > Add user.
-- Remplace les deux adresses e-mail. Le rôle operator importe les données, le rôle founder tranche les décisions.
insert into profiles (id, display_name, role, locale)
select id, 'Chris', 'operator', 'fr' from auth.users where email = 'ADRESSE_DE_CHRIS'
on conflict (id) do update set role = excluded.role;

-- Compte fondateur : à lancer quand son compte existe. Sa langue fixe celle des analyses (fr ou en).
-- insert into profiles (id, display_name, role, locale)
-- select id, 'Fondatrice', 'founder', 'en' from auth.users where email = 'ADRESSE_DU_FONDATEUR'
-- on conflict (id) do update set role = excluded.role;

select p.display_name, p.role, u.email from profiles p join auth.users u on u.id = p.id;
