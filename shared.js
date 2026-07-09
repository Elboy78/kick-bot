// Module partagé entre bot.js et panel.js
// Évite les imports circulaires et les re-démarrages de WebSocket

let _sendChat = null;
let _openChest = null;
let _markVictory = null;
let _kickEventHandler = null;
let _songRequestAdder = null;
let _chatOverlayEmitter = null;

module.exports = {
  registerSendChat(fn) { _sendChat = fn; },
  sendChat(msg) {
    if (_sendChat) return _sendChat(msg);
    console.warn('[SHARED] sendChat appelé avant enregistrement');
    return Promise.resolve(false);
  },
  hasSendChat() { return typeof _sendChat === 'function'; },

  registerKickEventHandler(fn) { _kickEventHandler = fn; },
  processKickEvent(eventType, payload) {
    if (_kickEventHandler) return _kickEventHandler(eventType, payload);
    return Promise.resolve(false);
  },

  registerSongRequestAdder(fn) { _songRequestAdder = fn; },
  addSongRequest(username, song) {
    if (_songRequestAdder) return _songRequestAdder(username, song);
    return Promise.resolve({ error: 'Song Request pas encore initialisé.' });
  },

  registerChatOverlayEmitter(fn) { _chatOverlayEmitter = fn; },
  emitChatOverlayMessage(message) {
    if (_chatOverlayEmitter) return _chatOverlayEmitter(message);
    return Promise.resolve(false);
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
