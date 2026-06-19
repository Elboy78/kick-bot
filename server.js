/**
 * server.js — Point d'entrée unique pour Render.
 * Démarre bot.js et panel.js dans LE MÊME process Node.js,
 * ce qui permet à shared.js de réellement partager sendChat/setIsLive
 * entre les deux modules (impossible avec deux process séparés via &).
 */

console.log('[SERVER] Démarrage unifié bot + panel...');

require('./panel.js');  // démarre le serveur Express (port 3000)
require('./bot.js');    // démarre le bot Kick (WebSocket + tracker de points)

console.log('[SERVER] bot.js et panel.js chargés dans le même process ✓');
