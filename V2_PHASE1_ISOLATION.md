# V2 — Phase 1 : isolation multi-streamer

Cette phase ajoute la base d'isolation par streamer sans casser le fonctionnement actuel.

## Ce qui est isolé maintenant

- Réglages généraux du bot via `streamer_settings`
- Réglages widgets stockés avec `db.getSettingStr/setSettingStr`
- Commandes personnalisées via `streamer_custom_commands`
- Activation/désactivation des commandes système via `streamer_system_commands_state`
- URLs publiques V2 par streamer : `/s/:streamer/...`

## Compatibilité V1

- Le streamer par défaut récupère automatiquement les anciennes données V1 au premier démarrage.
- Si aucune session streamer n'est résolue, le bot continue d'utiliser le fonctionnement V1.

## Important pour la suite

Les prochaines phases devront isoler progressivement les gros modules métiers :

- viewers / classement
- points / logs
- song request queue
- alertes
- coffres
- TTS

La base de contexte par streamer est maintenant prête pour faire ces migrations module par module.
