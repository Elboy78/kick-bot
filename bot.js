/**
 * bot.js — Bot Kick avec Turso (async DB)
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios    = require('axios');
const db       = require('./database');
const kickOAuth = require('./kick-oauth');

const CONFIG = {
  channel:      process.env.KICK_CHANNEL       || 'votre_chaine',
  channelId:    process.env.KICK_CHANNEL_ID    || '0',
  token:        process.env.KICK_TOKEN         || '',
  botUsername:  process.env.BOT_USERNAME       || 'bot',
  pointsAmount: parseInt(process.env.POINTS_PER_INTERVAL || '10'),
  intervalMs:   parseInt(process.env.POINTS_INTERVAL_MS  || '300000'),
  debug:        process.env.DEBUG === 'true',
};

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.4.0&flash=false';
const SYSTEM_COMMANDS = ['!points','!top','!rang','!niveau','!aide','!duel','!accepter','!refuser','!participer','!giveaway','!lobby','!quote','!addquote','!mort','!death','!score','!queue','!join','!leave','!pos','!vote','!sondage','!so','!uptime','!dice','!des','!rps','!pfc'];

let ws             = null;
let reconnectDelay = 5000;
let pointsInterval = null;
let pingInterval   = null;
let isLive         = false;
let currentSessionId = null;
let sessionStart     = null;
let peakViewers      = 0;
const pendingDuelTimeouts = {};
let announcementIntervals = {};
let streamStartTime = null;
let lastFollowerCount = 0;
let followerCheckInterval = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await db.ensureInit();
  await db.initSystemCommandsState(SYSTEM_COMMANDS);
  await startAnnouncements();
  // Vérifier live + followers toutes les 2 minutes
  setInterval(checkLiveStatus, 120000);
  console.log('[BOT] Base de données prête ✓');

  const oauthConfigured = kickOAuth.isConfigured();
  const oauthConnected  = oauthConfigured && await kickOAuth.isConnected();

  if (oauthConnected) {
    console.log('[AUTH] OAuth Kick officiel actif — refresh automatique activé ✓');
    db.setBotStatus('token_expired', '0').catch(()=>{});
    db.setBotStatus('bot_started_at', Date.now().toString()).catch(()=>{});
  } else if (!CONFIG.token) {
    console.warn('[AUTH] Aucun token — le bot ne peut pas envoyer de messages');
    if (oauthConfigured) console.warn('[AUTH] OAuth configuré mais pas encore connecté — va sur /auth/login');
    db.setBotStatus('token_expired', '1').catch(()=>{});
  } else {
    // Token manuel legacy présent — on suppose qu'il est valide jusqu'à preuve du contraire
    db.setBotStatus('token_expired', '0').catch(()=>{});
    db.setBotStatus('bot_started_at', Date.now().toString()).catch(()=>{});
  }

  // Vérifier état live initial
  await checkLiveStatus();
  connect();
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  console.log('[BOT] Connexion au WebSocket Kick...');
  ws = new WebSocket(PUSHER_URL);

  ws.on('open', () => {
    console.log('[BOT] Connecté ✓');
    reconnectDelay = 5000;
    subscribe(`chatrooms.${CONFIG.channelId}.v2`);
    subscribe(`channel.${CONFIG.channelId}`);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, 25000);
    startPointsTracker();
  });

  ws.on('message', (raw) => {
    try { handleEvent(JSON.parse(raw.toString())); } catch(e) {}
  });

  ws.on('close', (code) => {
    console.log(`[BOT] Connexion fermée (${code}). Reconnexion dans ${reconnectDelay/1000}s...`);
    cleanup();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (err) => console.error('[BOT] Erreur WS:', err.message));
}

function subscribe(channel) {
  ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel } }));
  console.log(`[BOT] Abonné: ${channel}`);
}

function cleanup() {
  if (pingInterval)   { clearInterval(pingInterval);   pingInterval   = null; }
  if (pointsInterval) { clearInterval(pointsInterval); pointsInterval = null; }
  isLive = false;
}

// ─── Événements ───────────────────────────────────────────────────────────────

function handleEvent(msg) {
  const { event, data } = msg;

  switch(event) {
    case 'pusher:connection_established': console.log('[BOT] Handshake OK'); break;
    case 'pusher_internal:subscription_succeeded': console.log('[BOT] Subscription ✓'); break;

    case 'App\\Events\\ChatMessageEvent':
    case 'ChatMessageEvent': {
      let p; try { p = typeof data === 'string' ? JSON.parse(data) : data; } catch { break; }
      handleChatMessage(p);
      break;
    }

    case 'App\\Events\\StreamerIsLive': case 'StreamerIsLive':
    case 'App\\Events\\LivestreamUpdated': case 'LivestreamUpdated': {
      const wasLive = isLive; isLive = true;
      if (!wasLive) {
        console.log('[STREAM] Stream démarré — points activés !');
        streamStartTime = Date.now();
        if (!currentSessionId) startSession();
        startAnnouncements();
      }
      break;
    }

    case 'App\\Events\\StopStreamBroadcast': case 'StopStreamBroadcast':
    case 'App\\Events\\LivestreamCancelled': case 'LivestreamCancelled': {
      const wasLive = isLive; isLive = false;
      if (wasLive) {
        console.log('[STREAM] Stream terminé — points désactivés.');
        if (currentSessionId) {
          const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
          db.endSession(currentSessionId, peakViewers, dur);
          currentSessionId = null;
        }
      }
      break;
    }
  }
}

// ─── Messages chat ────────────────────────────────────────────────────────────

async function handleChatMessage(payload) {
  const username = payload?.sender?.username || payload?.user?.username || payload?.username;
  const content  = payload?.content || payload?.message || '';
  const kickId   = payload?.sender?.id?.toString() || null;
  if (!username || !content) return;

  await db.upsertViewer(username, kickId);
  console.log(`[CHAT] ${username}: ${content}`);

  // Vérifier les mots bannis
  if (await db.getSetting('moderation_enabled')) {
    const banned = await db.checkBannedWords(content);
    if (banned) {
      console.log(`[MODÉRATION] Mot banni: "${banned.word}" de ${username}`);
      await moderateUser(username, banned.action, banned.duration, banned.word);
      return;
    }
  }

  const parts = content.trim().split(' ');
  const cmd   = parts[0].toLowerCase();

  // Commandes système
  if (SYSTEM_COMMANDS.includes(cmd)) {
    const enabled = await db.isSystemCmdEnabled(cmd);
    if (!enabled) return;
    switch(cmd) {
      case '!points':    return cmdPoints(username);
      case '!top':       return cmdTop(username);
      case '!rang':      return cmdRang(username);
      case '!niveau':    return cmdNiveau(username);
      case '!aide':      return cmdAide(username);
      case '!duel':      return (await db.getSetting('duel_enabled')) ? cmdDuel(username, parts) : null;
      case '!accepter':  return cmdAccepter(username);
      case '!refuser':   return cmdRefuser(username);
      case '!participer':return (await db.getSetting('giveaway_enabled')) ? cmdParticiper(username) : null;
      case '!giveaway':  return (await db.getSetting('giveaway_enabled')) ? cmdGiveawayInfo(username) : null;
      case '!lobby':     return (await db.getSetting('lobby_enabled')) ? cmdLobby(username) : null;
      case '!quote':     return (await db.getSetting('quote_enabled')) ? cmdQuote(username, parts) : null;
      case '!addquote':  return (await db.getSetting('quote_enabled')) ? cmdAddQuote(username, parts) : null;
      case '!mort':
      case '!death':     return cmdCounter(username, parts, 'morts');
      case '!score':     return cmdCounter(username, parts, 'score');
      case '!compteur':  return cmdCounterInfo(username, parts);
      case '!queue':
      case '!join':      return (await db.getSetting('queue_enabled')) ? cmdJoinQueue(username) : null;
      case '!leave':     return (await db.getSetting('queue_enabled')) ? cmdLeaveQueue(username) : null;
      case '!pos':       return (await db.getSetting('queue_enabled')) ? cmdQueuePos(username) : null;
      case '!vote':      return (await db.getSetting('poll_enabled')) ? cmdVote(username, parts) : null;
      case '!sondage':   return (await db.getSetting('poll_enabled')) ? cmdPollInfo(username) : null;
      case '!so':        return (await db.getSetting('shoutout_enabled')) ? cmdShoutout(username, parts) : null;
      case '!uptime':    return (await db.getSetting('uptime_enabled')) ? cmdUptime(username) : null;
      case '!dice':
      case '!des':       return (await db.getSetting('dice_enabled')) ? cmdDice(username, parts) : null;
      case '!rps':
      case '!pfc':       return (await db.getSetting('dice_enabled')) ? cmdRPS(username, parts) : null;
      case '!followage': return cmdFollowage(username, parts);
    }
    return;
  }

  // Commandes personnalisées
  const custom = await db.getCustomCommand(cmd);
  if (custom) {
    const response = custom.response.replace(/@\{user\}/gi, '@' + username);
    return sendChat(response);
  }
}

// ─── Commandes ────────────────────────────────────────────────────────────────

async function cmdPoints(username) {
  const v = await db.getViewer(username);
  if (!v) return sendChat(`@${username} Tu n'as pas encore de points. Regarde le stream pour en gagner !`);
  const rank  = await db.getViewerRank(username);
  const level = db.getLevel(v.points);
  sendChat(`@${username} ${level.emoji} ${level.name} — ${v.points} pts (rang #${rank||'?'}) — ${formatMin(v.total_minutes)} regardées`);
}

async function cmdTop(username) {
  const top = await db.getLeaderboard(5);
  if (!top.length) return sendChat('Pas encore de classement disponible.');
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  sendChat(`Top viewers : ${top.map((v,i) => `${medals[i]} ${v.username} (${v.points} pts)`).join(' | ')}`);
}

async function cmdRang(username) {
  const rank = await db.getViewerRank(username);
  const v    = await db.getViewer(username);
  if (!rank || !v) return sendChat(`@${username} Aucune donnée. Regarde le stream pour gagner des points !`);
  sendChat(`@${username} Tu es #${rank} avec ${v.points} points 🎯`);
}

async function cmdNiveau(username) {
  const v = await db.getViewer(username);
  if (!v) return sendChat(`@${username} Tu n'as pas encore de points !`);
  const level = db.getLevel(v.points);
  const next  = db.getNextLevel(v.points);
  if (!next) return sendChat(`@${username} ${level.emoji} Niveau maximum : ${level.name} ! 👑`);
  sendChat(`@${username} ${level.emoji} Niveau ${level.name} — encore ${next.min - v.points} pts pour ${next.emoji} ${next.name}`);
}

async function cmdAide(username) {
  const customs = (await db.getCustomCommands()).map(c => c.trigger).join(' ');
  sendChat(`@${username} Commandes → !points !top !rang !niveau !duel !accepter !refuser !participer !giveaway !lobby !aide${customs ? ' | ' + customs : ''}`);
}

async function cmdLobby(username) {
  const already = (await db.getLobby()).find(v => v.username === username.toLowerCase());
  if (already) return sendChat(`@${username} Tu es déjà dans le lobby !`);
  await db.joinLobby(username);
  const count = (await db.getLobby()).length;
  sendChat(`@${username} Tu rejoins le lobby ! (${count} joueur${count>1?'s':''} inscrit${count>1?'s':''})`);
}

async function cmdDuel(challenger, parts) {
  const opponent = parts[1]?.replace('@','');
  const amount   = parseInt(parts[2]);
  if (!opponent || isNaN(amount) || amount <= 0)
    return sendChat(`@${challenger} Usage : !duel @pseudo montant`);
  if (opponent.toLowerCase() === challenger.toLowerCase())
    return sendChat(`@${challenger} Tu ne peux pas te défier toi-même !`);
  const vC = await db.getViewer(challenger);
  const vO = await db.getViewer(opponent);
  if (!vC || vC.points < amount) return sendChat(`@${challenger} Pas assez de points ! (tu as ${vC?.points||0} pts)`);
  if (!vO) return sendChat(`@${challenger} ${opponent} n'est pas encore enregistré.`);
  if (vO.points < amount) return sendChat(`@${challenger} ${opponent} n'a pas assez de points (${vO.points} pts)`);
  const duelId = await db.createDuel(challenger, opponent, amount);
  sendChat(`⚔️ @${opponent} tu es défié par @${challenger} pour ${amount} pts ! Tape !accepter ou !refuser (60s)`);
  pendingDuelTimeouts[duelId] = setTimeout(async () => {
    await db.cancelDuel(duelId);
    sendChat(`⏱ Duel entre @${challenger} et @${opponent} expiré.`);
    delete pendingDuelTimeouts[duelId];
  }, 60000);
}

async function cmdAccepter(username) {
  const duel = await db.getPendingDuel(username);
  if (!duel) return sendChat(`@${username} Aucun duel en attente.`);
  if (pendingDuelTimeouts[duel.id]) { clearTimeout(pendingDuelTimeouts[duel.id]); delete pendingDuelTimeouts[duel.id]; }
  const winner = Math.random() < 0.5 ? duel.challenger : duel.opponent;
  const loser  = winner === duel.challenger ? duel.opponent : duel.challenger;
  await db.resolveDuel(duel.id, winner);
  await db.addPoints(winner,  duel.amount, 'duel_win');
  await db.addPoints(loser,  -duel.amount, 'duel_loss');
  sendChat(`⚔️ @${winner} GAGNE ${duel.amount} pts face à @${loser} ! 🎉`);
}

async function cmdRefuser(username) {
  const duel = await db.getPendingDuel(username);
  if (!duel) return sendChat(`@${username} Aucun duel en attente.`);
  if (pendingDuelTimeouts[duel.id]) { clearTimeout(pendingDuelTimeouts[duel.id]); delete pendingDuelTimeouts[duel.id]; }
  await db.cancelDuel(duel.id);
  sendChat(`@${username} a refusé le duel de @${duel.challenger}.`);
}

async function cmdParticiper(username) {
  const g = await db.getActiveGiveaway();
  if (!g) return sendChat(`@${username} Aucun giveaway en cours.`);
  if (g.cost > 0) {
    const v = await db.getViewer(username);
    if (!v || v.points < g.cost) return sendChat(`@${username} Il faut ${g.cost} pts pour participer.`);
  }
  const joined = await db.joinGiveaway(g.id, username);
  if (!joined) return sendChat(`@${username} Tu es déjà inscrit !`);
  if (g.cost > 0) await db.addPoints(username, -g.cost, 'giveaway_entry');
  const entries = JSON.parse(g.entries).length + 1;
  sendChat(`@${username} Tu participes au giveaway "${g.title}" ! (${entries} participant${entries>1?'s':''})`);
}

async function cmdGiveawayInfo(username) {
  const g = await db.getActiveGiveaway();
  if (!g) return sendChat('Aucun giveaway en cours.');
  const entries = JSON.parse(g.entries).length;
  sendChat(`🎁 Giveaway : "${g.title}" — Lot : ${g.prize}${g.cost > 0 ? ` (${g.cost} pts)` : ' (gratuit)'} — ${entries} participant${entries>1?'s':''} — !participer`);
}

// ─── Quote ───────────────────────────────────────────────────────────────────

async function cmdQuote(username, parts) {
  if (parts[1] && !isNaN(parts[1])) {
    const quotes = await db.getQuotes();
    const q = quotes[parseInt(parts[1]) - 1];
    if (!q) return sendChat(`@${username} Citation #${parts[1]} introuvable.`);
    sendChat(`💬 #${parts[1]} "${q.text}" ${q.author ? '— ' + q.author : ''}`);
  } else {
    const q = await db.getRandomQuote();
    if (!q) return sendChat('Aucune citation enregistrée. Utilise !addquote pour en ajouter !');
    sendChat(`💬 "${q.text}" ${q.author ? '— ' + q.author : ''}`);
  }
}

async function cmdAddQuote(username, parts) {
  const text = parts.slice(1).join(' ').trim();
  if (!text) return sendChat(`@${username} Usage : !addquote texte de la citation`);
  const id = await db.addQuote(text, username, username);
  const quotes = await db.getQuotes();
  sendChat(`@${username} Citation #${quotes.length} ajoutée ✓`);
}

// ─── Counters ────────────────────────────────────────────────────────────────

async function cmdCounter(username, parts, defaultName) {
  const name = parts[1] === '+1' || parts[1] === '-1' || !parts[1] ? defaultName : (isNaN(parts[1]) ? defaultName : defaultName);
  const by = parts[1] === '-1' ? -1 : 1;
  const counter = await db.incrementCounter(name, by);
  const emojis = { morts: '💀', score: '🎯' };
  sendChat(`${emojis[name] || '🔢'} ${name.charAt(0).toUpperCase() + name.slice(1)} : ${counter.value}`);
}

async function cmdCounterInfo(username, parts) {
  const name = parts[1] || 'morts';
  const counter = await db.getCounter(name);
  if (!counter) return sendChat(`@${username} Compteur "${name}" non trouvé.`);
  sendChat(`🔢 ${name} = ${counter.value}`);
}

// ─── Queue ────────────────────────────────────────────────────────────────────

async function cmdJoinQueue(username) {
  const joined = await db.joinQueue(username);
  if (!joined) {
    const pos = await db.getQueuePosition(username);
    return sendChat(`@${username} Tu es déjà dans la file (#${pos}).`);
  }
  const q = await db.getQueue();
  const pos = q.findIndex(v => v.username === username.toLowerCase()) + 1;
  sendChat(`@${username} Tu rejoins la file ! Position : #${pos} (${q.length} total)`);
}

async function cmdLeaveQueue(username) {
  await db.removeFromQueue(username);
  sendChat(`@${username} Tu as quitté la file.`);
}

async function cmdQueuePos(username) {
  const pos = await db.getQueuePosition(username);
  if (!pos) return sendChat(`@${username} Tu n'es pas dans la file. Tape !queue pour rejoindre.`);
  const q = await db.getQueue();
  sendChat(`@${username} Tu es #${pos} sur ${q.length} dans la file.`);
}

// ─── Polls ────────────────────────────────────────────────────────────────────

async function cmdVote(username, parts) {
  const poll = await db.getActivePoll();
  if (!poll) return sendChat(`@${username} Aucun sondage en cours.`);
  const options = JSON.parse(poll.options);
  const choice = parseInt(parts[1]);
  if (isNaN(choice) || choice < 1 || choice > options.length) {
    return sendChat(`@${username} Vote avec !vote 1 à ${options.length} — Sondage : ${poll.question} | ${options.map((o, i) => `${i+1}. ${o}`).join(' | ')}`);
  }
  await db.votePoll(poll.id, username, choice - 1);
  sendChat(`@${username} Vote enregistré pour "${options[choice-1]}" ✓`);
}

async function cmdPollInfo(username) {
  const poll = await db.getActivePoll();
  if (!poll) return sendChat('Aucun sondage en cours.');
  const options = JSON.parse(poll.options);
  const votes = JSON.parse(poll.votes);
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const results = options.map((o, i) => {
    const pct = total > 0 ? Math.round((votes[i] || 0) / total * 100) : 0;
    return `${i+1}. ${o} (${pct}%)`;
  }).join(' | ');
  sendChat(`📊 ${poll.question} → ${results} — !vote N pour voter`);
}

// ─── Shoutout ─────────────────────────────────────────────────────────────────

async function cmdShoutout(username, parts) {
  const target = parts[1]?.replace('@', '');
  if (!target) return sendChat(`@${username} Usage : !so @pseudo`);
  sendChat(`🎉 Shoutout à @${target} ! Allez suivre sa chaîne sur kick.com/${target} 👏`);
}

// ─── Uptime ───────────────────────────────────────────────────────────────────

async function cmdUptime(username) {
  if (!streamStartTime) return sendChat('Stream hors ligne actuellement.');
  const diff = Math.floor((Date.now() - streamStartTime) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const time = h > 0 ? `${h}h ${m}min` : m > 0 ? `${m}min ${s}s` : `${s}s`;
  sendChat(`⏱ Le stream est en ligne depuis ${time}`);
}

// ─── Dice / RPS ───────────────────────────────────────────────────────────────

async function cmdDice(username, parts) {
  const max = parseInt(parts[1]) || 6;
  const roll = Math.floor(Math.random() * max) + 1;
  sendChat(`🎲 @${username} lance un D${max} et obtient : ${roll} !`);
}

async function cmdRPS(username, parts) {
  const choices = ['pierre', 'feuille', 'ciseaux'];
  const emojis  = ['🪨', '📄', '✂️'];
  const userChoice = parts[1]?.toLowerCase();
  const userIdx = choices.indexOf(userChoice);
  if (userIdx === -1) return sendChat(`@${username} Usage : !pfc pierre/feuille/ciseaux`);
  const botIdx = Math.floor(Math.random() * 3);
  const result = userIdx === botIdx ? 'Égalité' : (userIdx - botIdx + 3) % 3 === 1 ? `@${username} gagne` : 'Le bot gagne';
  sendChat(`${emojis[userIdx]} vs ${emojis[botIdx]} — ${result} !`);
}

async function cmdFollowage(username, parts) {
  const target = parts[1]?.replace('@', '') || username;
  sendChat(`@${username} Je ne peux pas vérifier le followage sans l'API officielle Kick. Désolé !`);
}

// ─── Announcements automatiques ───────────────────────────────────────────────

async function startAnnouncements() {
  // Arrêter les anciens timers
  Object.values(announcementIntervals).forEach(t => clearInterval(t));
  announcementIntervals = {};

  const announcements = await db.getAnnouncements();
  for (const ann of announcements) {
    if (!ann.enabled) continue;
    announcementIntervals[ann.id] = setInterval(async () => {
      if (!isLive) return;
      if (!await db.getSetting('announcements_enabled')) return;
      await sendChat(ann.message);
      await db.updateAnnouncementSent(ann.id);
    }, ann.interval_ms);
    console.log(`[ANN] Annonce #${ann.id} programmée toutes les ${ann.interval_ms/60000} min`);
  }
}

// ─── Modération ──────────────────────────────────────────────────────────────

async function moderateUser(username, action, duration, word) {
  const { token } = await getActiveToken();
  if (!token) { console.log(`[MOD] Simulation: ${action} ${username} pour "${word}"`); return; }
  try {
    if (action === 'ban') {
      await axios.post(
        `https://kick.com/api/v2/channels/${CONFIG.channelId}/bans`,
        { banned_username: username, permanent: true },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
      );
      console.log(`[MOD] ${username} banni pour "${word}"`);
    } else {
      await axios.post(
        `https://kick.com/api/v2/channels/${CONFIG.channelId}/bans`,
        { banned_username: username, duration: duration || 300, permanent: false },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
      );
      console.log(`[MOD] ${username} timeout ${duration}s pour "${word}"`);
    }
  } catch(err) {
    console.error('[MOD] Erreur modération:', err.response?.data || err.message);
  }
}

// ─── Token actif (OAuth officiel en priorité, sinon token manuel legacy) ──────

async function getActiveToken() {
  if (kickOAuth.isConfigured()) {
    const oauthToken = await kickOAuth.getValidAccessToken();
    if (oauthToken) return { token: oauthToken, official: true };
  }
  return { token: CONFIG.token, official: false };
}

// ─── Envoi messages ───────────────────────────────────────────────────────────

async function sendChat(message) {
  const { token, official } = await getActiveToken();
  if (!token) { console.log(`[BOT → CHAT] ${message}`); return; }

  try {
    if (official) {
      // API officielle Kick — endpoint public
      await axios.post(
        `https://api.kick.com/public/v1/chat`,
        { content: message, type: 'bot', broadcaster_user_id: parseInt(CONFIG.channelId) },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    } else {
      // Ancien endpoint interne (token manuel, fallback legacy)
      await axios.post(
        `https://kick.com/api/v2/messages/send/${CONFIG.channelId}`,
        { content: message, type: 'message' },
        { headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        }}
      );
    }
    db.setBotStatus('token_expired', '0').catch(()=>{});
  } catch(err) {
    const status = err.response?.status;
    console.error('[BOT] Erreur envoi:', err.response?.data || err.message);
    if (status === 401) {
      if (official) {
        // L'OAuth officiel se rafraîchit normalement tout seul — un 401 ici
        // signifie un vrai problème (déconnexion, scope manquant, etc.)
        console.warn('[AUTH] Token OAuth invalide malgré refresh — reconnecte-toi via /auth/login');
        db.setBotStatus('token_expired', '1').catch(()=>{});
      } else {
        console.warn('[AUTH] Token manuel expiré — mets à jour KICK_TOKEN dans Render, ou connecte le compte officiel via /auth/login');
        CONFIG.token = '';
        db.setBotStatus('token_expired', '1').catch(()=>{});
      }
    }
  }
}

// ─── Live check ───────────────────────────────────────────────────────────────

async function fetchKickChannel() {
  // Essayer plusieurs endpoints et User-Agents
  const urls = [
    `https://kick.com/api/v2/channels/${CONFIG.channel}`,
    `https://kick.com/api/v1/channels/${CONFIG.channel}`,
  ];
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    'Kick-Bot/1.0',
  ];
  for (const url of urls) {
    for (const ua of uas) {
      try {
        const res = await axios.get(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': ua,
            'Accept-Language': 'fr-FR,fr;q=0.9',
            'Cache-Control': 'no-cache',
          },
          timeout: 8000,
        });
        if (res.data) return res.data;
      } catch(err) {
        if (err.response?.status !== 403 && err.response?.status !== 429) {
          break;
        }
      }
    }
  }
  return null;
}

async function checkLiveStatus() {
  const data = await fetchKickChannel();
  if (!data) {
    console.log('[STREAM] API inaccessible (403) — statut conservé:', isLive ? 'LIVE' : 'OFF');
    return isLive;
  }

  const live = data?.livestream;
  const wasLive = isLive;
  isLive = !!(live?.is_live);

  if (isLive && !wasLive) {
    console.log('[STREAM] Stream démarré !');
    streamStartTime = Date.now();
    if (!currentSessionId) startSession();
    startAnnouncements();
  } else if (!isLive && wasLive) {
    console.log('[STREAM] Stream terminé.');
    if (currentSessionId) {
      const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
      db.endSession(currentSessionId, peakViewers, dur);
      currentSessionId = null;
    }
  }

  if (isLive && live?.viewer_count > peakViewers) peakViewers = live.viewer_count;

  // Mettre à jour followers
  const fc = data?.followers_count || data?.followersCount || 0;
  if (fc > 0 && fc !== lastFollowerCount) {
    if (lastFollowerCount > 0 && fc > lastFollowerCount) {
      const newF = fc - lastFollowerCount;
      console.log(`[FOLLOW] +${newF} follower(s) ! Total: ${fc}`);
      if (isLive && await db.getSetting('follow_alerts')) {
        const msg = newF === 1
          ? `Merci pour le follow ! On est maintenant ${fc} followers !`
          : `+${newF} nouveaux followers ! On est maintenant ${fc} !`;
        await sendChat(msg);
      }
    }
    lastFollowerCount = fc;
  }

  console.log(`[STREAM] Statut: ${isLive ? 'EN LIVE' : 'Hors ligne'} | Followers: ${lastFollowerCount}`);
  return isLive;
}

// ─── Points ───────────────────────────────────────────────────────────────────

function startPointsTracker() {
  if (pointsInterval) clearInterval(pointsInterval);
  console.log(`[BOT] Tracker démarré — +${CONFIG.pointsAmount} pts toutes les ${CONFIG.intervalMs/60000} min`);
  setTimeout(distributePoints, 30000);
  pointsInterval = setInterval(distributePoints, CONFIG.intervalMs);
}

async function distributePoints() {
  if (!isLive) { console.log('[POINTS] Hors ligne — pas de points.'); return; }
  if (!await db.getSetting('points_enabled')) { console.log('[POINTS] Désactivé.'); return; }
  const viewers = await db.getActiveViewers(120);
  if (!viewers.length) { console.log('[POINTS] Aucun viewer actif.'); return; }
  for (const v of viewers) await db.addPoints(v.username, CONFIG.pointsAmount, 'watch_time');
  console.log(`[POINTS] +${CONFIG.pointsAmount} pts → ${viewers.length} viewer(s) ✓`);
  checkObjectives();
}

async function checkObjectives() {
  const objectives = (await db.getObjectives()).filter(o => o.active && !o.achieved);
  const stats = await db.getGlobalStats();
  for (const obj of objectives) {
    if ((stats?.total_points_distributed || 0) >= obj.target) {
      await db.achieveObjective(obj.id);
      sendChat(`Objectif atteint : "${obj.title}" ! ${obj.reward || ''}`);
    }
  }
}

async function startSession() {
  currentSessionId = await db.startSession();
  sessionStart = Date.now();
  peakViewers = 0;
  console.log(`[BOT] Session #${currentSessionId} démarrée`);
}

function formatMin(m) {
  if (!m || m < 60) return `${m||0} min`;
  const h = Math.floor(m/60), min = m%60;
  return min > 0 ? `${h}h ${min}min` : `${h}h`;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

console.log('╔════════════════════════════════════════╗');
console.log('║     Kick Loyalty Bot v2.0              ║');
console.log(`║  Channel : ${CONFIG.channel.padEnd(28)}║`);
console.log(`║  Points  : +${String(CONFIG.pointsAmount).padEnd(4)} toutes les ${CONFIG.intervalMs/60000} min    ║`);
console.log('╚════════════════════════════════════════╝');

init().catch(err => {
  console.error('[BOT] Erreur démarrage:', err);
  process.exit(1);
});

process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
