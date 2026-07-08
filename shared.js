// Module partagé entre bot.js et panel.js
// Évite les imports circulaires et les re-démarrages de WebSocket

let _sendChat = null;
let _openChest = null;
let _markVictory = null;

module.exports = {
  registerSendChat(fn) { _sendChat = fn; },
  sendChat(msg) {
    if (_sendChat) return _sendChat(msg);
    console.warn('[SHARED] sendChat appelé avant enregistrement');
  },

  registerOpenChest(fn) { _openChest = fn; },
  openChest(number) {
    if (_openChest) return _openChest(number);
    return { error: 'Système de coffres pas encore initialisé.' };
  },

  registerMarkVictory(fn) { _markVictory = fn; },
  markVictory() {
    if (_markVictory) return _markVictory();
    return { error: 'Système de coffres pas encore initialisé.' };
  },
};
