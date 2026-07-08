/**
 * bot.js — Bot Kick avec Turso (async DB)
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios    = require('axios');
const db       = require('./database');
const kickOAuth = require('./kick-oauth');
const shared   = require('./shared');

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
const SYSTEM_COMMANDS = ['!points','!top','!rang','!niveau','!aide','!duel','!accepter','!refuser','!participer','!giveaway','!lobby','!quote','!addquote','!mort','!death','!score','!queue','!join','!leave','!pos','!vote','!sondage','!so','!uptime','!fc','!sc','!coffre','!victoire','!to','!dice','!des','!rps','!pfc','!clip','!addcmd','!delcmd','!addword','!delword','!allowword','!disallowword'];

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
  // Enregistrer sendChat dans le module partagé pour que panel.js puisse l'utiliser
  shared.registerSendChat(sendChat);
  await startAnnouncements();
  await syncPointsConfig();
  // Vérifier live + followers toutes les 2 minutes
  setInterval(checkLiveStatus, 120000);
  // Resynchroniser montant/intervalle de points toutes les 2 minutes (changements panel)
  setInterval(syncPointsConfig, 120000);
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

// Cache des 500 derniers messages pour retrouver le texte associé à un ban/timeout
const recentMessages = new Map(); // username → { content, msgId }

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

    // Ban / Timeout (AI Mods, modérateur humain ou notre bot)
    case 'App\\Events\\UserBannedEvent':
    case 'UserBannedEvent': {
      let p; try { p = typeof data === 'string' ? JSON.parse(data) : data; } catch { break; }
      handleUserBanned(p);
      break;
    }

    // Message supprimé (souvent lié à un ban/timeout)
    case 'App\\Events\\ChatMessageDeletedEvent':
    case 'ChatMessageDeleted': {
      let p; try { p = typeof data === 'string' ? JSON.parse(data) : data; } catch { break; }
      handleMessageDeleted(p);
      break;
    }

    case 'App\\Events\\StreamerIsLive': case 'StreamerIsLive':
    case 'App\\Events\\LivestreamUpdated': case 'LivestreamUpdated': {
      const wasLive = isLive; isLive = true;
      if (!wasLive) {
        console.log('[STREAM] Stream démarré — points activés !');
        streamStartTime = Date.now();
        db.setBotStatus('stream_started_at', streamStartTime.toString()).catch(()=>{});
        if (!currentSessionId) startSession();
        startAnnouncements();
        startPointsTracker(); // ← déclencher le tracker de points dès le début du live
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

    // Récompense de points de chaîne rachetée — nom d'événement non confirmé sur ce bot,
    // on tente plusieurs variantes plausibles en plus du logger générique ci-dessous.
    case 'App\\Events\\RewardRedeemedEvent':
    case 'RewardRedeemedEvent':
    case 'reward-redeemed':
    case 'RewardRedeemed': {
      let p; try { p = typeof data === 'string' ? JSON.parse(data) : data; } catch { break; }
      handleRewardRedeemed(p);
      break;
    }

    default: {
      // Logger générique : capture tout événement Kick pas encore géré, pour pouvoir
      // découvrir le vrai nom/format des événements (ex: rachat de récompense) via les logs Render.
      if (event && !event.startsWith('pusher:') && !event.startsWith('pusher_internal:')) {
        let preview = data;
        try { preview = typeof data === 'string' ? JSON.parse(data) : data; } catch {}
        console.log(`[EVENT INCONNU] "${event}" —`, JSON.stringify(preview).slice(0, 1500));
      }
      break;
    }
  }
}

// ─── Rachat de récompense (points de chaîne Kick natifs) ─────────────────────

async function handleRewardRedeemed(payload) {
  try {
    console.log('[REWARD] Payload brut reçu:', JSON.stringify(payload).slice(0, 1500));

    // Chemins possibles selon la forme réelle du payload (à ajuster une fois confirmée en logs)
    const redemption = payload?.redemption || payload;
    const rewardTitle = redemption?.reward?.title || payload?.reward?.title || '';
    const redeemerUsername = redemption?.user?.login || redemption?.user?.username || payload?.user?.username || payload?.username || '';
    const userInput = redemption?.user_input || redemption?.input || payload?.user_input || payload?.input || '';

    if (!rewardTitle || !redeemerUsername) {
      console.log('[REWARD] Champs manquants — impossible de traiter (voir payload brut ci-dessus).');
      return;
    }

    const toRewardName = await db.getSettingStr('to_reward_title', 'TO Quelqu\'un de ton choix');
    if (!rewardTitle.toLowerCase().includes(toRewardName.toLowerCase().slice(0, 10))) {
      console.log(`[REWARD] "${rewardTitle}" ne correspond pas à la récompense TO configurée ("${toRewardName}") — ignoré.`);
      return;
    }

    const target = (userInput || '').replace('@', '').trim();
    if (!target) {
      sendChat(`@${redeemerUsername} Ta récompense TO a été rachetée mais aucun pseudo n'a été fourni !`);
      return;
    }
    if (target.toLowerCase() === CONFIG.channel.toLowerCase()) {
      sendChat(`@${redeemerUsername} Impossible de TO le streamer !`);
      return;
    }
    if (target.toLowerCase() === CONFIG.botUsername.toLowerCase()) {
      sendChat(`@${redeemerUsername} Impossible de TO le bot !`);
      return;
    }

    const duration = parseInt(await db.getSettingStr('to_command_duration', '60')) || 60;
    const targetViewer = await db.getViewer(target);
    const ok = await moderateUser(target, targetViewer?.kick_user_id || null, 'timeout', duration, `TO (points de chaîne) acheté par ${redeemerUsername}`);

    if (ok) {
      sendChat(`⏱️ @${redeemerUsername} a racheté TO ${target} pendant ${duration}s avec ses points de chaîne ! 🩸`);
    } else {
      sendChat(`@${redeemerUsername} Le TO sur @${target} a échoué côté Kick.`);
    }
  } catch(e) {
    console.error('[REWARD] Erreur traitement rachat:', e.message);
  }
}

// ─── Messages chat ────────────────────────────────────────────────────────────

async function handleChatMessage(payload) {
  // Filet de sécurité : Kick annonce parfois un rachat de récompense comme un message de chat
  // "spécial" plutôt qu'un événement dédié — on le détecte ici avant le traitement normal.
  if (payload?.type === 'reward_redeemed' || payload?.metadata?.reward || payload?.reward) {
    console.log('[REWARD] Détecté via message de chat spécial:', JSON.stringify(payload).slice(0, 1500));
    handleRewardRedeemed(payload);
    return;
  }

  const username = payload?.sender?.username || payload?.user?.username || payload?.username;
  const content  = payload?.content || payload?.message || '';
  const kickId   = payload?.sender?.id?.toString() || null;
  if (!username || !content) return;

  // Détection modérateur/broadcaster via les badges Kick (sender.identity.badges)
  const badges = payload?.sender?.identity?.badges || [];
  const isModOrBroadcaster = badges.some(b => b.type === 'moderator' || b.type === 'broadcaster');

  await db.upsertViewer(username, kickId);
  // Mettre à jour le cache des derniers messages pour retrouver le contexte des bans
  recentMessages.set(username.toLowerCase(), { content, kickId });
  if (recentMessages.size > 500) recentMessages.delete(recentMessages.keys().next().value);
  db.logChatActivity(username).catch(e => console.error('[CHAT ACTIVITY] Erreur ignorée:', e.message));
  console.log(`[CHAT] ${username}: ${content}`);

  // Vérifier les mots bannis
  if (await db.getSetting('moderation_enabled')) {
    try {
      const banned = await db.checkBannedWords(content);
      if (banned) {
        console.log(`[MODÉRATION] Mot banni: "${banned.word}" de ${username}`);
        await moderateUser(username, kickId, banned.action, banned.duration, banned.word);
        return;
      }
    } catch(e) {
      console.error('[MOD] Erreur checkBannedWords (ignorée):', e.message);
    }
  }

  const parts = content.trim().split(' ');
  const cmd   = parts[0].toLowerCase();

  // Commandes système
  if (SYSTEM_COMMANDS.includes(cmd)) {
    const enabled = await db.isSystemCmdEnabled(cmd);
    if (!enabled) { console.log(`[DEBUG] Commande ${cmd} désactivée via isSystemCmdEnabled`); return; }
    db.logCommandUsage(cmd, username).catch(()=>{});
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
      case '!lobby': {
        const lobbyOn = await db.getSetting('lobby_enabled');
        return lobbyOn ? cmdLobby(username) : null;
      }
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
      case '!fc':        return cmdFollowage(username, parts);
      case '!sc':        return cmdSubCheck(username, parts);
      case '!coffre':    return cmdOpenChest(username, parts, isModOrBroadcaster, badges);
      case '!victoire':  return cmdMarkVictory(username, isModOrBroadcaster);
      case '!to':        return cmdTimeoutBuy(username, parts);
      case '!clip':      return (await db.getSetting('clip_enabled')) ? cmdClip(username, parts) : null;
      case '!addcmd':    return cmdAddCommand(username, parts, isModOrBroadcaster);
      case '!delcmd':    return cmdDelCommand(username, parts, isModOrBroadcaster);
      case '!addword':   return cmdAddBannedWord(username, parts, isModOrBroadcaster);
      case '!delword':   return cmdDelBannedWord(username, parts, isModOrBroadcaster);
      case '!allowword':    return cmdAllowWord(username, parts, isModOrBroadcaster);
      case '!disallowword': return cmdDisallowWord(username, parts, isModOrBroadcaster);
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
    db.logCommandUsage(cmd, username).catch(()=>{});
    const response = custom.response.replace(/@\{user\}/gi, '@' + username);
    return sendChat(response);
  }
}

// ─── Commandes ────────────────────────────────────────────────────────────────

async function cmdPoints(username) {
  const v = await db.getViewer(username);
  if (!v) return sendChat(`@${username} Tu n'as pas encore de points. Regarde le stream pour en gagner !`);
  const rank  = await db.getViewerRank(username);
  const level = await db.getLevel(v.points);
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
  const level = await db.getLevel(v.points);
  const next  = await db.getNextLevel(v.points);
  if (!next) return sendChat(`@${username} ${level.emoji} Niveau maximum : ${level.name} ! 👑`);
  sendChat(`@${username} ${level.emoji} Niveau ${level.name} — encore ${next.min - v.points} pts pour ${next.emoji} ${next.name}`);
}

async function cmdAide(username) {
  try {
    // Commandes système activées — on lit l'état réel depuis la DB
    const [systemStates, settings, customs] = await Promise.all([
      db.getAllSystemCommandsState(),
      db.getAllSettings(),
      db.getCustomCommands(),
    ]);

    // Map des états des commandes système (trigger → enabled)
    const stateMap = {};
    systemStates.forEach(s => { stateMap[s.trigger] = s.enabled !== 0 && s.enabled !== false; });

    // Map des fonctionnalités (pour exclure les commandes liées à une fonctionnalité désactivée)
    const settingMap = {};
    settings.forEach(s => { settingMap[s.key] = s.value === '1'; });

    // Correspondance commande → clé de fonctionnalité associée
    const cmdFeature = {
      '!points': 'points_enabled',  '!top': 'points_enabled',
      '!rang': 'points_enabled',    '!niveau': 'points_enabled',
      '!duel': 'duel_enabled',      '!accepter': 'duel_enabled',    '!refuser': 'duel_enabled',
      '!giveaway': 'giveaway_enabled', '!participer': 'giveaway_enabled',
      '!lobby': 'lobby_enabled',
      '!quote': 'quote_enabled',    '!addquote': 'quote_enabled',
      '!uptime': 'uptime_enabled',
      '!so': 'shoutout_enabled',
      '!vote': 'poll_enabled',      '!sondage': 'poll_enabled',
      '!dice': 'dice_enabled',      '!des': 'dice_enabled',
      '!rps': 'dice_enabled',       '!pfc': 'dice_enabled',
      '!clip': 'clip_enabled',
    };

    // Garder seulement ce qui est visible par les viewers (pas les commandes mod/admin)
    const modOnly = ['!addcmd','!delcmd','!addword','!delword','!allowword','!disallowword'];
    const visibleCmds = SYSTEM_COMMANDS.filter(cmd => {
      if (modOnly.includes(cmd)) return false;
      if (!(stateMap[cmd] ?? true)) return false; // désactivé dans system_commands_state
      const feature = cmdFeature[cmd];
      if (feature && !(settingMap[feature] ?? true)) return false; // fonctionnalité désactivée
      return true;
    });

    // Commandes custom actives (excl. doublons avec système)
    const customList = customs
      .filter(c => c.enabled !== 0 && c.enabled !== false)
      .map(c => c.trigger);

    const all = [...visibleCmds, ...customList];
    if (!all.length) {
      sendChat(`@${username} Aucune commande activée pour le moment.`);
      return;
    }

    // Kick limite les messages à ~500 caractères — on pagine si nécessaire
    const prefix = `Commandes disponibles → `;
    let line = prefix;
    const lines = [];
    for (const cmd of all) {
      if ((line + cmd + ' ').length > 450) {
        lines.push(line.trim());
        line = '';
      }
      line += cmd + ' ';
    }
    if (line.trim()) lines.push(line.trim());

    // N'envoyer que le premier message (les viewers peuvent retaper !aide pour voir le reste)
    sendChat(`@${username} ${lines[0]}${lines.length > 1 ? ` (+${all.length - lines[0].split(' ').length + 1} autres)` : ''}`);
  } catch(e) {
    sendChat(`@${username} Commandes → !points !top !rang !niveau !lobby !duel !clip`);
  }
}

async function cmdLobby(username) {
  const already = (await db.getLobby()).find(v => v.username === username.toLowerCase());
  if (already) return;
  await db.joinLobby(username);
  // Ajout silencieux dans le chat — visible directement dans le panel
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

async function cmdFollowage(username, parts) {
  // !fc → ses propres stats | !fc pseudo → stats d'un autre
  const target = parts[1] ? parts[1].replace(/^@/, '').toLowerCase() : username.toLowerCase();
  const displayName = parts[1] ? parts[1].replace(/^@/, '') : username;
  const self = target === username.toLowerCase();

  try {
    const viewer = await db.getViewerFirstSeen(target);

    // 1) Date de follow résolue par le navigateur du panel (stockée en DB)
    let followingSince = viewer?.following_since && viewer.following_since !== 'NOT_FOLLOWING'
      ? viewer.following_since : null;

    // 2) Sinon, tentative directe (peut être bloquée par Cloudflare depuis Render)
    if (!followingSince) {
      try {
        const res = await axios.get(
          `https://kick.com/api/v2/channels/${CONFIG.channel}/users/${encodeURIComponent(target)}`,
          { headers: { 'Accept': 'application/json', 'Accept-Language': 'en-US', 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }
        );
        followingSince = res.data?.following_since || null;
        // La stocker pour les prochaines fois
        if (followingSince) db.setViewerFollowingSince(target, followingSince).catch(()=>{});
      } catch(apiErr) {
        console.log(`[FC] API follow échouée pour ${target}: ${apiErr.response?.status || apiErr.message}`);
      }
    }

    if (!followingSince && !viewer) {
      return sendChat(`@${username} ${displayName} n'a jamais été vu sur cette chaîne.`);
    }

    const isRealFollow = !!followingSince;
    const refDate = isRealFollow ? new Date(followingSince) : new Date(viewer.first_seen + 'Z');

    const diffMs = Date.now() - refDate.getTime();
    const days   = Math.floor(diffMs / 86400000);
    const h      = Math.floor((diffMs % 86400000) / 3600000);

    let duree;
    if (days >= 365) {
      const years = Math.floor(days / 365);
      const rem   = days % 365;
      duree = `${years} an${years > 1 ? 's' : ''} et ${rem} jour${rem > 1 ? 's' : ''}`;
    } else if (days >= 30) {
      const months = Math.floor(days / 30);
      duree = `${months} mois et ${days % 30} jour${days % 30 > 1 ? 's' : ''}`;
    } else if (days > 0) {
      duree = `${days} jour${days > 1 ? 's' : ''} et ${h}h`;
    } else {
      duree = `${h}h (tout frais !)`;
    }

    if (isRealFollow) {
      if (self) sendChat(`💜 @${username} tu follow la chaîne depuis ${duree} !`);
      else      sendChat(`💜 ${displayName} follow la chaîne depuis ${duree} !`);
    } else {
      if (self) sendChat(`📅 @${username} premier message il y a ${duree} !`);
      else      sendChat(`📅 ${displayName} — premier message il y a ${duree} !`);
    }
  } catch(e) {
    console.error('[FC] Erreur:', e.message);
    sendChat(`@${username} Impossible de récupérer les infos pour le moment.`);
  }
}

async function cmdSubCheck(username, parts) {
  // !sc → son propre statut sub | !sc pseudo → celui d'un autre
  const target = parts[1] ? parts[1].replace(/^@/, '').toLowerCase() : username.toLowerCase();
  const displayName = parts[1] ? parts[1].replace(/^@/, '') : username;
  const self = target === username.toLowerCase();

  try {
    const viewer = await db.getViewerFirstSeen(target);

    // 1) Valeur résolue par le navigateur du panel (stockée en DB)
    let subscribedFor = viewer?.subscribed_for ?? null;

    // 2) Sinon tentative directe (peut être bloquée par Cloudflare depuis Render)
    if (subscribedFor === null) {
      try {
        const res = await axios.get(
          `https://kick.com/api/v2/channels/${CONFIG.channel}/users/${encodeURIComponent(target)}`,
          { headers: { 'Accept': 'application/json', 'Accept-Language': 'en-US', 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }
        );
        subscribedFor = res.data?.subscribed_for ?? 0;
        // Stocker pour les prochaines fois (avec la date de follow si présente)
        db.setViewerFollowingSince(target, res.data?.following_since || viewer?.following_since || 'NOT_FOLLOWING', subscribedFor).catch(()=>{});
      } catch(apiErr) {
        console.log(`[SC] API sub échouée pour ${target}: ${apiErr.response?.status || apiErr.message}`);
      }
    }

    if (subscribedFor === null) {
      // Ni DB ni API — le résolveur navigateur ne l'a pas encore traité
      return sendChat(`@${username} Info sub pas encore disponible pour ${displayName} — réessaie dans 1-2 minutes (panel ouvert requis).`);
    }

    if (subscribedFor > 0) {
      const label = subscribedFor === 1 ? '1 mois' : `${subscribedFor} mois`;
      if (self) sendChat(`⭐ @${username} tu es sub de la chaîne depuis ${label} — merci pour le soutien ! 💜`);
      else      sendChat(`⭐ ${displayName} est sub depuis ${label} !`);
    } else {
      if (self) sendChat(`@${username} tu n'es pas sub de la chaîne actuellement — rejoins-nous ! ⭐`);
      else      sendChat(`${displayName} n'est pas sub de la chaîne actuellement.`);
    }
  } catch(e) {
    console.error('[SC] Erreur:', e.message);
    sendChat(`@${username} Impossible de vérifier le statut sub pour le moment.`);
  }
}

async function cmdOpenChest(username, parts, isModOrBroadcaster, badges) {
  // Toggle panel : quand il est OFF, le système de coffres reste testable mais le bot ne parle pas dans le chat.
  let chestChatEnabled = true;
  try { chestChatEnabled = await db.getSetting('chests_chat_enabled'); } catch(e) { chestChatEnabled = true; }

  // Réservé au broadcaster uniquement (c'est SON jeu, ses gains, ses malus)
  const isBroadcaster = (badges || []).some(b => b.type === 'broadcaster');
  if (!isBroadcaster) {
    if (!chestChatEnabled) return;
    return sendChat(`@${username} Seul le streamer peut ouvrir les coffres de l'Entité ! 🩸`);
  }

  const number = parseInt(parts[1]);
  if (!number || number < 1 || number > 30) {
    if (!chestChatEnabled) return;
    return sendChat(`@${username} Utilisation: !coffre <1-30>`);
  }

  try {
    const shared = require('./shared');
    const result = await shared.openChest(number);
    if (result?.error) {
      if (!chestChatEnabled) return;
      return sendChat(`@${username} ${result.error}`);
    }
    // Le résultat est annoncé par le panel uniquement si le toggle chat est ON.
  } catch(e) {
    console.error('[COFFRE] Erreur:', e.message);
    if (chestChatEnabled) sendChat(`@${username} Erreur lors de l'ouverture du coffre.`);
  }
}

async function cmdMarkVictory(username, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs ou le streamer peuvent déclarer une victoire ! 🩸`);
  }
  try {
    const shared = require('./shared');
    const result = await shared.markVictory();
    if (result?.error) return sendChat(`@${username} ${result.error}`);
    // Le message de confirmation est déjà envoyé par le panel (broadcastage centralisé).
  } catch(e) {
    console.error('[VICTOIRE] Erreur:', e.message);
    sendChat(`@${username} Erreur lors du marquage de la victoire.`);
  }
}

async function cmdTimeoutBuy(username, parts) {
  const target = (parts[1] || '').replace('@', '').trim();
  if (!target) return sendChat(`@${username} Utilisation : !to <pseudo> — TO le pseudo de ton choix avec tes points !`);
  if (target.toLowerCase() === username.toLowerCase())
    return sendChat(`@${username} Tu ne peux pas te TO toi-même !`);
  if (target.toLowerCase() === CONFIG.channel.toLowerCase())
    return sendChat(`@${username} Impossible de TO le streamer !`);
  if (target.toLowerCase() === CONFIG.botUsername.toLowerCase())
    return sendChat(`@${username} Impossible de TO le bot !`);

  const cost     = parseInt(await db.getSettingStr('to_command_cost', '500')) || 500;
  const duration = parseInt(await db.getSettingStr('to_command_duration', '60')) || 60;

  const buyer = await db.getViewer(username);
  if (!buyer || buyer.points < cost)
    return sendChat(`@${username} Il te faut ${cost} pts pour un TO (tu as ${buyer?.points || 0} pts).`);

  const targetViewer = await db.getViewer(target);

  await db.addPoints(username, -cost, 'to_purchase');

  try {
    const ok = await moderateUser(target, targetViewer?.kick_user_id || null, 'timeout', duration, `TO acheté par ${username}`);
    if (ok) {
      sendChat(`⏱️ @${username} a TO @${target} pendant ${duration}s pour ${cost} pts ! 🩸`);
    } else {
      await db.addPoints(username, cost, 'to_refund');
      sendChat(`@${username} Le TO sur @${target} a échoué côté Kick — points remboursés.`);
    }
  } catch(e) {
    console.error('[TO] Erreur:', e.message);
    await db.addPoints(username, cost, 'to_refund');
    sendChat(`@${username} Erreur lors du TO — points remboursés.`);
  }
}

async function cmdClip(username, parts) {
  if (!isLive || !streamStartTime) {
    return sendChat(`@${username} Impossible de créer un clip — le stream n'est pas en ligne.`);
  }

  // Timestamp actuel dans le stream (secondes depuis le début)
  const timestampS = Math.floor((Date.now() - streamStartTime) / 1000);
  // Label optionnel passé par l'utilisateur : !clip moment drôle
  const label = parts.slice(1).join(' ').trim() || `Clip de ${username}`;

  try {
    // On récupère l'ID du stream actuel depuis bot_status pour construire l'URL du replay
    const vodUuid = await db.getSettingStr('current_vod_uuid', '');
    const channel  = CONFIG.channel;
    // Lien direct vers le replay AU bon timestamp pour retrouver le moment immédiatement
    const vodUrl   = vodUuid ? `https://kick.com/${channel}/videos/${vodUuid}?t=${timestampS}` : '';
    const vodTitle = await db.getSettingStr('current_stream_title', 'Stream en cours');

    await db.addVodMoment('live', vodTitle, vodUrl, timestampS, label, 'clip', username);

    const h = Math.floor(timestampS/3600), m = Math.floor((timestampS%3600)/60), s = timestampS%60;
    const ts = h > 0 ? `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s` : `${m}m${String(s).padStart(2,'0')}s`;
    sendChat(`✂️ Clip marqué à ${ts} par @${username} — visible dans le panel VODs !`);
    console.log(`[CLIP] Marqué à ${ts} par ${username}: "${label}"`);
  } catch(e) {
    console.error('[CLIP] Erreur:', e.message);
    sendChat(`@${username} Erreur lors du marquage du clip.`);
  }
}

async function handleUserBanned(payload) {
  try {
    // Structure Pusher : { user: {username, id}, banned_by: {username}, expires_at, permanent }
    const username  = payload?.user?.username || payload?.username || '';
    const bannedBy  = payload?.banned_by?.username || payload?.moderator?.username || 'inconnu';
    const expiresAt = payload?.expires_at || null;
    const permanent = payload?.permanent || !expiresAt;

    // Calcul de la durée en secondes si c'est un timeout
    let duration = null;
    let type = 'ban';
    if (!permanent && expiresAt) {
      type = 'timeout';
      const ms = new Date(expiresAt).getTime() - Date.now();
      duration = Math.max(1, Math.round(ms / 1000));
    }

    // Récupérer le dernier message connu de cet utilisateur
    const lastMsg = recentMessages.get(username.toLowerCase());
    const msgContent = lastMsg?.content || '';

    const durationLabel = type === 'ban' ? 'permanent' : `${duration}s`;
    console.log(`[MOD LOG] ${type.toUpperCase()} — ${username} par ${bannedBy} (${durationLabel})${msgContent ? ` | dernier msg: "${msgContent}"` : ''}`);

    await db.addModerationLog(type, username, duration, `Action par ${bannedBy}`, msgContent, bannedBy);
  } catch(e) {
    console.error('[MOD LOG] Erreur handleUserBanned:', e.message);
  }
}

async function handleMessageDeleted(payload) {
  try {
    // Structure : { message: { id, content }, user: { username } }
    const username = payload?.user?.username || payload?.username || '';
    const content  = payload?.message?.content || payload?.content || '';
    const msgId    = payload?.message?.id || '';

    console.log(`[MOD LOG] MESSAGE SUPPRIMÉ — ${username}: "${content}"`);
    // On ne logue pas en DB les suppressions simples (trop fréquentes), juste en console
    // Elles seront visibles dans l'onglet Logs du panel via les logs récents.
    // Un ban associé à cette suppression sera loggué via handleUserBanned.
  } catch(e) { /* silencieux */ }
}

async function cmdAddCommand(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent créer des commandes.`);
  }
  // Format attendu : !addcmd !nomcommande Réponse à donner ici
  const trigger = (parts[1] || '').toLowerCase();
  const response = parts.slice(2).join(' ').trim();

  if (!trigger.startsWith('!') || trigger.length < 2) {
    return sendChat(`@${username} Utilisation: !addcmd !nom La réponse du bot`);
  }
  if (!response) {
    return sendChat(`@${username} Il manque la réponse. Ex: !addcmd !discord Rejoins notre Discord: lien.com`);
  }
  if (SYSTEM_COMMANDS.includes(trigger)) {
    return sendChat(`@${username} "${trigger}" est une commande système réservée, choisis un autre nom.`);
  }

  try {
    await db.setCustomCommand(trigger, response);
    sendChat(`✅ Commande ${trigger} créée/mise à jour par @${username} !`);
    console.log(`[ADDCMD] ${username} a créé/modifié ${trigger}: "${response}"`);
  } catch(e) {
    console.error('[ADDCMD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de la création de la commande.`);
  }
}

async function cmdDelCommand(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent supprimer des commandes.`);
  }
  const trigger = (parts[1] || '').toLowerCase();
  if (!trigger.startsWith('!')) {
    return sendChat(`@${username} Utilisation: !delcmd !nom`);
  }

  try {
    const existing = await db.getCustomCommand(trigger);
    if (!existing) {
      return sendChat(`@${username} La commande ${trigger} n'existe pas.`);
    }
    await db.deleteCustomCommand(trigger);
    sendChat(`🗑️ Commande ${trigger} supprimée par @${username}.`);
    console.log(`[DELCMD] ${username} a supprimé ${trigger}`);
  } catch(e) {
    console.error('[DELCMD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de la suppression.`);
  }
}

async function cmdAddBannedWord(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent ajouter des mots bannis.`);
  }
  // Format: !addword <mot> <timeout|ban> [duree_secondes]
  const word = (parts[1] || '').toLowerCase();
  const actionRaw = (parts[2] || 'timeout').toLowerCase();
  const durationRaw = parts[3];

  if (!word) {
    return sendChat(`@${username} Utilisation: !addword <mot> <timeout|ban> [durée_secondes]`);
  }
  const action = (actionRaw === 'ban' || actionRaw === 'permanent') ? 'ban' : 'timeout';
  const duration = action === 'ban' ? 0 : (parseInt(durationRaw) || 300);

  try {
    const ok = await db.addBannedWord(word, action, duration);
    if (!ok) {
      return sendChat(`@${username} Erreur lors de l'ajout du mot banni.`);
    }
    const actionLabel = action === 'ban' ? 'ban permanent' : `timeout ${duration}s`;
    sendChat(`🛡️ Mot banni ajouté par @${username} (${actionLabel}).`);
    console.log(`[ADDWORD] ${username} a banni le mot "${word}" (${actionLabel})`);
  } catch(e) {
    console.error('[ADDWORD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de l'ajout.`);
  }
}

async function cmdDelBannedWord(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent supprimer des mots bannis.`);
  }
  const word = (parts[1] || '').toLowerCase();
  if (!word) {
    return sendChat(`@${username} Utilisation: !delword <mot>`);
  }

  try {
    const existing = await db.getBannedWordByText(word);
    if (!existing) {
      return sendChat(`@${username} Le mot "${word}" n'est pas dans la liste des mots bannis.`);
    }
    await db.deleteBannedWordByText(word);
    sendChat(`✅ Mot banni "${word}" retiré par @${username}.`);
    console.log(`[DELWORD] ${username} a retiré le mot "${word}"`);
  } catch(e) {
    console.error('[DELWORD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de la suppression.`);
  }
}

async function cmdAllowWord(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent gérer la liste des mots autorisés.`);
  }
  const word = (parts[1] || '').toLowerCase();
  const note = parts.slice(2).join(' ').trim();
  if (!word) {
    return sendChat(`@${username} Utilisation: !allowword <mot> [note]`);
  }

  try {
    const ok = await db.addAllowedWord(word, note);
    if (!ok) return sendChat(`@${username} Erreur lors de l'ajout.`);
    sendChat(`✅ "${word}" ajouté à la liste blanche par @${username} — ne sera plus jamais sanctionné.`);
    console.log(`[ALLOWWORD] ${username} a autorisé le mot "${word}"`);
  } catch(e) {
    console.error('[ALLOWWORD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de l'ajout.`);
  }
}

async function cmdDisallowWord(username, parts, isModOrBroadcaster) {
  if (!isModOrBroadcaster) {
    return sendChat(`@${username} Seuls les modérateurs peuvent gérer la liste des mots autorisés.`);
  }
  const word = (parts[1] || '').toLowerCase();
  if (!word) {
    return sendChat(`@${username} Utilisation: !disallowword <mot>`);
  }

  try {
    const existing = await db.getAllowedWordByText(word);
    if (!existing) {
      return sendChat(`@${username} "${word}" n'est pas dans la liste blanche.`);
    }
    await db.deleteAllowedWordByText(word);
    sendChat(`🗑️ "${word}" retiré de la liste blanche par @${username}.`);
    console.log(`[DISALLOWWORD] ${username} a retiré "${word}" de la liste blanche`);
  } catch(e) {
    console.error('[DISALLOWWORD] Erreur:', e.message);
    sendChat(`@${username} Erreur lors de la suppression.`);
  }
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

async function moderateUser(username, kickId, action, duration, word) {
  const { token, official } = await getActiveToken();
  if (!token) { console.log(`[MOD] Simulation: ${action} ${username} pour "${word}"`); return false; }

  // Récupérer l'ID numérique Kick du viewer si on ne l'a pas déjà (requis par l'API officielle)
  let userId = kickId;
  if (!userId) {
    const viewer = await db.getViewer(username);
    userId = viewer?.kick_user_id || null;
  }

  if (official && userId) {
    // broadcaster_user_id = ID UTILISATEUR de fack7up (différent de l'ID channel CONFIG.channelId)
    const storedBroadcasterId = await db.getSettingStr('broadcaster_user_id', '');
    const broadcasterId = parseInt(storedBroadcasterId) || parseInt(CONFIG.channelId);
    const userIdInt = parseInt(userId);
    if (!broadcasterId || !userIdInt) {
      console.error(`[MOD] IDs invalides — broadcasterId=${broadcasterId} userId=${userIdInt} (broadcaster_user_id stocké="${storedBroadcasterId}", channelId brut="${CONFIG.channelId}", userId brut="${userId}") — passage au fallback legacy`);
    } else {
      try {
        const durationMinutes = action === 'ban' ? undefined : Math.max(1, Math.round((duration || 300) / 60));
        const body = {
          broadcaster_user_id: broadcasterId,
          user_id: userIdInt,
          reason: word || 'Modération automatique',
        };
        if (durationMinutes) body.duration = durationMinutes;

        console.log('[MOD DEBUG] Body envoyé:', JSON.stringify(body));

        // Diagnostic : vérifier qui est réellement authentifié avec ce token
        try {
          const whoami = await axios.get('https://api.kick.com/public/v1/users',
            { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
          console.log('[MOD DEBUG] Identité du token (whoami):', JSON.stringify(whoami.data));
        } catch(whoamiErr) {
          console.log('[MOD DEBUG] whoami a échoué:', whoamiErr.response?.status, JSON.stringify(whoamiErr.response?.data));
        }

        await axios.post(
          `https://api.kick.com/public/v1/moderation/bans`,
          body,
          { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }
        );
        console.log(`[MOD] ${username} ${action === 'ban' ? 'banni' : `timeout ${duration}s`} (API officielle) pour "${word}"`);
        return true;
      } catch(err) {
        console.error('[MOD] Erreur API officielle — status:', err.response?.status,
          '| data:', JSON.stringify(err.response?.data),
          '| headers:', JSON.stringify(err.response?.headers));
        if (!CONFIG.token) return false;
        console.log('[MOD] Tentative via endpoint legacy...');
      }
    }
  }

  // Fallback : ancien endpoint interne (token manuel uniquement — l'API officielle
  // OAuth se fait bloquer par Cloudflare sur cet endpoint legacy, donc on ne l'utilise
  // qu'avec un vrai token de session manuel).
  if (!CONFIG.token) {
    console.log('[MOD] Pas de fallback disponible (pas de token manuel configuré) — action ignorée.');
    return false;
  }
  try {
    const legacyBody = action === 'ban'
      ? { banned_username: username, permanent: true }
      : { banned_username: username, duration: duration || 300, permanent: false };
    await axios.post(
      `https://kick.com/api/v2/channels/${CONFIG.channelId}/bans`,
      legacyBody,
      { headers: { 'Authorization': `Bearer ${CONFIG.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    console.log(`[MOD] ${username} ${action === 'ban' ? 'banni' : `timeout ${duration}s`} (legacy) pour "${word}"`);
    return true;
  } catch(err) {
    console.error('[MOD] Erreur modération (legacy):', err.response?.data || err.message);
    return false;
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
  return sendChatVia(message, token, official, false);
}

async function sendChatVia(message, token, official, isRetry) {
  try {
    let response;
    if (official) {
      // API officielle Kick — endpoint public
      response = await axios.post(
        `https://api.kick.com/public/v1/chat`,
        { content: message, type: 'bot', broadcaster_user_id: parseInt(CONFIG.channelId) },
        { headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'en-US',
        }}
      );
    } else {
      // Ancien endpoint interne (token manuel, fallback legacy)
      response = await axios.post(
        `https://kick.com/api/v2/messages/send/${CONFIG.channelId}`,
        { content: message, type: 'message' },
        { headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'en-US',
          'User-Agent': 'Mozilla/5.0',
        }}
      );
    }
    console.log(`[BOT] Message envoyé (${response.status}) via ${official ? 'OAuth officiel' : 'token manuel'}${isRetry ? ' (retry)' : ''}`);
    db.setBotStatus('token_expired', '0').catch(()=>{});
  } catch(err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    console.error(`[BOT] Erreur envoi (${status || 'réseau'}):`, typeof body === 'string' ? body : JSON.stringify(body) || err.message);
    console.error(`[BOT] Message qui a échoué (longueur ${message.length}):`, JSON.stringify(message));

    // L'API officielle Kick peut renvoyer un 500 de façon erratique (bug connu côté Kick,
    // pas forcément lié au contenu du message). On bascule vers le token legacy si dispo,
    // sans jamais relancer plus d'une fois pour éviter une boucle infinie.
    if (status === 500 && official && !isRetry && CONFIG.token) {
      console.log('[BOT] 500 sur API officielle → tentative via token manuel (fallback)...');
      return sendChatVia(message, CONFIG.token, false, true);
    }

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
    } else if (status === 403) {
      console.warn(`[AUTH] 403 Forbidden — ${official ? 'le scope chat:write est probablement manquant sur ton app Kick, ou le compte connecté n\u2019est pas modérateur/streamer du salon' : 'le compte du bot n\u2019est probablement pas modérateur de la chaîne'}`);
      db.setBotStatus('last_403_at', Date.now().toString()).catch(()=>{});
    }
  }
}

// ─── Live check ───────────────────────────────────────────────────────────────

async function fetchKickChannelOfficial() {
  try {
    // Diagnostic OAuth complet
    const configured = kickOAuth.isConfigured();
    const storedToken = await db.getOAuthToken('kick');
    console.log(`[OAUTH DEBUG] isConfigured=${configured} | token en DB=${!!storedToken} | expires_at=${storedToken?.expires_at} | now=${Date.now()}`);

    const { token, official } = await getActiveToken();
    if (!token || !official) {
      console.log('[STREAM] Token OAuth absent ou expiré → se reconnecter dans Paramètres → Connexion Kick');
      return null;
    }

    const res = await axios.get(
      `https://api.kick.com/public/v1/channels`,
      {
        params: { slug: CONFIG.channel },
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 8000,
      }
    );
    const channel = res.data?.data?.[0];
    if (!channel) {
      console.log(`[STREAM] API officielle: aucune chaîne trouvée pour le slug "${CONFIG.channel}"`);
      return null; // null = réponse inutilisable → on essaie le fallback
    }

    const isLiveNow = !!(channel.stream && channel.stream.is_live);
    console.log(`[STREAM] API officielle OK — is_live=${isLiveNow} viewer_count=${channel.stream?.viewer_count ?? 'n/a'}`);

    // broadcaster_user_id (ID utilisateur réel de fack7up) — différent de CONFIG.channelId
    // qui est l'ID du CHANNEL. Requis pour l'API de modération officielle.
    if (channel.broadcaster_user_id) {
      db.setSettingStr('broadcaster_user_id', String(channel.broadcaster_user_id)).catch(()=>{});
    }

    // On retourne toujours un objet (même si hors ligne) pour signaler que l'API a répondu
    return {
      livestream: isLiveNow ? {
        is_live: true,
        viewer_count: channel.stream.viewer_count || 0,
      } : { is_live: false },  // ← IMPORTANT: objet explicite au lieu de null
      followers_count: channel.followers_count || 0,
      _source: 'official',
    };
  } catch(err) {
    console.log(`[STREAM] API officielle erreur: ${err.response?.status || err.message}`);
    return null; // null = erreur réseau → on essaie le fallback
  }
}

async function fetchKickChannel() {
  // Essayer l'API officielle Kick en premier (pas bloquée par Cloudflare)
  const official = await fetchKickChannelOfficial();
  if (official) return official;

  // Repli sur l'ancienne API interne (souvent bloquée par Cloudflare depuis Render)
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

// Synchronise l'UUID de la VOD courante et le titre du stream depuis le navigateur.
// Nécessaire car l'API officielle Kick (api.kick.com/public/v1/channels) ne fournit
// pas ces champs — seule l'API interne (lue par le navigateur) les expose.
async function syncVodMetadataFromBrowser() {
  try {
    const PORT = parseInt(process.env.PANEL_PORT || '3000');
    const r = await axios.get(`http://localhost:${PORT}/api/live`, { timeout: 3000 });
    if (r.data?.live) {
      if (r.data.vodUuid)     await db.setSettingStr('current_vod_uuid', r.data.vodUuid);
      if (r.data.streamTitle) await db.setSettingStr('current_stream_title', r.data.streamTitle);
    }
  } catch(e) { /* panel pas encore prêt ou hors ligne — pas grave, on retentera au prochain cycle */ }
}

async function checkLiveStatus() {
  try {
  } catch(e) {
    console.error('[STREAM] Erreur checkLiveStatus (ignorée):', e.message);
  }
}
async function syncVodMetadataFromBrowser() {
  try {
    const PORT = parseInt(process.env.PANEL_PORT || '3000');
    const r = await axios.get(`http://localhost:${PORT}/api/live`, { timeout: 3000 });
    if (r.data?.live) {
      if (r.data.vodUuid)     await db.setSettingStr('current_vod_uuid', r.data.vodUuid);
      if (r.data.streamTitle) await db.setSettingStr('current_stream_title', r.data.streamTitle);
    }
  } catch(e) { /* panel pas encore prêt ou hors ligne — pas grave, on retentera au prochain cycle */ }
}

async function checkLiveStatus() {
  const data = await fetchKickChannel();
  db.setBotStatus('last_live_check_at', Date.now().toString()).catch(()=>{});

  // Quelle que soit la source qui détermine is_live (API officielle ou fallback),
  // l'API officielle Kick ne fournit pas l'UUID de la VOD — on le récupère toujours
  // depuis le navigateur (qui le lit en scrappant l'API interne kick.com/api/v2).
  syncVodMetadataFromBrowser().catch(()=>{});

  if (!data) {
    // API Kick bloquée par Cloudflare depuis Render — on lit le statut live
    // depuis le panel (qui le reçoit du navigateur toutes les 30s)
    try {
      const PORT = parseInt(process.env.PANEL_PORT || '3000');
      const r = await axios.get(`http://localhost:${PORT}/api/live`, { timeout: 3000 });
      if (r.data && typeof r.data.live === 'boolean') {
        const liveNow = r.data.live;
        const wasLive = isLive;
        isLive = liveNow;
        db.setBotStatus('last_live_check_source', 'browser_relay').catch(()=>{});
        db.setBotStatus('is_live', isLive ? '1' : '0').catch(()=>{});
        console.log(`[STREAM] Statut via navigateur → is_live=${isLive}`);
        if (isLive) {
          // Corriger streamStartTime si on a la vraie date Kick
          if (r.data.streamStartedAt && !streamStartTime) {
            streamStartTime = r.data.streamStartedAt;
            db.setBotStatus('stream_started_at', streamStartTime.toString()).catch(()=>{});
          }
        }
        if (isLive && !wasLive) {
          streamStartTime = r.data.streamStartedAt || Date.now();
          db.setBotStatus('stream_started_at', streamStartTime.toString()).catch(()=>{});
          if (!currentSessionId) startSession();
          startAnnouncements();
          startPointsTracker();
        } else if (!isLive && wasLive) {
          if (currentSessionId) {
            const dur = sessionStart ? Math.floor((Date.now()-sessionStart)/60000) : 0;
            db.endSession(currentSessionId, peakViewers, dur);
            currentSessionId = null;
          }
          if (pointsInterval) { clearInterval(pointsInterval); pointsInterval = null; }
        }
        return isLive;
      }
    } catch(e) { /* panel pas encore prêt */ }

    console.log('[STREAM] Impossible de vérifier le statut live — statut conservé:', isLive ? 'LIVE' : 'OFF');
    db.setBotStatus('last_live_check_source', 'failed').catch(()=>{});
    db.setBotStatus('is_live', isLive ? '1' : '0').catch(()=>{});
    return isLive;
  }

  const live = data?.livestream;
  const wasLive = isLive;
  isLive = !!(live?.is_live);
  db.setBotStatus('is_live', isLive ? '1' : '0').catch(()=>{});
  db.setBotStatus('last_live_check_source', data._source || 'unknown').catch(()=>{});

  if (isLive && !wasLive) {
    console.log('[STREAM] Stream démarré !');
    streamStartTime = Date.now();
    db.setBotStatus('stream_started_at', streamStartTime.toString()).catch(()=>{});
    // Sauvegarder titre et UUID du stream pour les clips marqués depuis le chat
    const title = data?.session_title || data?.livestream?.session_title || 'Stream';
    const vodUuid = data?.video?.uuid || data?.livestream?.video?.uuid || '';
    db.setSettingStr('current_stream_title', title).catch(()=>{});
    db.setSettingStr('current_vod_uuid', vodUuid).catch(()=>{});
    if (!currentSessionId) startSession();
    startAnnouncements();
    startPointsTracker(); // ← déclencher le tracker dès la détection du live
  } else if (!isLive && wasLive) {
    console.log('[STREAM] Stream terminé.');
    if (currentSessionId) {
      const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
      db.endSession(currentSessionId, peakViewers, dur);
      currentSessionId = null;
    }
  }

  if (isLive && live?.viewer_count > peakViewers) peakViewers = live.viewer_count;
  if (isLive && currentSessionId && typeof live?.viewer_count === 'number') {
    db.recordViewerSample(currentSessionId, live.viewer_count).catch(()=>{});
  }

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
  if (pointsInterval) {
    clearInterval(pointsInterval);
    pointsInterval = null;
  }
  console.log(`[POINTS] ▶ Tracker démarré — +${CONFIG.pointsAmount} pts toutes les ${CONFIG.intervalMs/60000} min — isLive=${isLive}`);
  // Premier check dans 30s pour ne pas attendre tout l'intervalle
  setTimeout(() => {
    console.log(`[POINTS] Premier check — isLive=${isLive}`);
    distributePoints();
  }, 30000);
  pointsInterval = setInterval(distributePoints, CONFIG.intervalMs);
}

// Relit la config points depuis le panel (DB) — permet de changer montant/intervalle
// sans redéployer. Si l'intervalle a changé, le tracker est relancé avec la nouvelle valeur.
async function syncPointsConfig() {
  try {
    const cfg = await db.getPointsConfig();
    const newAmount   = cfg.points_amount    ? parseInt(cfg.points_amount)    : CONFIG.pointsAmount;
    const newInterval = cfg.interval_minutes ? parseInt(cfg.interval_minutes) * 60000 : CONFIG.intervalMs;

    const intervalChanged = newInterval !== CONFIG.intervalMs;
    CONFIG.pointsAmount = newAmount;
    CONFIG.intervalMs   = newInterval;

    if (intervalChanged) {
      console.log(`[POINTS] Intervalle mis à jour depuis le panel → ${newInterval/60000} min`);
      startPointsTracker();
    }
  } catch(e) { /* la DB n'est pas dispo, on garde les valeurs actuelles */ }
}

async function distributePoints() {
  try {
    if (!isLive) return;
    if (!await db.getSetting('points_enabled')) return;
    const windowMinutes = Math.ceil(CONFIG.intervalMs / 60000) + 1;
    const viewers = await db.getActiveViewers(windowMinutes);
    console.log(`[POINTS] Fenêtre active: ${windowMinutes} min — ${viewers.length} viewer(s)`);
    if (!viewers.length) return;
    for (const v of viewers) {
      await db.addPoints(v.username, CONFIG.pointsAmount, 'watch_time', Math.round(CONFIG.intervalMs / 60000));
    }
    console.log(`[POINTS] ✅ +${CONFIG.pointsAmount} pts → ${viewers.length} viewer(s)`);
    checkObjectives();
  } catch(e) {
    // Erreur réseau temporaire (ex: Turso 502) — on absorbe sans planter le bot.
    // Le prochain cycle de distribution se fera normalement dans ${CONFIG.intervalMs/60000} minutes.
    console.error('[POINTS] Erreur temporaire (ignorée, prochaine tentative au prochain cycle):', e.message);
  }
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

module.exports = {
  sendChat,
  setIsLive: (val) => {
    const was = isLive;
    isLive = !!val;
    db.setBotStatus('is_live', isLive ? '1' : '0').catch(()=>{});
    if (isLive && !was) {
      console.log('[BOT] setIsLive → LIVE (via webhook panel)');
      if (!currentSessionId) startSession();
      startAnnouncements();
      startPointsTracker();
    } else if (!isLive && was) {
      console.log('[BOT] setIsLive → HORS LIGNE (via webhook panel)');
      if (currentSessionId) {
        const dur = sessionStart ? Math.floor((Date.now() - sessionStart) / 60000) : 0;
        db.endSession(currentSessionId, peakViewers, dur);
        currentSessionId = null;
      }
      if (pointsInterval) { clearInterval(pointsInterval); pointsInterval = null; }
    }
  },
};
