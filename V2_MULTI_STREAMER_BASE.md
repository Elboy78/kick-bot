# V2 Multi-streamer — Base installée

Cette mise à jour pose le socle multi-streamer sans casser le fonctionnement actuel du bot.

## Ajouté

- Table `streamers`
- Table `streamer_members`
- Table `streamer_settings`
- Streamer par défaut basé sur `DEFAULT_STREAMER_SLUG` ou `KICK_CHANNEL`
- Résolution du streamer via :
  - `?streamer=slug`
  - header `x-streamer-slug`
  - routes publiques `/s/:streamer/...`
- OAuth Kick préparé par streamer
- Endpoints V2 :
  - `/api/v2/streamers/current`
  - `/api/v2/streamers`
  - `/api/v2/admin/streamers`
  - `/api/v2/obs-links`
- URLs OBS V2 :
  - `/s/:streamer/classement`
  - `/s/:streamer/widgets/alerts.html`
  - `/s/:streamer/widgets/chat.html`
  - `/s/:streamer/widgets/songrequest.html`
  - `/s/:streamer/widgets/subgoal.html`

## Important

Cette phase est volontairement une base d'architecture. Les données existantes restent compatibles V1 et continuent de fonctionner.

La phase suivante devra migrer progressivement les données existantes vers `streamer_id` pour isoler complètement les commandes, widgets, alertes, classements et song requests de chaque streamer.

## Variables utiles

Optionnel :

```env
DEFAULT_STREAMER_SLUG=elboy78
```

Si absent, le bot utilise `KICK_CHANNEL` comme streamer principal.
