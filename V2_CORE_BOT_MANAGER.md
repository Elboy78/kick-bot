# V2 Core BotManager — séparation streamer / bot / chaîne

Ce correctif met en place la base propre pour un service multi-streamer :

- Le streamer se connecte avec Kick pour créer son espace et ses données.
- Le compte BOT7UP se connecte séparément via `/auth/bot/login` et sert uniquement à écrire dans les chats.
- Chaque streamer stocke ses identifiants de chaîne (`channel_id`, `chatroom_id`, `broadcaster_user_id`).
- Le navigateur du streamer synchronise automatiquement le `chatroom_id` depuis Kick quand il ouvre son panel `/s/<pseudo>/dashboard`.
- Le bot charge les streamers actifs et s'abonne aux chatrooms connues.

## Test attendu

1. Connecter le compte bot : `/auth/bot/login`.
2. Connecter le streamer : `/auth/login`.
3. Ouvrir `/s/elboy78/dashboard` une fois pour synchroniser le chatroom_id.
4. Regarder `/api/v2/core/status` : `elboy78` doit avoir un `chatroom_id`.
5. Render doit afficher : `[BOT V2] Channels actifs: elboy78#...`.
6. Dans le chat Kick : `[CHAT:elboy78] pseudo: !commande`.

BOT7UP doit être modérateur sur chaque chaîne où il répond.
