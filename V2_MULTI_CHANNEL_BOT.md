# Correctif V2 — Bot multi-chaînes

Ce correctif sépare correctement :

- le compte BOT7UP qui parle dans le chat ;
- les streamers connectés au panel ;
- les chaînes Kick que le bot doit écouter.

## Ce que fait le correctif

- Charge automatiquement les streamers actifs depuis la table `streamers`.
- Récupère pour chaque streamer le `chatroom_id`, `channel_id` et `broadcaster_user_id` Kick.
- S'abonne au WebSocket Kick de chaque chaîne : `chatrooms.<id>.v2`.
- Traite chaque message dans le tenant du streamer concerné.
- Les commandes, points, Song Request et chat overlay utilisent donc les données du streamer où le message a été envoyé.
- Les messages envoyés par le bot utilisent toujours le compte BOT7UP, jamais le compte streamer.

## Important

Le compte BOT7UP doit être modérateur sur chaque chaîne où il doit écrire.

Après redéploiement, dans les logs Render tu dois voir des lignes du type :

`[BOT V2] Streamer actif: elboy78 | chatroom=... | channel=... | broadcaster=...`

Puis quand quelqu'un parle :

`[CHAT:elboy78] pseudo: !commande`

