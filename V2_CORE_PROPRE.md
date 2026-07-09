# V2 Core propre — séparation réelle des streamers

Ce correctif commence la refonte propre du cœur multi-streamer.

## Ce qui est isolé maintenant

- Dashboard stats : points, viewers, temps regardé, top viewer.
- Classement viewers.
- Logs de points.
- Activité chat hebdomadaire.
- Usage des commandes.
- Commandes personnalisées.
- Sessions live.
- Follow info liée aux viewers.

## Principe

Toutes les fonctions critiques de `database.js` résolvent maintenant le streamer actif via le `TenantContext`.

Exemple :

- `/s/elboy78/dashboard` lit `streamer_id = elboy78`.
- `/s/fack7up/dashboard` lit `streamer_id = fack7up`.

Les anciennes données globales sont rattachées automatiquement au streamer par défaut lors de l'initialisation.

## Important

Les modules plus anciens comme certains jeux/coffres/anciens systèmes peuvent encore nécessiter une migration dédiée plus tard, mais le cœur visible du dashboard et du classement ne doit plus afficher les données d'un autre streamer.
