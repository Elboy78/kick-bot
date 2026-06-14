/**
 * bot.js — Bot Kick complet avec duels, giveaway, niveaux, commandes custom
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios    = require('axios');
const db       = require('./database');

const CONFIG = {
  channel:      process.env.KICK_CHANNEL       || 'votre_chaine',
  channelId:    process.env.KICK_CHANNEL_ID    || '0',
  token:        process.env.KICK_TOKEN         || '',
  botEmail:     process.env.BOT_EMAIL          || '',
  botPassword:  process.env.BOT_PASSWORD       || '',
  botUsername:  process.env.BOT_USERNAME       || 'bot',
  pointsAmount: parseInt(process.env.POINTS_PER_INTERVAL || '10'),
  intervalMs:   parseInt(process.env.POINTS_INTERVAL_MS  || '300000'),
  debug:        process.env.DEBUG === 'true',
};

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.4.0&flash=false';

// Commandes système — état activé/désactivé (persisté via DB dans system_commands_state)
const SYSTEM_COMMANDS = ['!points','!top','!rang','!niveau','!aide','!duel','!accepter','!refuser','!participer','!giveaway','!lobby'];

function initSystemCommandsState() {
  try {
    db.getDB().prepare(`CREATE TABLE IF NOT EXISTS system_commands_state (
      trigger  TEXT PRIMARY KEY,
      enabled  INTEGER NOT NULL DEFAULT 1
    )`).run();
    for (const cmd of SYSTEM_COMMANDS) {
      try { db.getDB().prepare(`INSERT OR IGNORE INTO system_commands_state (trigger, enabled) VALUES (?, 1)`).run(cmd); } catch(e){}
    }
  } catch(e){}
}

function isSystemCmdEnabled(trigger) {
  try {
    const r = db.getDB().prepare(`SELECT enabled FROM system_commands_state WHERE trigger = ?`).get(trigger);
    return r ? r.enabled === 1 : true;
  } catch(e) { return true; }
}

let ws             = null;
let reconnectDelay = 5000;
let pointsInterval = null;
let pingInterval   = null;
let currentSessionId = null;
let sessionStart     = null;
let peakViewers      = 0;
let isLive           = false; // État du stream en temps réel

// Duels en attente { duelId: timeout }
const pendingDuelTimeouts = {};

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  console.log('[BOT] Connexion au WebSocket Kick...');
  ws = new WebSocket(PUSHER_URL);

  ws.on('open', () => {
    console.log('[BOT] Connecté ✓');
    reconnectDelay = 5000;
    subscribe(`chatrooms.${CONFIG.channelId}.v2`);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, 25000);
    startPointsTracker();
    // La session démarre automatiquement quand le live est détecté
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
  if (currentSessionId) {
    const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
    db.endSession(currentSessionId, peakViewers, dur);
    currentSessionId = null;
  }
  isLive = false;
}

function startSession() {
  currentSessionId = db.startSession();
  sessionStart = Date.now();
  peakViewers = 0;
  console.log(`[BOT] Session #${currentSessionId} démarrée`);
}

// ─── Événements ───────────────────────────────────────────────────────────────

function handleEvent(msg) {
  const { event, data } = msg;
  if (CONFIG.debug && event && !event.includes('ping') && event !== 'pusher:pong')
    console.log(`[DEBUG] Événement: "${event}"`);

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
      console.log('[BOT] Stream live !'); break;
    case 'App\\Events\\StopStreamBroadcast': case 'StopStreamBroadcast':
      console.log('[BOT] Stream terminé.'); cleanup(); break;
  }
}

// ─── Messages chat ────────────────────────────────────────────────────────────

function handleChatMessage(payload) {
  const username = payload?.sender?.username || payload?.user?.username || payload?.username;
  const content  = payload?.content || payload?.message || '';
  const kickId   = payload?.sender?.id?.toString() || null;
  if (!username || !content) return;

  // Enregistrer le viewer SEULEMENT si le stream est live
  if (isLive) {
    db.upsertViewer(username, kickId);
  }
  console.log(`[CHAT] ${username}: ${content}${!isLive ? ' (hors live — points ignorés)' : ''}`);

  const parts = content.trim().split(' ');
  const cmd   = parts[0].toLowerCase();

  // Commandes système (vérification enabled)
  if (SYSTEM_COMMANDS.includes(cmd)) {
    if (!isSystemCmdEnabled(cmd)) return; // commande désactivée
    switch(cmd) {
      case '!points':   return cmdPoints(username);
      case '!top':      return cmdTop(username);
      case '!rang':     return cmdRang(username);
      case '!niveau':   return cmdNiveau(username);
      case '!aide':     return cmdAide(username);
      case '!duel':     return cmdDuel(username, parts);
      case '!accepter': return cmdAccepter(username);
      case '!refuser':  return cmdRefuser(username);
      case '!participer': return cmdParticiper(username);
      case '!giveaway': return cmdGiveawayInfo(username);
      case '!lobby':    return cmdLobby(username);
    }
    return;
  }

  // Commandes personnalisées (enabled géré par DB)
  const custom = db.getCustomCommand(cmd);
  if (custom) {
    const response = custom.response.replace(/@\{user\}/gi, '@'+username);
    return sendChat(response);
  }
}

// ─── Commandes points ─────────────────────────────────────────────────────────

function cmdPoints(username) {
  const v = db.getViewer(username);
  if (!v) return sendChat(`@${username} Tu n'as pas encore de points. Regarde le stream pour en gagner !`);
  const rank  = db.getViewerRank(username);
  const level = db.getLevel(v.points);
  sendChat(`@${username} ${level.emoji} ${level.name} — ${v.points} pts (rang #${rank||'?'}) — ${formatMin(v.total_minutes)} regardées`);
}

function cmdTop(username) {
  const top = db.getLeaderboard(5);
  if (!top.length) return sendChat('Pas encore de classement disponible.');
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  sendChat(`Top viewers : ${top.map((v,i) => `${medals[i]} ${v.username} (${v.points} pts)`).join(' | ')}`);
}

function cmdRang(username) {
  const rank = db.getViewerRank(username);
  const v    = db.getViewer(username);
  if (!rank || !v) return sendChat(`@${username} Aucune donnée. Regarde le stream pour gagner des points !`);
  sendChat(`@${username} Tu es #${rank} avec ${v.points} points 🎯`);
}

function cmdNiveau(username) {
  const v = db.getViewer(username);
  if (!v) return sendChat(`@${username} Tu n'as pas encore de points !`);
  const level = db.getLevel(v.points);
  const next  = db.getNextLevel(v.points);
  if (!next) return sendChat(`@${username} ${level.emoji} Tu es au niveau maximum : ${level.name} ! 👑`);
  const needed = next.min - v.points;
  sendChat(`@${username} ${level.emoji} Niveau ${level.name} — encore ${needed} pts pour atteindre ${next.emoji} ${next.name}`);
}

function cmdAide(username) {
  const customs = db.getCustomCommands().map(c => c.trigger).join(' ');
  sendChat(`@${username} Commandes → !points !top !rang !niveau !duel [pseudo] [mise] !accepter !refuser !participer !giveaway${customs ? ' | Custom: '+customs : ''}`);
}

// ─── Duels ───────────────────────────────────────────────────────────────────

function cmdDuel(challenger, parts) {
  const opponent = parts[1]?.replace('@','');
  const amount   = parseInt(parts[2]);

  if (!opponent || isNaN(amount) || amount <= 0)
    return sendChat(`@${challenger} Usage : !duel @pseudo montant (ex: !duel @wezz0x 50)`);

  if (opponent.toLowerCase() === challenger.toLowerCase())
    return sendChat(`@${challenger} Tu ne peux pas te défier toi-même 😅`);

  const vC = db.getViewer(challenger);
  const vO = db.getViewer(opponent);

  if (!vC || vC.points < amount)
    return sendChat(`@${challenger} Tu n'as pas assez de points ! (tu as ${vC?.points||0} pts)`);
  if (!vO)
    return sendChat(`@${challenger} ${opponent} n'est pas encore enregistré dans le classement.`);
  if (vO.points < amount)
    return sendChat(`@${challenger} ${opponent} n'a pas assez de points pour cette mise (il a ${vO.points} pts)`);

  const duelId = db.createDuel(challenger, opponent, amount);
  sendChat(`⚔️ @${opponent} tu es défié par @${challenger} pour ${amount} pts ! Tape !accepter ou !refuser dans les 60 secondes !`);

  // Timeout auto-annulation après 60s
  pendingDuelTimeouts[duelId] = setTimeout(() => {
    db.cancelDuel(duelId);
    sendChat(`⏱ Le duel entre @${challenger} et @${opponent} a expiré (60s).`);
    delete pendingDuelTimeouts[duelId];
  }, 60000);
}

function cmdAccepter(username) {
  const duel = db.getPendingDuel(username);
  if (!duel) return sendChat(`@${username} Aucun duel en attente pour toi.`);

  // Annuler le timeout
  if (pendingDuelTimeouts[duel.id]) {
    clearTimeout(pendingDuelTimeouts[duel.id]);
    delete pendingDuelTimeouts[duel.id];
  }

  // Tirer au sort le gagnant
  const winner = Math.random() < 0.5 ? duel.challenger : duel.opponent;
  const loser  = winner === duel.challenger ? duel.opponent : duel.challenger;

  db.resolveDuel(duel.id, winner);
  db.addPoints(winner, duel.amount,  'duel_win');
  db.addPoints(loser,  -duel.amount, 'duel_loss');

  sendChat(`⚔️ Résultat du duel : @${winner} GAGNE ${duel.amount} pts face à @${loser} ! 🎉`);
}

function cmdRefuser(username) {
  const duel = db.getPendingDuel(username);
  if (!duel) return sendChat(`@${username} Aucun duel en attente pour toi.`);

  if (pendingDuelTimeouts[duel.id]) {
    clearTimeout(pendingDuelTimeouts[duel.id]);
    delete pendingDuelTimeouts[duel.id];
  }

  db.cancelDuel(duel.id);
  sendChat(`@${username} a refusé le duel de @${duel.challenger}.`);
}

// ─── Giveaway ────────────────────────────────────────────────────────────────

function cmdParticiper(username) {
  const g = db.getActiveGiveaway();
  if (!g) return sendChat(`@${username} Aucun giveaway en cours.`);

  if (g.cost > 0) {
    const v = db.getViewer(username);
    if (!v || v.points < g.cost)
      return sendChat(`@${username} Il faut ${g.cost} pts pour participer. Tu en as ${v?.points||0}.`);
  }

  const joined = db.joinGiveaway(g.id, username);
  if (!joined) return sendChat(`@${username} Tu es déjà inscrit au giveaway !`);

  if (g.cost > 0) db.addPoints(username, -g.cost, 'giveaway_entry');

  const entries = JSON.parse(g.entries).length + 1;
  sendChat(`@${username} ✅ Tu participes au giveaway "${g.title}" ! (${entries} participant${entries>1?'s':''})`);
}

function cmdLobby(username) {
  const already = db.getLobby().find(v => v.username === username.toLowerCase());
  if (already) return sendChat(`@${username} Tu es déjà dans le lobby ! Attends que le streamer lance la roue.`);
  const joined = db.joinLobby(username);
  if (!joined) return sendChat(`@${username} Tu es déjà inscrit dans le lobby !`);
  const count = db.getLobby().length;
  sendChat(`@${username} ✅ Tu rejoins le lobby ! (${count} joueur${count>1?'s':''} inscrit${count>1?'s':''})`);
}

function cmdGiveawayInfo(username) {
  const g = db.getActiveGiveaway();
  if (!g) return sendChat(`Aucun giveaway en cours.`);
  const entries = JSON.parse(g.entries).length;
  const costTxt = g.cost > 0 ? ` (coût : ${g.cost} pts)` : ' (gratuit)';
  sendChat(`🎁 Giveaway en cours : "${g.title}" — Lot : ${g.prize}${costTxt} — ${entries} participant${entries>1?'s':''} — Tape !participer pour rejoindre !`);
}

// ─── Tracker de points ────────────────────────────────────────────────────────

function startPointsTracker() {
  if (pointsInterval) clearInterval(pointsInterval);
  console.log(`[BOT] Tracker démarré — +${CONFIG.pointsAmount} pts toutes les ${CONFIG.intervalMs/60000} min`);
  setTimeout(distributePoints, 30000);
  pointsInterval = setInterval(distributePoints, CONFIG.intervalMs);
}

async function checkLiveStatus() {
  try {
    const res = await axios.get(`https://kick.com/api/v2/channels/${CONFIG.channel}`, {
      headers: { 'Accept':'application/json', 'User-Agent':'Mozilla/5.0' },
      timeout: 10000,
    });
    const live = res.data?.livestream;
    const wasLive = isLive;
    isLive = !!(live?.is_live);

    if (isLive && !wasLive) {
      console.log('[STREAM] 🔴 Stream démarré — points activés !');
      if (!currentSessionId) startSession();
    } else if (!isLive && wasLive) {
      console.log('[STREAM] ⚫ Stream terminé — points désactivés.');
      if (currentSessionId) {
        const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
        db.endSession(currentSessionId, peakViewers, dur);
        currentSessionId = null;
      }
    }

    if (isLive) {
      const viewerCount = live.viewer_count || 0;
      if (viewerCount > peakViewers) peakViewers = viewerCount;
    }

    return isLive;
  } catch(err) {
    console.error('[STREAM] Erreur vérification live:', err.message);
    return isLive; // Garder l'état précédent si erreur réseau
  }
}

async function distributePoints() {
  const live = await checkLiveStatus();

  if (!live) {
    console.log('[POINTS] Stream hors ligne — aucun point distribué.');
    return;
  }

  checkObjectives();

  const viewers = db.getActiveViewers(120);
  if (!viewers.length) { console.log('[POINTS] Aucun viewer actif.'); return; }

  for (const v of viewers) db.addPoints(v.username, CONFIG.pointsAmount, 'watch_time');
  console.log(`[POINTS] +${CONFIG.pointsAmount} pts → ${viewers.length} viewer(s) ✓`);
}

function checkObjectives() {
  const objectives = db.getObjectives().filter(o => o.active && !o.achieved);
  const stats = db.getGlobalStats();
  for (const obj of objectives) {
    if ((stats.total_points_distributed || 0) >= obj.target) {
      db.achieveObjective(obj.id);
      sendChat(`🎯 Objectif atteint : "${obj.title}" ! ${obj.reward ? 'Récompense : '+obj.reward : ''} 🎉`);
    }
  }
}

// ─── Authentification automatique ────────────────────────────────────────────

let loginInProgress = false;
let lastLoginAttempt = 0;

async function kickLogin() {
  if (!CONFIG.botEmail || !CONFIG.botPassword) return false;
  if (loginInProgress) return false;
  // Anti-spam : pas plus d'une tentative toutes les 2 minutes
  if (Date.now() - lastLoginAttempt < 120000) return false;

  loginInProgress = true;
  lastLoginAttempt = Date.now();

  try {
    console.log('[AUTH] Connexion au compte bot Kick...');

    // Étape 1 : récupérer le token XSRF
    const csrf = await axios.get('https://kick.com/api/v1/get-csrf-cookie', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      withCredentials: true,
    });
    const xsrfToken = csrf.headers['set-cookie']
      ?.find(c => c.startsWith('XSRF-TOKEN='))
      ?.split('=')[1]?.split(';')[0];

    if (!xsrfToken) throw new Error('XSRF token non trouvé');

    // Étape 2 : login
    const loginRes = await axios.post('https://kick.com/mobile/login', {
      email:    CONFIG.botEmail,
      password: CONFIG.botPassword,
    }, {
      headers: {
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'X-XSRF-TOKEN':  decodeURIComponent(xsrfToken),
        'Referer':       'https://kick.com/',
        'Origin':        'https://kick.com',
      },
      withCredentials: true,
    });

    const token = loginRes.data?.token || loginRes.data?.access_token;
    if (!token) throw new Error('Token non reçu dans la réponse');

    CONFIG.token = token;
    console.log('[AUTH] ✓ Connecté ! Token renouvelé automatiquement.');
    loginInProgress = false;
    return true;

  } catch(err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[AUTH] Échec connexion:', msg);
    loginInProgress = false;
    return false;
  }
}

// ─── Envoi de messages ────────────────────────────────────────────────────────

async function sendChat(message) {
  if (!CONFIG.token) {
    console.log(`[BOT → CHAT] ${message}`);
    console.warn('[AUTH] ⚠ Aucun token — relance: node refresh-token.js');
    return;
  }
  try {
    await axios.post(
      `https://kick.com/api/v2/messages/send/${CONFIG.channelId}`,
      { content: message, type: 'message' },
      { headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':       'https://kick.com/',
        'Origin':        'https://kick.com',
      }}
    );
  } catch(err) {
    const status = err.response?.status;
    console.error('[BOT] Erreur envoi:', err.response?.data || err.message);
    if (status === 401) {
      console.warn('[AUTH] ⚠ Token expiré ! Lance: node refresh-token.js puis redémarre le bot.');
      CONFIG.token = ''; // vider pour éviter les spams d'erreur
    }
  }
}

function formatMin(m) {
  if (!m || m < 60) return `${m||0} min`;
  const h = Math.floor(m/60), min = m%60;
  return min > 0 ? `${h}h ${min}min` : `${h}h`;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

initSystemCommandsState();

if (!CONFIG.token) {
  console.warn('[AUTH] ⚠ Aucun token configuré — le bot ne pourra pas envoyer de messages.');
  console.warn('[AUTH]   Lance: node refresh-token.js pour obtenir un token automatiquement.');
}

console.log('╔════════════════════════════════════════╗');
console.log('║     Kick Loyalty Bot v2.0              ║');
console.log(`║  Channel : ${CONFIG.channel.padEnd(28)}║`);
console.log(`║  Points  : +${String(CONFIG.pointsAmount).padEnd(4)} toutes les ${CONFIG.intervalMs/60000} min    ║`);
console.log('╚════════════════════════════════════════╝');

connect();
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
