// Module partagé entre bot.js et panel.js
// Évite les imports circulaires et les re-démarrages de WebSocket

let _sendChat = null;
let _openChest = null;
let _markVictory = null;
let _kickEventHandler = null;
let _songRequestAdder = null;
let _songRequestSkipVoter = null;
let _chatOverlayEmitter = null;
let _memeTrigger = null;
let _announcementReloader = null;
let _moderateUser = null;

module.exports = {
  registerSendChat(fn) { _sendChat = fn; },
  sendChat(msg) {
    if (_sendChat) return _sendChat(msg);
    console.warn('[SHARED] sendChat appelé avant enregistrement');
    return Promise.resolve(false);
  },
  hasSendChat() { return typeof _sendChat === 'function'; },
  sendChatTo(msg, ctx = null) {
    if (_sendChat) return _sendChat(msg, ctx);
    return Promise.resolve(false);
  },

  registerKickEventHandler(fn) { _kickEventHandler = fn; },
  processKickEvent(eventType, payload) {
    if (_kickEventHandler) return _kickEventHandler(eventType, payload);
    return Promise.resolve(false);
  },

  registerSongRequestAdder(fn) { _songRequestAdder = fn; },
  addSongRequest(username, song, ctx = null) {
    if (_songRequestAdder) return _songRequestAdder(username, song, ctx);
    return Promise.resolve({ error: 'Song Request pas encore initialisé.' });
  },

  registerSongRequestSkipVoter(fn) { _songRequestSkipVoter = fn; },
  voteSongRequestSkip(username, ctx = null) {
    if (_songRequestSkipVoter) return _songRequestSkipVoter(username, ctx);
    return Promise.resolve({ error: 'Vote skip pas encore initialisé.' });
  },

  registerChatOverlayEmitter(fn) { _chatOverlayEmitter = fn; },
  emitChatOverlayMessage(message, ctx = null) {
    if (_chatOverlayEmitter) return _chatOverlayEmitter(message, ctx);
    return Promise.resolve(false);
  },

  registerMemeTrigger(fn) { _memeTrigger = fn; },
  triggerMeme(username, meme, text = '', ctx = null) {
    if (_memeTrigger) return _memeTrigger(username, meme, text, ctx);
    return Promise.resolve({ error: 'Module Memes pas encore initialisé.' });
  },

  registerAnnouncementReloader(fn) { _announcementReloader = fn; },
  reloadAnnouncements() {
    if (_announcementReloader) return _announcementReloader();
    return Promise.resolve(false);
  },

  registerModerateUser(fn) { _moderateUser = fn; },
  moderateUser(username, kickId, action, duration, reason, ctx = null) {
    if (_moderateUser) return _moderateUser(username, kickId, action, duration, reason, ctx);
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
