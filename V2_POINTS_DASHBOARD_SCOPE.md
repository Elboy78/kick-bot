# V2 – Points / Classement / Dashboard scopés par streamer

Correctif appliqué :

- migration réelle de `viewers` vers `UNIQUE(streamer_id, username)` ;
- migration de `points_log` avec `streamer_id` ;
- `!rang`, `!points`, `!top`, dashboard, logs récents et viewers actifs lisent maintenant le streamer courant ;
- le contexte chat du BotManager alimente aussi le contexte tenant de `database.js`.

Résultat attendu :

- une commande écrite sur `elboy78` répond avec les points/rang de `elboy78` ;
- une commande écrite sur `fack7up` répond avec les points/rang de `fack7up` ;
- le même pseudo peut exister sur plusieurs chaînes sans conflit SQL.
