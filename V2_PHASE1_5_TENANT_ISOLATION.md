# V2 Phase 1.5 — Isolation réelle widgets/API

Cette phase corrige le problème où `/s/nimportequi/widgets/songrequest.html` affichait encore les données du streamer par défaut.

## Ajouté

- Résolution du streamer depuis :
  - `/s/:streamer/...`
  - `?streamer=...`
  - header `x-streamer-slug`
  - cookie `streamer`
- Injection automatique de `window.__STREAMER_SLUG__` dans les pages publiques V2.
- Les widgets appellent maintenant les API avec `?streamer=<slug>`.
- Les sockets rejoignent une room par streamer : `streamer:<slug>`.
- Les événements temps réel ne sont plus broadcast à tout le monde, ils partent dans la room du streamer courant.
- Alias ajouté : `/api/v2/tenant/current`.

## Test rapide

1. Ouvre :
   `/api/v2/tenant/current?streamer=fack7up`

2. Ouvre :
   `/api/v2/tenant/current?streamer=test`

Les deux doivent renvoyer deux tenants différents si le streamer `test` existe, sinon le default reste utilisé.

3. Pour tester deux widgets séparés :
   `/s/fack7up/widgets/songrequest.html`
   `/s/test/widgets/songrequest.html`

Le widget ajoute désormais `?streamer=<slug>` aux appels API et aux sockets.

## Important

Si un streamer n'existe pas encore dans la table `streamers`, le système retombe volontairement sur le streamer par défaut pour éviter de casser le panel.
