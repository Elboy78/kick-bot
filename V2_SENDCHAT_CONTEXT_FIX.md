# V2 SendChat Context Fix

Corrige l'envoi des réponses du bot dans la mauvaise chaîne.

Avant : le bot recevait bien `[CHAT:elboy78]`, mais `sendChat()` utilisait un contexte global déjà réinitialisé et envoyait parfois dans `fack7up`.

Maintenant : chaque message/commande garde son contexte streamer via `AsyncLocalStorage`, donc `sendChat()` répond dans la même chatroom que celle qui a déclenché la commande.
