// Module partagé entre bot.js et panel.js
// Évite les imports circulaires et les re-démarrages de WebSocket

let _sendChat = null;

module.exports = {
  registerSendChat(fn) { _sendChat = fn; },
  sendChat(msg) {
    if (_sendChat) return _sendChat(msg);
    console.warn('[SHARED] sendChat appelé avant enregistrement');
  },
};
