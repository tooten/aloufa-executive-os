# Aloufa Executive OS

Cockpit de direction pour Aloufa Foods : des dirigeants IA (CEO, CMO, Creative Director, CFO) analysent de vraies données importées, proposent des décisions avec leurs preuves, et le fondateur tranche.

Architecture produit : voir le document « Aloufa Executive OS : architecture produit ».

## Structure

- `apps/web` : dashboard Next.js (Vercel), français et anglais
- `apps/worker` : worker des dirigeants (Node TypeScript, API Claude avec tool use)
- `packages/db` : migrations SQL Supabase et tests des garanties
- `packages/agents` : rôles, outils, schémas de sortie, grilles de revue
- `packages/ui` : système de design

## État

Phase 0 en cours. `packages/db/migrations/0001_core_schema.sql` pose le modèle d'objets. Les garanties testées dans `packages/db/tests/0001_guarantees.sql` sont les suivantes :

- seul le fondateur approuve une décision ;
- un rejet exige une raison ;
- un constat exige une preuve ;
- un contenu publié exige son identifiant Instagram ;
- un job de la file ne peut être réclamé qu'une fois ;
- chaque action est journalisée.

## Secrets

Aucune clé dans ce dépôt. Les variables Supabase et Anthropic se configurent dans Vercel et dans l'hébergeur du worker.
