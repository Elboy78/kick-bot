/**
 * bot.js — Bot Kick avec Turso (async DB)
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios    = require('axios');
const db       = require('./database');

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
const SYSTEM_COMMANDS = ['!points','!top','!rang','!niveau','!aide','!duel','!accepter','!refuser','!participer','!giveaway','!lobby'];

let ws             = null;
let reconnectDelay = 5000;
let pointsInterval = null;
let pingInterval   = null;
let isLive         = false;
let currentSessionId = null;
let sessionStart     = null;
let peakViewers      = 0;
const pendingDuelTimeouts = {};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await db.ensureInit();
  await db.initSystemCommandsState(SYSTEM_COMMANDS);
  console.log('[BOT] Base de données prête ✓');

  if (!CONFIG.token) {
    console.warn('[AUTH] Aucun token — le bot ne peut pas envoyer de messages');
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
        if (!currentSessionId) startSession();
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
      case '!duel':      return cmdDuel(username, parts);
      case '!accepter':  return cmdAccepter(username);
      case '!refuser':   return cmdRefuser(username);
      case '!participer':return cmdParticiper(username);
      case '!giveaway':  return cmdGiveawayInfo(username);
      case '!lobby':     return cmdLobby(username);
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

// ─── Envoi messages ───────────────────────────────────────────────────────────

async function sendChat(message) {
  if (!CONFIG.token) { console.log(`[BOT → CHAT] ${message}`); return; }
  try {
    await axios.post(
      `https://kick.com/api/v2/messages/send/${CONFIG.channelId}`,
      { content: message, type: 'message' },
      { headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      }}
    );
  } catch(err) {
    const status = err.response?.status;
    console.error('[BOT] Erreur envoi:', err.response?.data || err.message);
    if (status === 401) {
      console.warn('[AUTH] Token expiré — mets à jour KICK_TOKEN dans Render');
      CONFIG.token = '';
    }
  }
}

// ─── Live check ───────────────────────────────────────────────────────────────

async function checkLiveStatus() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'curl/7.88.1',
  ];
  for (const ua of userAgents) {
    try {
      const res = await axios.get(`https://kick.com/api/v2/channels/${CONFIG.channel}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': ua },
        timeout: 8000,
      });
      const live = res.data?.livestream;
      const wasLive = isLive;
      isLive = !!(live?.is_live);
      if (isLive && !wasLive) { console.log('[STREAM] En live !'); if (!currentSessionId) startSession(); }
      else if (!isLive && wasLive) { console.log('[STREAM] Stream terminé.'); }
      if (isLive && live?.viewer_count > peakViewers) peakViewers = live.viewer_count;
      console.log(`[STREAM] Etat initial : ${isLive ? 'EN LIVE' : 'Hors ligne'}`);
      return isLive;
    } catch(err) {
      if (err.response?.status !== 403) break;
    }
  }
  console.log('[STREAM] API inaccessible — mode fallback');
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
