# V2 BotManager — chatrooms depuis la base

Ce correctif force le bot à utiliser uniquement les streamers actifs stockés en base avec `chatroom_id`.

Changements :
- plus de fallback automatique vers `KICK_CHANNEL` / `KICK_CHANNEL_ID` ;
- le bot ignore les streamers sans `chatroom_id` au lieu d'essayer de résoudre par pseudo ;
- abonnement direct aux rooms Pusher `chatrooms.<chatroom_id>.v2` ;
- reset des subscriptions en cas de reconnexion WebSocket ;
- logs plus clairs : `Channels actifs via DB: elboy78#433823`.

Après redéploiement, le log attendu est :
`[BOT V2] Channels actifs via DB: elboy78#433823`
`[BOT] Abonné: chatrooms.433823.v2`
`[CHAT:elboy78] ...`
