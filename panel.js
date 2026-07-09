require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { Server } = require('socket.io');
const axios   = require('axios');
const db      = require('./database');
const kickOAuth = require('./kick-oauth');
const shared = require('./shared');

const app    = express();
const PORT   = parseInt(process.env.PANEL_PORT || '3000');
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) { next(); }

// Init DB avant de démarrer
let dbReady = false;
db.ensureInit().then(async () => {
  const owner = process.env.PANEL_OWNER || '';
  if (owner) {
    try {
      await db.requestAccess(owner);
      await db.approveAccess(owner, 'admin');
      console.log(`[PANEL] Propriétaire auto-approuvé : ${owner}`);
    } catch(e) {}
  }
  dbReady = true;
  console.log('[PANEL] DB prête ✓');
  // Servir les fichiers statiques seulement après init
  app.use(express.static(path.join(__dirname, 'public')));
}).catch(err => {
  console.error('[PANEL] Erreur init DB:', err);
  // Démarrer quand même sans DB
  app.use(express.static(path.join(__dirname, 'public')));
});

// Middleware : attendre que la DB soit prête
function waitDB(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Base de données en cours de chargement, réessaie dans 5 secondes' });
  next();
}

// ── API lecture ───────────────────────────────────────────────────────────────

async function getLeaderboardIgnoredUsers() {
  try {
    const raw = await db.getSettingStr('leaderboard_ignored_users', 'BotRix,botrix');
    return String(raw || '')
      .split(/[\n,;]+/)
      .map(v => v.trim().replace(/^@+/, '').toLowerCase())
      .filter(Boolean);
  } catch(e) { return ['botrix']; }
}
function filterLeaderboardUsers(rows, ignored) {
  const block = new Set((ignored || []).map(v => String(v || '').trim().replace(/^@+/, '').toLowerCase()).filter(Boolean));
  return (Array.isArray(rows) ? rows : []).filter(v => !block.has(String(v.username || '').trim().replace(/^@+/, '').toLowerCase()));
}
app.get('/api/leaderboard',    waitDB,    async (req,res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit||10),100);
    const ignored = await getLeaderboardIgnoredUsers();
    const rawRows = await db.getLeaderboard(Math.max(limit + ignored.length + 50, limit));
    const data = filterLeaderboardUsers(rawRows, ignored)
      .slice(0, limit)
      .map((v, i) => ({ ...v, original_rank: v.rank, rank: i + 1 }));
    res.json({data});
  } catch(e){res.json({data:[]}); }
});
app.get('/api/leaderboard/config', waitDB, async (req, res) => {
  try { res.json({ data: { ignoredUsers: (await db.getSettingStr('leaderboard_ignored_users', 'BotRix,botrix')) || '' } }); }
  catch(e) { res.json({ data: { ignoredUsers: 'BotRix,botrix' } }); }
});
app.post('/api/admin/leaderboard/config', requireAuth, waitDB, async (req, res) => {
  try {
    const ignoredUsers = String(req.body?.ignoredUsers || '')
      .split(/[\n,;]+/)
      .map(v => v.trim().replace(/^@+/, ''))
      .filter(Boolean)
      .join(',');
    await db.setSettingStr('leaderboard_ignored_users', ignoredUsers);
    res.json({ success: true, ignoredUsers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/viewer/:u',      waitDB,      async (req,res) => { try { const v=await db.getViewer(req.params.u); if(!v) return res.status(404).json({error:'Introuvable'}); res.json({data:{...v,rank:await db.getViewerRank(req.params.u)}}); } catch(e){res.status(500).json({error:e.message}); }});
app.get('/api/stats',          waitDB,          async (req,res) => { try { res.json({data: await db.getGlobalStats()}); } catch(e){res.json({data:{}}); }});
app.get('/api/logs',           waitDB,           async (req,res) => { try { res.json({data: await db.getRecentLogs(Math.min(parseInt(req.query.limit||50),500))}); } catch(e){res.json({data:[]}); }});
app.get('/api/active',         async (req,res) => { try { res.json({data: await db.getActiveViewers(parseInt(req.query.minutes||10))}); } catch(e){res.json({data:[]}); }});
// ── VODs & Moments ─────────────────────────────────────────────────────────────
// Note: l'API Kick VODs est appelée directement depuis le navigateur du panel
// (côté client) pour éviter le blocage Cloudflare sur les IPs de datacenters.
// Le serveur gère uniquement le CRUD des moments marqués.

// Expose le slug de la chaîne au client pour les appels directs vers Kick
app.get('/api/channel-info', (req, res) => {
  res.json({ channel: process.env.KICK_CHANNEL || 'fack7up' });
});

// ── Follow Announce ────────────────────────────────────────────────────────────

const DEFAULT_FOLLOW_MSG = 'Merci pour le follow @{username} ! Bienvenue dans la communauté 🎉';

app.get('/api/follow-announce', async (req, res) => {
  try {
    const enabled = await db.getSetting('follow_announce_enabled');
    const message = await db.getSettingStr('follow_announce_message', DEFAULT_FOLLOW_MSG);
    res.json({ enabled, message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/follow-announce', async (req, res) => {
  try {
    const { enabled, message } = req.body;
    if (typeof enabled === 'boolean') await db.setSetting('follow_announce_enabled', enabled);
    if (typeof message === 'string' && message.trim()) {
      await db.setSettingStr('follow_announce_message', message.trim());
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Sub Announce ───────────────────────────────────────────────────────────────

const DEFAULT_SUB_NEW_MSG   = '🎉 Merci pour le sub @{username} ! Bienvenue dans les subs 🔥';
const DEFAULT_SUB_RENEW_MSG = '🔄 @{username} renouvelle son sub pour {months} mois, merci ! ❤️';
const DEFAULT_SUB_GIFT_MSG  = '🎁 @{gifter} offre {count} sub(s) à la communauté, incroyable !';

const SUB_COUNTER_DEFAULTS = {
  total: 0,
  session: 0,
  renewals: 0,
  gifts: 0,
  target: 50,
  label: 'Sub Goal',
  textPosition: 'inside',
  countPosition: 'inside',
  progressDisplay: 'count',
  textAlign: 'center',
  latest: []
};

async function getSubCounterState() {
  const latestRaw = await db.getSettingStr('subcounter_latest', '[]');
  let latest = [];
  try { latest = JSON.parse(latestRaw); } catch(e) { latest = []; }
  return {
    total: parseInt(await db.getSettingStr('subcounter_total', await db.getSettingStr('subgoal_current', '0'))) || 0,
    session: parseInt(await db.getSettingStr('subcounter_session', '0')) || 0,
    renewals: parseInt(await db.getSettingStr('subcounter_renewals', '0')) || 0,
    gifts: parseInt(await db.getSettingStr('subcounter_gifts', '0')) || 0,
    target: parseInt(await db.getSettingStr('subgoal_target', '50')) || 50,
    label: await db.getSettingStr('subgoal_label', 'Sub Goal'),
    textPosition: await db.getSettingStr('subgoal_text_position', 'inside'),
    countPosition: await db.getSettingStr('subgoal_count_position', 'inside'),
    progressDisplay: await db.getSettingStr('subgoal_progress_display', 'count'),
    textAlign: await db.getSettingStr('subgoal_text_align', 'center'),
    latest: Array.isArray(latest) ? latest.slice(0, 12) : []
  };
}

async function emitSubCounterState() {
  const state = await getSubCounterState();
  io.emit('subcounter-update', state);
  io.emit('subgoal-update', { current: state.total, target: state.target, label: state.label, textPosition: state.textPosition, countPosition: state.countPosition, progressDisplay: state.progressDisplay, textAlign: state.textAlign });
  return state;
}

async function recordSubEvent(type, payload = {}) {
  try {
    const state = await getSubCounterState();
    const amount = Math.max(1, parseInt(payload.count || 1) || 1);
    const event = {
      type,
      username: payload.username || payload.gifter || 'Anonyme',
      gifter: payload.gifter || null,
      count: amount,
      months: payload.months || null,
      at: new Date().toISOString()
    };

    if (type === 'new' || type === 'gift') {
      state.total += amount;
      state.session += amount;
    }
    if (type === 'gift') state.gifts += amount;
    if (type === 'renewal') {
      // Un renouvellement ne change pas forcément le nombre de subs actifs,
      // mais il doit bien compter dans les subs de la session live.
      state.session += amount;
      state.renewals += amount;
    }

    state.latest = [event, ...state.latest].slice(0, 12);
    await db.setSettingStr('subcounter_total', String(state.total));
    await db.setSettingStr('subcounter_session', String(state.session));
    await db.setSettingStr('subcounter_renewals', String(state.renewals));
    await db.setSettingStr('subcounter_gifts', String(state.gifts));
    await db.setSettingStr('subgoal_current', String(state.total));
    await db.setSettingStr('subcounter_latest', JSON.stringify(state.latest));
    io.emit('subcounter-update', state);
    io.emit('subgoal-update', { current: state.total, target: state.target, label: state.label, textPosition: state.textPosition, countPosition: state.countPosition, progressDisplay: state.progressDisplay, textAlign: state.textAlign });
    console.log(`[SUBCOUNTER] Update ${type} → total=${state.total} session=${state.session} gifts=${state.gifts} renewals=${state.renewals}`);
    return state;
  } catch(e) { console.error('[SUBCOUNTER] Erreur event:', e.message); }
}

// ── Traitement commun events Kick : webhook + websocket bot ────────────────────

const processedKickEvents = new Map();
function cleanupProcessedKickEvents() {
  const now = Date.now();
  for (const [key, ts] of processedKickEvents.entries()) {
    if (now - ts > 10 * 60 * 1000) processedKickEvents.delete(key);
  }
}
function pick(...values) {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
}
function normalizeKickEventType(type = '') {
  const raw = String(type || '');
  const t = raw.toLowerCase();
  if (t.includes('follow')) return 'channel.followed';

  // API officielle Kick EventSub + anciens noms possibles des events Pusher.
  // Sources officielles/community listent notamment : channel.subscription.new,
  // channel.subscription.renewal, channel.subscription.gifts.
  if (t.includes('subscription.gift') || t.includes('giftedsubscription') || t.includes('gifted_subscription') || t.includes('subgift') || (t.includes('gift') && t.includes('sub'))) return 'channel.subscription.gifts';
  if (t.includes('subscription.renew') || t.includes('subrenew') || t.includes('resub') || t.includes('re-sub') || (t.includes('renew') && t.includes('sub'))) return 'channel.subscription.renewal';
  if (t.includes('subscription.new') || t.includes('subscriptioncreated') || t.includes('subscription_created') || t.includes('subscribed') || t.includes('subscription') || t.includes('subscribe') || t.includes('sub')) return 'channel.subscription.new';
  return raw;
}
function parsePayloadSafe(payload = {}) {
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return {}; }
  }
  return payload || {};
}
function getPayloadData(payload = {}) {
  const root = parsePayloadSafe(payload);
  // Kick peut envoyer les infos dans plusieurs formats selon webhook / websocket.
  // On garde root en fallback pour ne pas perdre les champs event/type/id.
  return root?.data || root?.event?.data || root?.payload?.data || root?.body?.data || root?.subscription || root || {};
}
function eventDedupeKey(eventType, payload = {}) {
  const root = parsePayloadSafe(payload);
  const data = getPayloadData(root);
  return pick(root?.id, root?.event_id, data?.id, data?.event_id, data?.subscription?.id, data?.message?.id, data?.created_at)
    || `${eventType}:${JSON.stringify(data).slice(0, 300)}`;
}
function extractSubInfo(payload = {}) {
  const root = parsePayloadSafe(payload);
  const data = getPayloadData(root);
  const sub = data?.subscription || data?.subscriber || data?.sub || root?.subscription || {};
  const user = data?.subscriber || data?.user || data?.recipient || data?.viewer || sub?.user || root?.user || {};
  const gifter = data?.gifter || data?.sender || data?.user || root?.gifter || {};
  const username = pick(
    data?.subscriber?.username, data?.subscriber?.name,
    data?.recipient?.username, data?.recipient?.name,
    sub?.username, sub?.name,
    user?.username, user?.name,
    data?.username, data?.name,
    root?.username, root?.name
  ) || 'quelqu\'un';
  const gifterName = pick(gifter?.username, gifter?.name, data?.gifter_username, data?.gifter_name, root?.gifter_username, root?.gifter_name) || username;
  const count = parseInt(data?.count || data?.amount || data?.quantity || data?.total || root?.count || root?.amount || 1) || 1;
  const months = parseInt(data?.duration || data?.months || data?.month || sub?.months || sub?.duration || root?.months || 1) || 1;
  return { username, gifter: gifterName, count: Math.max(1, count), months };
}
async function sendAnnouncementToChat(message, logLabel) {
  if (!message) return false;
  if (!shared.hasSendChat()) {
    console.warn(`[ANNONCE CHAT] Impossible d'envoyer (${logLabel}) : bot.js n'a pas encore enregistré sendChat. Lance bien npm start/server.js dans un seul process.`);
    return false;
  }
  try {
    await shared.sendChat(message);
    console.log(`[ANNONCE CHAT] Envoyé : ${logLabel}`);
    return true;
  } catch (e) {
    console.error(`[ANNONCE CHAT] Erreur ${logLabel}:`, e.message);
    return false;
  }
}
async function processKickEvent(eventTypeRaw, payload = {}) {
  const eventType = normalizeKickEventType(eventTypeRaw || payload?.event || payload?.type || '');
  const data = getPayloadData(payload);
  const dedupe = eventDedupeKey(eventType, payload);
  cleanupProcessedKickEvents();
  if (processedKickEvents.has(dedupe)) return { ok: true, duplicate: true, eventType };
  processedKickEvents.set(dedupe, Date.now());

  if (eventType === 'channel.followed') {
    const username = pick(
      data?.user?.username, data?.follower?.username, data?.username,
      data?.user?.name, data?.follower?.name,
      payload?.user?.username, payload?.username
    ) || 'quelqu\'un';

    const enabled = await db.getSetting('follow_announce_enabled');
    // Synchronise aussi l'ancien réglage utilisé par le tracker followers de bot.js
    await db.setSetting('follow_alerts', enabled).catch(()=>{});
    await pushObsAlert('follow', { username }).catch(e=>console.warn('[ALERT OBS] follow ignorée:', e.message));
    if (enabled) {
      const template = await db.getSettingStr('follow_announce_message', DEFAULT_FOLLOW_MSG);
      const message = template.replace(/\{username\}/gi, username).replace(/@\s*@/g, '@');
      await sendAnnouncementToChat(message, `FOLLOW ${username}`);
    }
    return { ok: true, eventType, username };
  }

  if (eventType === 'channel.subscription.new') {
    const info = extractSubInfo(payload);
    await recordSubEvent('new', { username: info.username, count: 1 });
    await pushObsAlert('sub', { username: info.username }).catch(e=>console.warn('[ALERT OBS] sub ignorée:', e.message));
    const enabled = await db.getSetting('sub_announce_enabled');
    if (enabled) {
      const template = await db.getSettingStr('sub_announce_new', DEFAULT_SUB_NEW_MSG);
      const message = template.replace(/\{username\}/gi, info.username);
      await sendAnnouncementToChat(message, `SUB NEW ${info.username}`);
    }
    return { ok: true, eventType, username: info.username };
  }

  if (eventType === 'channel.subscription.renewal') {
    const info = extractSubInfo(payload);
    await recordSubEvent('renewal', { username: info.username, months: info.months });
    await pushObsAlert('renew', { username: info.username, months: info.months }).catch(e=>console.warn('[ALERT OBS] renew ignorée:', e.message));
    const enabled = await db.getSetting('sub_announce_enabled');
    if (enabled) {
      const template = await db.getSettingStr('sub_announce_renew', DEFAULT_SUB_RENEW_MSG);
      const message = template.replace(/\{username\}/gi, info.username).replace(/\{months\}/gi, String(info.months));
      await sendAnnouncementToChat(message, `SUB RENEW ${info.username} x${info.months}`);
    }
    return { ok: true, eventType, username: info.username, months: info.months };
  }

  if (eventType === 'channel.subscription.gifts') {
    const isAnon = !!(data?.gifter?.is_anonymous || data?.is_anonymous);
    const gifterRaw = pick(data?.gifter?.username, data?.user?.username, data?.username, data?.gifter?.name, data?.user?.name);
    const gifter = isAnon ? 'un anonyme' : (gifterRaw || 'Anonyme');
    const count = parseInt(data?.count || data?.gift_count || data?.giftees?.length || data?.recipients?.length || 1) || 1;
    await recordSubEvent('gift', { gifter, count });
    await pushObsAlert('gift', { gifter, count }).catch(e=>console.warn('[ALERT OBS] gift ignorée:', e.message));
    const enabled = await db.getSetting('sub_announce_enabled');
    if (enabled) {
      const template = await db.getSettingStr('sub_announce_gift', DEFAULT_SUB_GIFT_MSG);
      const message = template.replace(/\{gifter\}/gi, gifter).replace(/\{count\}/gi, String(count));
      await sendAnnouncementToChat(message, `SUB GIFT ${gifter} x${count}`);
    }
    return { ok: true, eventType, gifter, count };
  }

  return { ok: true, ignored: true, eventType };
}

shared.registerKickEventHandler(processKickEvent);

// Webhook officiel Kick — reçu à chaque nouveau follow/sub
// À configurer sur : kick.com/settings/developer → Event Subscriptions
// URL à renseigner : https://TON-LIEN-RENDER/webhook/kick
app.post('/webhook/kick', async (req, res) => {
  try {
    const event = req.body || {};
    const eventType = req.headers['kick-event-type'] || event?.event || event?.type || '';
    console.log('[WEBHOOK KICK]', eventType, JSON.stringify(event).slice(0, 300));
    const result = await processKickEvent(eventType, event);
    res.json(result);
  } catch(e) {
    console.error('[WEBHOOK KICK] Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Proxy de téléchargement — récupère le .mp4 depuis les CDN Kick et le renvoie
// au navigateur avec Content-Disposition: attachment pour forcer le téléchargement.
// Nécessaire car les CDN Kick bloquent le téléchargement direct depuis un navigateur
// (header CORS manquant / politique de référent).
app.get('/api/proxy-download', async (req, res) => {
  const url      = req.query.url;
  const filename = (req.query.filename || 'clip.mp4').replace(/[^a-zA-Z0-9_.-]/g, '_');

  if (!url) return res.status(400).json({ error: 'url requis' });

  // Sécurité : n'autoriser que les domaines Kick
  const allowedHosts = ['kick.com', 'clips.kick.com', 'cdn.kick.com',
                        'cloudfront.net', 'akamaized.net', 'fastly.net', 'amazonaws.com'];
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) { return res.status(400).json({ error: 'URL invalide' }); }
  const hostOk = allowedHosts.some(h => parsedUrl.hostname.endsWith(h));
  if (!hostOk) return res.status(403).json({ error: 'Domaine non autorisé: ' + parsedUrl.hostname });

  const { spawn } = require('child_process');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpFile = path.join(os.tmpdir(), `kick_clip_${Date.now()}.mp4`);

  console.log(`[PROXY DL] Conversion m3u8→mp4: ${url.slice(0, 80)}`);

  // FFmpeg : lit le m3u8 HLS et copie les streams directement en MP4 (pas de re-encodage)
  const ffmpeg = spawn('ffmpeg', [
    '-i', url,
    '-c', 'copy',           // copie sans re-encodage — ultra rapide, ~1s pour 30s de clip
    '-bsf:a', 'aac_adtstoasc',  // correction format audio pour MP4
    '-movflags', 'faststart',    // MP4 optimisé pour lecture immédiate
    '-y',                   // écraser si existe
    tmpFile
  ]);

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', d => { ffmpegErr += d.toString(); });

  ffmpeg.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(tmpFile)) {
      console.error('[PROXY DL] FFmpeg erreur (code', code, '):', ffmpegErr.slice(-300));
      if (!res.headersSent) res.status(500).json({ error: 'Conversion échouée', code });
      return;
    }

    const stat = fs.statSync(tmpFile);
    console.log(`[PROXY DL] Converti: ${stat.size} bytes → ${filename}`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(tmpFile, () => {}); // nettoyage après envoi
    });
    stream.on('error', (e) => {
      console.error('[PROXY DL] Stream error:', e.message);
      fs.unlink(tmpFile, () => {});
    });
  });

  // Timeout de sécurité : tuer FFmpeg après 60s
  setTimeout(() => {
    try { ffmpeg.kill('SIGKILL'); } catch(e) {}
    try { fs.unlink(tmpFile, () => {}); } catch(e) {}
    if (!res.headersSent) res.status(504).json({ error: 'Timeout conversion' });
  }, 60000);
});

// CRUD moments
app.get('/api/vod-moments',       async (req,res) => { try { res.json({data: await db.getVodMoments(req.query.vod_id||null)}); } catch(e){res.json({data:[]});} });
app.get('/api/vod-moments/pending', async (req,res) => { try { res.json({data: await db.getPendingLiveMoments()}); } catch(e){res.json({data:[]});} });
app.post('/api/admin/vod-moments/link', async (req,res) => {
  try {
    const { id, vodId, vodUrl } = req.body;
    await db.linkMomentToVod(id, vodId, vodUrl);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/vod-moments', async (req,res) => {
  try {
    const { vodId, vodTitle, vodUrl, timestampS, label, category } = req.body;
    if (!vodId) return res.status(400).json({ error: 'vodId requis' });
    await db.addVodMoment(vodId, vodTitle, vodUrl, timestampS, label, category, 'Toi (panel)');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/vod-moments/:id', async (req,res) => {
  try { await db.updateVodMomentLabel(req.params.id, req.body.label, req.body.category); res.json({success:true}); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/vod-moments/:id', async (req,res) => {
  try { await db.deleteVodMoment(req.params.id); res.json({success:true}); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/commands',  async (req,res) => { try { res.json({data: await db.getCommandUsageStats(7)}); } catch(e) { res.json({data:[]}); }});
app.get('/api/analytics/fidelity',  async (req,res) => { try { res.json({data: await db.getFidelityLeaderboard(50)}); } catch(e) { res.json({data:[]}); }});
app.get('/api/analytics/heatmap',   async (req,res) => { try { res.json({data: await db.getChatHeatmap()}); } catch(e) { res.json({data:{}}); }});
app.get('/api/viewer/:username/firstseen', async (req,res) => { try { res.json({data: await db.getViewerFirstSeen(req.params.username)}); } catch(e) { res.json({data:null}); }});

// Le navigateur envoie les dates de follow qu'il récupère via l'API interne Kick
// (bloquée depuis Render par Cloudflare, mais accessible depuis un navigateur)
app.post('/api/viewer/following-since', async (req, res) => {
  try {
    const { username, followingSince, subscribedFor } = req.body;
    if (!username) return res.status(400).json({ error: 'username requis' });
    await db.setViewerFollowingSince(username, followingSince || null, subscribedFor ?? null);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Liste des viewers actifs sans date de follow connue — le navigateur les résout
app.get('/api/viewers/missing-follow', async (req, res) => {
  try {
    const rows = await db.getDB().execute(
      `SELECT username FROM viewers WHERE (following_since IS NULL OR subscribed_for IS NULL) AND last_seen >= datetime('now', '-2 hours') ORDER BY last_seen DESC LIMIT 10`
    );
    res.json({ data: rows.rows.map(r => r.username) });
  } catch(e) { res.json({ data: [] }); }
});
app.get('/api/analytics/chat-week', async (req,res) => { try { res.json({data: await db.getChatActivityWeek()}); } catch(e) { res.json({data:[]}); }});
app.get('/api/analytics/sessions-viewers', async (req,res) => { try { res.json({data: await db.getSessionsWithAvgViewers(14)}); } catch(e) { res.json({data:[]}); }});

function levelImageKey(name) {
  return String(name || '').trim().toLowerCase();
}
async function getLevelImagesMap() {
  try {
    const raw = await db.getSettingStr('leaderboard_level_images', '{}');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch(e) { return {}; }
}
async function saveLevelImage(name, imageUrl) {
  const map = await getLevelImagesMap();
  const key = levelImageKey(name);
  if (!key) return;
  const clean = String(imageUrl || '').trim();
  if (clean) map[key] = clean.slice(0, 2_500_000);
  else delete map[key];
  await db.setSettingStr('leaderboard_level_images', JSON.stringify(map));
}
async function getLevelsWithImages() {
  const [levels, images] = await Promise.all([db.getLevels(), getLevelImagesMap()]);
  return (levels || []).map(l => ({ ...l, imageUrl: images[levelImageKey(l.name)] || '' }));
}

app.get('/api/levels', async (req,res) => { try { res.json({data: await getLevelsWithImages()}); } catch(e) { res.json({data:[]}); }});

app.post('/api/admin/levels', async (req, res) => {
  try {
    const { name, min, emoji, imageUrl } = req.body;
    if (!name || min === undefined) return res.status(400).json({ error: 'name et min requis' });
    await db.addLevel(name, parseInt(min), emoji || '⭐');
    await saveLevelImage(name, imageUrl || '');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/levels/:id', async (req, res) => {
  try {
    const { name, min, emoji, imageUrl } = req.body;
    if (!name || min === undefined) return res.status(400).json({ error: 'name et min requis' });
    await db.updateLevel(req.params.id, name, parseInt(min), emoji || '⭐');
    await saveLevelImage(name, imageUrl || '');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/levels/:id', async (req, res) => {
  try { await db.deleteLevel(req.params.id); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/commands',       waitDB,       async (req,res) => { try { res.json({data: await db.getCustomCommands()}); } catch(e){res.json({data:[]}); }});
app.get('/api/objectives',     waitDB,     async (req,res) => { try { res.json({data: await db.getObjectives()}); } catch(e){res.json({data:[]}); }});
app.get('/api/history',        async (req,res) => { try { res.json({data: await db.getStreamHistory(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/duels',          async (req,res) => { try { res.json({data: await db.getRecentDuels(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/giveaways',      async (req,res) => { try { res.json({data: await db.getGiveawayHistory(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/giveaway/active',async (req,res) => { try { res.json({data: await db.getActiveGiveaway()}); } catch(e){res.json({data:null}); }});
app.get('/api/lobby',          waitDB,          async (req,res) => { try { res.json({data: await db.getLobby()}); } catch(e){res.json({data:[]}); }});

// ── Auth panel ────────────────────────────────────────────────────────────────
app.get('/api/auth/request', async (req, res) => {
  const { username, password } = req.query;
  if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Pseudo invalide' });
  const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
  if (PANEL_PASSWORD && password !== PANEL_PASSWORD) return res.status(401).json({ error: 'wrong_password' });
  try {
    const status = await db.getAccessStatus(username.trim());
    if (status?.status === 'approved') return res.json({ status: 'approved', role: status.role });
    if (status?.status === 'revoked')  return res.json({ status: 'revoked' });
    await db.requestAccess(username.trim());
    await db.approveAccess(username.trim(), 'viewer');
    res.json({ status: 'approved', role: 'viewer' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/check', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username requis' });
  try {
    const status = await db.getAccessStatus(username.trim());
    if (!status) return res.json({ status: 'unknown' });
    res.json({ status: status.status, role: status.role });
  } catch(e) { res.json({ status: 'unknown' }); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/points',     requireAuth, async (req,res) => { try { const {username,points,reason}=req.body; if(!username||typeof points!=='number') return res.status(400).json({error:'requis'}); await db.upsertViewer(username); await db.addPoints(username,points,reason||'admin_manual'); res.json({success:true,data:await db.getViewer(username)}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/reset',      requireAuth, async (req,res) => { try { const {username}=req.body; if(!username) return res.status(400).json({error:'requis'}); await db.addPoints(username,-999999,'admin_reset'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/clear-all',  requireAuth, async (req,res) => { try { await db.clearAllPoints(); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/commands',   requireAuth, async (req,res) => { try { const {trigger,response,mentionUser}=req.body; if(!trigger||!response) return res.status(400).json({error:'requis'}); await db.setCustomCommand(trigger,response, mentionUser ? 1 : 0); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/commands/toggle', requireAuth, async (req,res) => { try { const {trigger,enabled}=req.body; await db.toggleCustomCommand(trigger,enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/commands/:trigger', requireAuth, async (req,res) => { try { await db.deleteCustomCommand(req.params.trigger); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/objectives',      requireAuth, async (req,res) => { try { const {title,description,target,reward}=req.body; if(!title||!target) return res.status(400).json({error:'requis'}); await db.createObjective(title,description,target,reward); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/objectives/:id',requireAuth, async (req,res) => { try { await db.deleteObjective(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/giveaway/start',  requireAuth, async (req,res) => { try { const {title,prize,cost}=req.body; if(!title||!prize) return res.status(400).json({error:'requis'}); const id=await db.createGiveaway(title,prize,cost||0); res.json({success:true,id}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/giveaway/close',  requireAuth, async (req,res) => { try { const g=await db.getActiveGiveaway(); if(!g) return res.status(404).json({error:'Aucun giveaway'}); const winner=await db.closeGiveaway(g.id); res.json({success:true,winner}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/lobby/remove', async (req,res) => { try { await db.removeFromLobby(req.body.username); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/lobby/clear',  async (req,res) => { try { await db.clearLobby(); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.get('/api/admin/access',           requireAuth, async (req,res) => { try { res.json({data: await db.getAllAccessRequests()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/access/approve',  requireAuth, async (req,res) => { try { await db.approveAccess(req.body.username,req.body.role||'viewer'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/access/revoke',   requireAuth, async (req,res) => { try { await db.revokeAccess(req.body.username); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/access/:username', requireAuth, async (req,res) => { try { await db.deleteAccessRequest(req.params.username); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.get('/api/system-commands', async (req,res) => { try { res.json({data: await db.getAllSystemCommandsState()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/system-commands/toggle', requireAuth, async (req,res) => { try { const {trigger,enabled}=req.body; if(!trigger) return res.status(400).json({error:'trigger requis'}); await db.toggleSystemCommand(trigger, enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Quotes
app.get('/api/quotes',              async (req,res) => { try { res.json({data: await db.getQuotes()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/quotes',       async (req,res) => { try { const {text,author}=req.body; if(!text) return res.status(400).json({error:'text requis'}); const id=await db.addQuote(text,author,'admin'); res.json({success:true,id}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/quotes/:id', async (req,res) => { try { await db.deleteQuote(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Counters
app.get('/api/counters',                    async (req,res) => { try { res.json({data: await db.getCounters()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/counters',             async (req,res) => { try { const {name,value}=req.body; if(!name) return res.status(400).json({error:'name requis'}); await db.setCounter(name,value||0); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/counters/:name',     async (req,res) => { try { await db.deleteCounter(req.params.name); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Timers
app.get('/api/timers',                    async (req,res) => { try { res.json({data: await db.getTimers()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/timers',             async (req,res) => { try { const {name,message,interval_ms}=req.body; if(!name||!message) return res.status(400).json({error:'requis'}); await db.setTimer(name,message,interval_ms||300000); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/timers/toggle',      async (req,res) => { try { await db.toggleTimer(req.body.name,req.body.enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/timers/:name',     async (req,res) => { try { await db.deleteTimer(req.params.name); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Queue
app.get('/api/queue',                  async (req,res) => { try { res.json({data: await db.getQueue()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/queue/remove',    async (req,res) => { try { await db.removeFromQueue(req.body.username); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/queue/clear',     async (req,res) => { try { await db.clearQueue(); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Polls
app.get('/api/polls',                   async (req,res) => { try { res.json({data: await db.getPolls()}); } catch(e){res.json({data:[]}); }});
app.get('/api/polls/active',            async (req,res) => { try { res.json({data: await db.getActivePoll()}); } catch(e){res.json({data:null}); }});
app.post('/api/admin/polls',            async (req,res) => { try { const {question,options}=req.body; if(!question||!options?.length) return res.status(400).json({error:'requis'}); const id=await db.createPoll(question,options); res.json({success:true,id}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/polls/close',      async (req,res) => { try { const p=await db.getActivePoll(); if(!p) return res.status(404).json({error:'Aucun sondage'}); const r=await db.closePoll(p.id); res.json({success:true,data:r}); } catch(e){res.status(500).json({error:e.message}); }});

// Announcements
app.get('/api/announcements',                   async (req,res) => { try { res.json({data: await db.getAnnouncements()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/announcements',            async (req,res) => { try { const {message,interval_ms}=req.body; if(!message) return res.status(400).json({error:'requis'}); const id=await db.addAnnouncement(message,interval_ms||600000); res.json({success:true,id}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/announcements/toggle',     async (req,res) => { try { await db.toggleAnnouncement(req.body.id,req.body.enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/announcements/:id',      async (req,res) => { try { await db.deleteAnnouncement(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Banned words
app.get('/api/banned-words',           async (req,res) => { try { res.json({data: await db.getBannedWords()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/banned-words',    requireAuth, async (req,res) => { try { const {word,action,duration}=req.body; if(!word) return res.status(400).json({error:'mot requis'}); await db.addBannedWord(word,action||'timeout',duration||300); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/banned-words/:id', requireAuth, async (req,res) => { try { await db.deleteBannedWord(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/banned-words/toggle', requireAuth, async (req,res) => { try { const {id,enabled}=req.body; await db.toggleBannedWord(id,enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

app.get('/api/allowed-words',            async (req,res) => { try { res.json({data: await db.getAllowedWords()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/allowed-words',     requireAuth, async (req,res) => { try { const {word,note}=req.body; if(!word) return res.status(400).json({error:'mot requis'}); await db.addAllowedWord(word,note||''); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/allowed-words/:id', requireAuth, async (req,res) => { try { await db.deleteAllowedWord(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// ─── 🩸 Les 30 Coffres de l'Entité ────────────────────────────────────────────
const chests = require('./chests');

// Annonce un résultat d'ouverture dans le chat + overlay
async function broadcastChestResult(result) {
  const chatEnabled = await db.getSetting('chests_chat_enabled');
  if (chatEnabled) {
    const shared = require('./shared');
    const moneyStr = result.money > 0 && ['positive','epic','legendary'].includes(result.tier) ? ` (${result.money}€)` : '';
    let msg = `🧰 COFFRE ${result.number} → ${result.tierEmoji} ${result.tierName} : ${result.label}${moneyStr}`;
    try { await shared.sendChat(msg); } catch(e) {}
    for (const ev of result.events || []) {
      try { await shared.sendChat(ev); } catch(e) {}
    }
    if (result.seasonEnd) {
      const s = result.seasonEnd;
      try { await shared.sendChat(`🩸 SAISON TERMINÉE — ${s.bonuses} bonus, ${s.maluses} malus, ${s.jackpots} jackpot(s), ${s.challengesDone}/${s.challengesTotal} défis réussis, ${s.money}€ gagnés !`); } catch(e) {}
    }
  }
  io.emit('chest-opened', result);
  io.emit('chests-update');
}

app.get('/api/widgets/subgoal', async (req, res) => {
  try {
    const state = await getSubCounterState();
    res.json({ current: state.total, target: state.target, label: state.label, textPosition: state.textPosition, countPosition: state.countPosition, progressDisplay: state.progressDisplay, textAlign: state.textAlign });
  } catch(e) { res.json({ current: 0, target: 50, label: 'Sub Goal', textPosition: 'inside', countPosition: 'inside', progressDisplay: 'count', textAlign: 'center' }); }
});

app.get('/api/widgets/subcounter', async (req, res) => {
  try { res.json(await getSubCounterState()); }
  catch(e) { res.json(SUB_COUNTER_DEFAULTS); }
});

app.post('/api/admin/widgets/subcounter/test', requireAuth, async (req, res) => {
  try {
    const type = ['new','gift','renewal'].includes(req.body.type) ? req.body.type : 'new';
    const username = String(req.body.username || 'TestSub').slice(0, 40);
    const count = Math.max(1, parseInt(req.body.count || 1) || 1);
    const months = Math.max(1, parseInt(req.body.months || 1) || 1);
    const state = await recordSubEvent(type, { username, gifter: username, count, months });
    res.json({ success: true, state });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subcounter/total', requireAuth, async (req, res) => {
  try {
    const total = Math.max(0, parseInt(req.body.total) || 0);
    await db.setSettingStr('subcounter_total', String(total));
    await db.setSettingStr('subgoal_current', String(total));
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subcounter/session/reset', requireAuth, async (req, res) => {
  try {
    await db.setSettingStr('subcounter_session', '0');
    await db.setSettingStr('subcounter_renewals', '0');
    await db.setSettingStr('subcounter_gifts', '0');
    await db.setSettingStr('subcounter_latest', '[]');
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/admin/widgets/subgoal/label', requireAuth, async (req, res) => {
  try {
    const label = String(req.body.label || 'Sub Goal').trim().slice(0, 40) || 'Sub Goal';
    await db.setSettingStr('subgoal_label', label);
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/admin/widgets/subgoal/layout', requireAuth, async (req, res) => {
  try {
    const allowedTextPositions = ['above','inside','hidden'];
    const allowedCountPositions = ['above','inside','right','hidden'];
    const allowedDisplays = ['count','progress','percent','hidden'];
    const allowedAligns = ['left','center','right'];
    const textPosition = allowedTextPositions.includes(req.body.textPosition) ? req.body.textPosition : 'inside';
    const countPosition = allowedCountPositions.includes(req.body.countPosition) ? req.body.countPosition : 'inside';
    const progressDisplay = allowedDisplays.includes(req.body.progressDisplay) ? req.body.progressDisplay : 'count';
    const textAlign = allowedAligns.includes(req.body.textAlign) ? req.body.textAlign : 'center';
    await db.setSettingStr('subgoal_text_position', textPosition);
    await db.setSettingStr('subgoal_count_position', countPosition);
    await db.setSettingStr('subgoal_progress_display', progressDisplay);
    await db.setSettingStr('subgoal_text_align', textAlign);
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subgoal/target', requireAuth, async (req, res) => {
  try {
    const target = Math.max(1, parseInt(req.body.target) || 50);
    await db.setSettingStr('subgoal_target', String(target));
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/subgoal/adjust', requireAuth, async (req, res) => {
  try {
    const delta = parseInt(req.body.delta) || 0;
    const state = await getSubCounterState();
    const total = Math.max(0, state.total + delta);
    await db.setSettingStr('subcounter_total', String(total));
    await db.setSettingStr('subgoal_current', String(total));
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/subgoal/reset', requireAuth, async (req, res) => {
  try {
    await db.setSettingStr('subcounter_total', '0');
    await db.setSettingStr('subgoal_current', '0');
    res.json({ success: true, ...(await emitSubCounterState()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Song Request ──────────────────────────────────────────────────────────────
function extractYouTubeId(input) {
  const raw = String(input || '');
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/watch\?[^\s]*v=([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/live\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/v\/([A-Za-z0-9_-]{6,})/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return '';
}
function normalizeYouTubeUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}
function htmlEntityDecode(str = '') {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function parseDurationTextToSeconds(text = '') {
  const parts = String(text || '').split(':').map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
  if (!parts.length) return 0;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
async function fetchYouTubeOEmbed(videoId) {
  if (!videoId) return {};
  try {
    const { data } = await axios.get('https://www.youtube.com/oembed', {
      params: { url: normalizeYouTubeUrl(videoId), format: 'json' },
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return {
      title: data?.title || '',
      author: data?.author_name || '',
      thumbnail: data?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  } catch(e) {
    return { thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` };
  }
}
async function searchYouTubeFirst(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const { data: html } = await axios.get('https://www.youtube.com/results', {
      params: { search_query: q },
      timeout: 9000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
      }
    });
    const ids = [...String(html).matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
    const videoId = ids.find((id, idx) => ids.indexOf(id) === idx);
    if (!videoId) return null;

    let title = q;
    let author = '';
    let durationText = '';
    const idx = String(html).indexOf(`"videoId":"${videoId}"`);
    const around = idx >= 0 ? String(html).slice(Math.max(0, idx - 2000), idx + 6000) : String(html);
    const titleMatch = around.match(/"title":\{"runs":\[\{"text":"([^"]+)"/) || around.match(/"title":\{"simpleText":"([^"]+)"/);
    if (titleMatch) title = htmlEntityDecode(titleMatch[1]);
    const ownerMatch = around.match(/"ownerText":\{"runs":\[\{"text":"([^"]+)"/) || around.match(/"longBylineText":\{"runs":\[\{"text":"([^"]+)"/);
    if (ownerMatch) author = htmlEntityDecode(ownerMatch[1]);
    const durMatch = around.match(/"lengthText":\{"accessibility":\{"accessibilityData":\{"label":"[^"]+"\}\},"simpleText":"([^"]+)"/) || around.match(/"lengthText":\{"simpleText":"([^"]+)"/);
    if (durMatch) durationText = durMatch[1];

    const embed = await fetchYouTubeOEmbed(videoId);
    return {
      videoId,
      url: normalizeYouTubeUrl(videoId),
      title: embed.title || title || q,
      author: embed.author || author || '',
      thumbnail: embed.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationText,
      duration: parseDurationTextToSeconds(durationText)
    };
  } catch(e) {
    console.warn('[SONGREQUEST] Recherche YouTube impossible:', e.message);
    return null;
  }
}
async function resolveSongRequest(song) {
  const raw = String(song || '').trim().slice(0, 300);
  if (!raw) return { song: '', url: '', videoId: '' };
  const urlMatch = raw.match(/https?:\/\/[^\s]+/i);
  const url = urlMatch ? urlMatch[0] : '';
  const directId = extractYouTubeId(url || raw);
  if (directId) {
    const meta = await fetchYouTubeOEmbed(directId);
    return {
      song: meta.title || raw,
      query: raw,
      url: normalizeYouTubeUrl(directId),
      videoId: directId,
      title: meta.title || raw,
      author: meta.author || '',
      thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
      duration: 0,
      durationText: ''
    };
  }
  const found = await searchYouTubeFirst(raw);
  if (found) return { song: found.title || raw, query: raw, ...found };
  return { song: raw, query: raw, url: '', videoId: '', title: raw, author: '', thumbnail: '', duration: 0, durationText: '' };
}
async function getSongRequestPlayerState() {
  let state = {};
  try { state = JSON.parse(await db.getSettingStr('songrequest_player_state', '{}')); } catch(e) { state = {}; }
  return {
    itemId: state.itemId || '',
    status: state.status || 'stopped',
    currentTime: Number(state.currentTime || 0),
    duration: Number(state.duration || 0),
    volume: Math.max(0, Math.min(100, parseInt(state.volume ?? 100) || 100)),
    updatedAt: state.updatedAt || null
  };
}
async function saveSongRequestPlayerState(patch = {}, emit = true) {
  const prev = await getSongRequestPlayerState();
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  await db.setSettingStr('songrequest_player_state', JSON.stringify(next));
  if (emit) io.emit('songrequest-player-state', next);
  return next;
}

async function getSongRequestControl() {
  let control = {};
  try { control = JSON.parse(await db.getSettingStr('songrequest_control', '{}')); } catch(e) { control = {}; }
  return {
    seq: Number(control.seq || 0),
    action: control.action || '',
    seconds: Number(control.seconds || 0),
    volume: Number(control.volume ?? 100),
    at: control.at || null
  };
}
async function issueSongRequestControl(action, payload = {}) {
  const prev = await getSongRequestControl();
  const control = {
    seq: prev.seq + 1,
    action,
    ...payload,
    at: new Date().toISOString()
  };
  await db.setSettingStr('songrequest_control', JSON.stringify(control));
  io.emit('songrequest-control', control);
  return control;
}

async function getSongRequestState() {
  let queue = [];
  try { queue = JSON.parse(await db.getSettingStr('songrequest_queue', '[]')); } catch(e) { queue = []; }
  queue = Array.isArray(queue) ? queue : [];
  const player = await getSongRequestPlayerState();
  const currentItem = queue[0] || null;
  // Sécurité anti état fantôme : si la file est vide, le panel ne doit jamais afficher PLAYING.
  if (!currentItem) {
    player.itemId = '';
    player.status = 'stopped';
    player.currentTime = 0;
    player.duration = 0;
  } else if (player.itemId && player.itemId !== currentItem.id) {
    // Si le lecteur OBS remonte un ancien item, on garde la file comme vérité.
    player.itemId = currentItem.id;
    player.currentTime = 0;
    player.duration = currentItem.duration || 0;
    if (player.status === 'stopped') player.status = 'playing';
  } else if (!player.itemId) {
    player.itemId = currentItem.id;
  }
  return {
    enabled: await db.getSetting('songrequest_enabled'),
    command: await db.getSettingStr('songrequest_command', '!sr'),
    confirmMessage: await db.getSettingStr('songrequest_confirm', '🎵 @{username}, ta musique a été ajoutée à la file !'),
    chatConfirmEnabled: (await db.getSettingStr('songrequest_chat_confirm_enabled', '0')) === '1',
    maxQueue: parseInt(await db.getSettingStr('songrequest_max_queue', '30')) || 30,
    queue,
    player,
    control: await getSongRequestControl()
  };
}

async function saveSongRequestQueue(queue) {
  const clean = Array.isArray(queue) ? queue.slice(0, 100) : [];
  await db.setSettingStr('songrequest_queue', JSON.stringify(clean));
  if (!clean.length) {
    await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 }, false);
  }
  io.emit('songrequest-update', { queue: clean });
  return clean;
}

async function addSongRequest(username, song) {
  const state = await getSongRequestState();
  const data = await resolveSongRequest(song);
  if (!data.song) throw new Error('Musique requise');
  if (state.queue.length >= state.maxQueue) throw new Error('File pleine');
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    username: String(username || 'Anonyme').slice(0,60),
    song: data.song,
    query: data.query || song,
    title: data.title || data.song,
    author: data.author || '',
    url: data.url || '',
    videoId: data.videoId || extractYouTubeId(data.url || data.song),
    thumbnail: data.thumbnail || (data.videoId ? `https://i.ytimg.com/vi/${data.videoId}/hqdefault.jpg` : ''),
    duration: data.duration || 0,
    durationText: data.durationText || '',
    status: 'queued',
    at: new Date().toISOString()
  };
  state.queue.push(item);
  await saveSongRequestQueue(state.queue);
  console.log(`[SONGREQUEST] Ajouté: ${item.title || item.song} (${item.videoId || 'sans vidéo'})`);
  return item;
}

try {
  shared.registerSongRequestAdder(async (username, song) => {
    const item = await addSongRequest(username, song);
    return { ok: true, item };
  });
  console.log('[SONGREQUEST] Pont panel/bot enregistré ✓');
} catch(e) {
  console.warn("[SONGREQUEST] Impossible d'enregistrer le pont panel/bot:", e.message);
}

app.get('/api/widgets/songrequest', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try { res.json(await getSongRequestState()); }
  catch(e) { res.json({ enabled:false, command:'!sr', confirmMessage:'', maxQueue:30, queue:[], player:{status:'stopped'} }); }
});

app.post('/api/admin/widgets/songrequest/settings', requireAuth, async (req, res) => {
  try {
    if (typeof req.body.enabled === 'boolean') await db.setSetting('songrequest_enabled', req.body.enabled);
    if (typeof req.body.command === 'string') {
      let command = req.body.command.trim().slice(0,20) || '!sr';
      if (!command.startsWith('!')) command = '!' + command;
      await db.setSettingStr('songrequest_command', command.toLowerCase());
    }
    if (typeof req.body.confirmMessage === 'string') await db.setSettingStr('songrequest_confirm', req.body.confirmMessage.trim().slice(0,180));
    if (typeof req.body.chatConfirmEnabled === 'boolean') await db.setSettingStr('songrequest_chat_confirm_enabled', req.body.chatConfirmEnabled ? '1' : '0');
    if (req.body.maxQueue !== undefined) await db.setSettingStr('songrequest_max_queue', String(Math.min(100, Math.max(1, parseInt(req.body.maxQueue) || 30))));
    res.json({ success:true, ...(await getSongRequestState()) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/add', requireAuth, async (req, res) => {
  try { const item = await addSongRequest(req.body.username || 'Streamer', req.body.song || ''); res.json({ success:true, item, ...(await getSongRequestState()) }); }
  catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/delete', requireAuth, async (req, res) => {
  try {
    const state = await getSongRequestState();
    const id = req.body.id;
    const wasCurrent = state.queue[0]?.id === id;
    await saveSongRequestQueue(state.queue.filter(x => x.id !== id));
    if (wasCurrent) await issueSongRequestControl('load-current');
    res.json({ success:true, ...(await getSongRequestState()) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});


app.post('/api/widgets/songrequest/next', async (req, res) => {
  try {
    const state = await getSongRequestState();
    state.queue.shift();
    await saveSongRequestQueue(state.queue);
    await saveSongRequestPlayerState({ itemId: state.queue[0]?.id || '', status: state.queue[0] ? 'playing' : 'stopped', currentTime: 0, duration: state.queue[0]?.duration || 0 });
    await issueSongRequestControl('next');
    res.json({ success:true, ...(await getSongRequestState()) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/next', requireAuth, async (req, res) => {
  try {
    const state = await getSongRequestState();
    state.queue.shift();
    await saveSongRequestQueue(state.queue);
    await saveSongRequestPlayerState({ itemId: state.queue[0]?.id || '', status: state.queue[0] ? 'playing' : 'stopped', currentTime: 0, duration: state.queue[0]?.duration || 0 });
    await issueSongRequestControl('next');
    res.json({ success:true, ...(await getSongRequestState()) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/clear', requireAuth, async (req, res) => {
  try {
    await saveSongRequestQueue([]);
    await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 });
    await issueSongRequestControl('stop');
    res.json({ success:true, ...(await getSongRequestState()) });
  }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/play', requireAuth, async (req, res) => {
  try {
    const state = await getSongRequestState();
    const cur = state.queue[0];
    const next = await saveSongRequestPlayerState({ itemId: cur?.id || '', status: cur ? 'playing' : 'stopped' });
    await issueSongRequestControl('play');
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/pause', requireAuth, async (req, res) => {
  try {
    const next = await saveSongRequestPlayerState({ status:'paused' });
    await issueSongRequestControl('pause');
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/seek', requireAuth, async (req, res) => {
  try {
    const seconds = Math.max(0, parseFloat(req.body.seconds || 0) || 0);
    const next = await saveSongRequestPlayerState({ currentTime: seconds });
    await issueSongRequestControl('seek', { seconds });
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/volume', requireAuth, async (req, res) => {
  try {
    const volume = Math.max(0, Math.min(100, parseInt(req.body.volume ?? 100) || 100));
    const next = await saveSongRequestPlayerState({ volume });
    await issueSongRequestControl('volume', { volume });
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/widgets/songrequest/player-state', async (req, res) => {
  try {
    const state = await getSongRequestState();
    const currentItem = state.queue[0] || null;
    const bodyItemId = typeof req.body.itemId === 'string' ? req.body.itemId : '';
    // Ignore les retours d'un ancien overlay/lecteur OBS, sinon il peut remettre PLAY tout seul
    // ou afficher une ancienne musique alors que la file a changé.
    if (!currentItem) {
      const next = await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 }, true);
      return res.json({ success:true, ignored:true, player: next });
    }
    if (bodyItemId && bodyItemId !== currentItem.id) {
      return res.json({ success:true, ignored:true, player: state.player });
    }
    const patch = { itemId: currentItem.id };
    if (typeof req.body.status === 'string' && ['playing','paused','stopped','buffering'].includes(req.body.status)) patch.status = req.body.status;
    if (req.body.currentTime !== undefined) patch.currentTime = Math.max(0, parseFloat(req.body.currentTime) || 0);
    if (req.body.duration !== undefined) patch.duration = Math.max(0, parseFloat(req.body.duration) || 0);
    if (req.body.volume !== undefined) patch.volume = Math.max(0, Math.min(100, parseInt(req.body.volume) || 100));
    const next = await saveSongRequestPlayerState(patch, true);
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});



async function runSongRequestMacro(action) {
  const state = await getSongRequestState();
  const cur = state.queue[0] || null;
  if (action === 'toggle') action = state.player?.status === 'playing' ? 'pause' : 'play';
  if (action === 'play') {
    const next = await saveSongRequestPlayerState({ itemId: cur?.id || '', status: cur ? 'playing' : 'stopped' });
    await issueSongRequestControl('play');
    return { action:'play', player: next };
  }
  if (action === 'pause') {
    const next = await saveSongRequestPlayerState({ status:'paused' });
    await issueSongRequestControl('pause');
    return { action:'pause', player: next };
  }
  if (action === 'next') {
    state.queue.shift();
    await saveSongRequestQueue(state.queue);
    const nextItem = state.queue[0] || null;
    const next = await saveSongRequestPlayerState({ itemId: nextItem?.id || '', status: nextItem ? 'playing' : 'stopped', currentTime: 0, duration: nextItem?.duration || 0 });
    await issueSongRequestControl('next');
    return { action:'next', player: next };
  }
  if (action === 'stop') {
    const next = await saveSongRequestPlayerState({ status:'stopped', currentTime:0 });
    await issueSongRequestControl('stop');
    return { action:'stop', player: next };
  }
  throw new Error('Action macro invalide');
}

async function songRequestMacroHandler(req, res) {
  try {
    const action = String(req.params.action || req.body?.action || 'toggle').toLowerCase();
    if (!['toggle','play','pause','next','stop'].includes(action)) return res.status(400).json({ error:'Action invalide' });
    const result = await runSongRequestMacro(action);
    res.json({ success:true, ...result, ...(await getSongRequestState()) });
  } catch(e) { res.status(500).json({ error:e.message }); }
}
app.get('/api/widgets/songrequest/macro/:action', songRequestMacroHandler);
app.post('/api/widgets/songrequest/macro/:action', songRequestMacroHandler);

app.get('/api/chests', async (req, res) => {
  try { res.json(await chests.getPublicState()); } catch(e) { res.json({ season: null, chests: [] }); }
});
app.post('/api/admin/chests/new-season', requireAuth, async (req, res) => {
  try {
    const r = await chests.newSeason();
    io.emit('chests-update');
    const shared = require('./shared');
    try { await shared.sendChat(`🩸 UNE NOUVELLE SAISON DES 30 COFFRES DE L'ENTITÉ COMMENCE ! Le contenu a été mélangé par le Brouillard…`); } catch(e) {}
    res.json({ success: true, ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chests/open', requireAuth, async (req, res) => {
  try {
    const number = parseInt(req.body.number);
    if (!number || number < 1 || number > 30) return res.status(400).json({ error: 'Numéro invalide (1-30)' });
    const result = await chests.openChest(number, 'panel');
    if (result.error) return res.status(400).json(result);
    await broadcastChestResult(result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chests/secure', requireAuth, async (req, res) => {
  try {
    const result = await chests.secureChest(parseInt(req.body.number));
    if (result.error) return res.status(400).json(result);
    io.emit('chests-update');
    const shared = require('./shared');
    if (await db.getSetting('chests_chat_enabled')) {
      if (result.moved) { try { await shared.sendChat(`🔒 La sécurité passe du coffre ${result.from ?? '?'} au coffre ${result.to} — DERNIER changement possible utilisé, plus aucune modification jusqu'à la prochaine saison !`); } catch(e) {} }
      else { try { await shared.sendChat(`🔒 Le coffre ${result.to} est maintenant SÉCURISÉ.`); } catch(e) {} }
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chests/unsecure', requireAuth, async (req, res) => {
  try {
    const result = await chests.unsecureChest();
    io.emit('chests-update');
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chests/victory', requireAuth, async (req, res) => {
  try {
    const result = await chests.markVictory();
    if (result.error) return res.status(400).json(result);
    io.emit('chests-update');
    const shared = require('./shared');
    if (await db.getSetting('chests_chat_enabled')) {
      try { await shared.sendChat(`🏆 VICTOIRE ! Le coffre sécurisé n°${result.protectedNumber} verra son contenu DOUBLÉ à l'ouverture !`); } catch(e) {}
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chests/victory/clear', requireAuth, async (req, res) => {
  try {
    const result = await chests.clearVictory();
    io.emit('chests-update');
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/chests/list', requireAuth, async (req, res) => {
  try {
    const season = await db.getActiveChestSeason();
    if (!season) return res.json({ success: true, season: null, chests: [] });
    const rows = await db.getChests(season.id);
    res.json({
      success: true,
      season: { id: season.id, num: season.season_num },
      chests: rows.map(c => ({
        number: c.number, tier: c.tier, label: c.label, money: c.money,
        fogValue: c.fog_value, opened: !!c.opened, secured: !!c.secured
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/chests/update-content', requireAuth, async (req, res) => {
  try {
    const season = await db.getActiveChestSeason();
    if (!season) return res.status(400).json({ error: 'Aucune saison active' });
    const number = parseInt(req.body.number);
    const tier = String(req.body.tier || '').trim();
    const label = String(req.body.label || '').trim();
    const money = Number(req.body.money || 0);
    const allowed = ['legendary','epic','positive','challenge','cursed','fake'];
    if (!number || number < 1 || number > 30) return res.status(400).json({ error: 'Numéro invalide' });
    if (!allowed.includes(tier)) return res.status(400).json({ error: 'Type invalide' });
    if (!label) return res.status(400).json({ error: 'Texte obligatoire' });
    const chest = await db.getChest(season.id, number);
    if (!chest) return res.status(404).json({ error: 'Coffre introuvable' });
    const fogByTier = { legendary:80, epic:50, positive:25, challenge:0, cursed:-30, fake:-60 };
    await db.updateChestContent(chest.id, tier, label, Number.isFinite(money) ? money : 0, fogByTier[tier] || 0);
    io.emit('chests-update');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/chests/challenge-done', requireAuth, async (req, res) => {
  try {
    const { number, done } = req.body;
    const season = await db.getActiveChestSeason();
    if (!season) return res.status(400).json({ error: 'Aucune saison active' });
    const chest = await db.getChest(season.id, parseInt(number));
    if (!chest) return res.status(400).json({ error: 'Coffre introuvable' });
    await db.setChestChallengeDone(chest.id, !!done);
    io.emit('chests-update');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Exposer l'ouverture au bot (commande !coffre) via shared
require('./shared').registerOpenChest(async (number) => {
  const result = await chests.openChest(number, 'chat');
  if (result.error) return result;
  await broadcastChestResult(result);
  return result;
});

// Exposer le bonus de victoire au bot (commande !victoire) via shared
require('./shared').registerMarkVictory(async () => {
  const result = await chests.markVictory();
  if (result.error) return result;
  io.emit('chests-update');
  if (await db.getSetting('chests_chat_enabled')) {
    try { await require('./shared').sendChat(`🏆 VICTOIRE ! Le coffre sécurisé n°${result.protectedNumber} verra son contenu DOUBLÉ à l'ouverture !`); } catch(e) {}
  }
  return result;
});

// Sub Counter widget : géré par recordSubEvent() + emitSubCounterState()

app.get('/api/moderation-logs', async (req,res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ data: await db.getModerationLogs(limit) });
  } catch(e) { res.json({ data: [] }); }
});
app.delete('/api/admin/moderation-logs', requireAuth, async (req,res) => {
  try { await db.clearModerationLogs(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fonction commune pour appeler l'API Kick
async function fetchKickAPI(channel) {
  const axios = require('axios');
  const urls = [
    `https://kick.com/api/v2/channels/${channel}`,
    `https://kick.com/api/v1/channels/${channel}`,
  ];
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    'Kick-Bot/1.0',
  ];
  for (const url of urls) {
    for (const ua of uas) {
      try {
        const r = await axios.get(url, {
          headers: { 'Accept':'application/json','User-Agent':ua,'Cache-Control':'no-cache' },
          timeout: 6000,
        });
        if (r.data) return r.data;
      } catch(e) {
        if (e.response?.status !== 403 && e.response?.status !== 429) break;
      }
    }
  }
  return null;
}

// Bot settings
app.get('/api/bot-settings',              async (req,res) => { try { res.json({data: await db.getAllSettings(), meta: db.DEFAULT_SETTINGS}); } catch(e){res.json({data:{},meta:{}}); }});
app.post('/api/admin/bot-settings',       async (req,res) => { try { const {key,enabled}=req.body; if(!key) return res.status(400).json({error:'key requis'}); await db.setSetting(key,enabled); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Followers
app.get('/api/followers', async (req, res) => {
  try {
    const data = await fetchKickAPI(process.env.KICK_CHANNEL||'');
    if (!data) return res.json({ count: 0 });
    const count = data?.followers_count || data?.followersCount || 0;
    res.json({ count });
  } catch(e) { res.json({ count: 0 }); }
});

// Recevoir l'état live depuis le navigateur (qui peut appeler Kick sans être bloqué)
let liveFromBrowser = { live: false, viewers: 0, followers: 0, updatedAt: null };

app.post('/api/live/update', (req, res) => {
  const { live, viewers, followers, vodUuid, streamTitle, streamStartedAt } = req.body;
  liveFromBrowser = {
    live: !!live, viewers: viewers||0, followers: followers||0,
    vodUuid: vodUuid||'', streamTitle: streamTitle||'', streamStartedAt: streamStartedAt||null,
    updatedAt: Date.now()
  };
  res.json({ success: true });
});

// Live force
let forcedLiveStatus = null;
app.post('/api/admin/live/force', requireAuth, (req,res) => { const {status}=req.body; forcedLiveStatus=status==='on'?true:status==='off'?false:null; res.json({success:true,forced:forcedLiveStatus}); });
app.get('/api/admin/live/status', requireAuth, (req,res) => res.json({forced:forcedLiveStatus}));

// Live status
app.get('/api/live', async (req,res) => {
  if (forcedLiveStatus !== null) return res.json({live:forcedLiveStatus,viewers:0,forced:true});

  // Utiliser les données du navigateur si fraîches (< 2 min)
  if (liveFromBrowser.updatedAt && Date.now() - liveFromBrowser.updatedAt < 120000) {
    return res.json({ ...liveFromBrowser, source: 'browser' });
  }

  // Sinon essayer l'API serveur
  try {
    const data = await fetchKickAPI(process.env.KICK_CHANNEL||'');
    if (!data) return res.json({ live: false, viewers: 0, error: 'api_blocked' });
    const live = data?.livestream;
    res.json({
      live: !!(live?.is_live),
      viewers: live?.viewer_count || 0,
      followers: data?.followers_count || data?.followersCount || 0,
      source: 'server',
    });
  } catch(e) { res.json({ live: false, viewers: 0 }); }
});

// ════════════════════════════════════════════════════════════════════
// TTS — Text To Speech pour les dons (100% configurable depuis le panel)
// ════════════════════════════════════════════════════════════════════

// Valeurs de secours si rien n'est configuré en DB ni en env (premier démarrage)
const TTS_DEFAULTS = {
  api_key: process.env.ELEVENLABS_API_KEY || '',
  voice_id: process.env.ELEVENLABS_VOICE_ID || '',
  min_donation: process.env.TTS_MIN_DONATION || '0',
  max_text_length: process.env.TTS_MAX_TEXT_LENGTH || '180',
  webhook_secret: process.env.TTS_WEBHOOK_SECRET || '',
  stability: '0.5',
  similarity_boost: '0.75',
  volume: '1',
};

async function getTTSSettings() {
  const stored = await db.getTTSConfig();
  const merged = { ...TTS_DEFAULTS, ...stored };
  return {
    apiKey:          merged.api_key,
    voiceId:         merged.voice_id,
    minDonation:     parseFloat(merged.min_donation) || 0,
    maxTextLength:   parseInt(merged.max_text_length) || 180,
    webhookSecret:   merged.webhook_secret,
    stability:       parseFloat(merged.stability),
    similarityBoost: parseFloat(merged.similarity_boost),
    volume:          parseFloat(merged.volume),
  };
}

async function generateTTSAudio(text) {
  const cfg = await getTTSSettings();
  if (!cfg.apiKey || !cfg.voiceId) return null;
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}`,
      { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: cfg.stability, similarity_boost: cfg.similarityBoost } },
      { headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 }
    );
    return Buffer.from(r.data).toString('base64');
  } catch(e) {
    console.error('[TTS] Erreur ElevenLabs:', e.response?.status || e.message);
    return null;
  }
}

// Webhook appelé par la plateforme de dons (StreamElements, Tipeee, etc.)
app.post('/webhook/donation', async (req, res) => {
  try {
    const cfg = await getTTSSettings();

    // Vérification du secret si configuré
    if (cfg.webhookSecret && req.headers['x-webhook-secret'] !== cfg.webhookSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const username = String(req.body.username || req.body.from || 'Anonyme');
    const amount   = parseFloat(req.body.amount || 0);
    let message    = String(req.body.message || '').trim();

    if (!await db.getSetting('tts_enabled')) {
      return res.json({ ignored: true, reason: 'tts_disabled' });
    }
    if (amount < cfg.minDonation) {
      return res.json({ ignored: true, reason: 'amount_too_low' });
    }
    if (!message) {
      return res.json({ ignored: true, reason: 'empty_message' });
    }
    if (await db.isTTSBlacklisted(message)) {
      await db.addTTSHistory(username, message, amount, 'blocked');
      io.emit('tts-update');
      return res.json({ ignored: true, reason: 'blacklisted' });
    }

    message = message.slice(0, cfg.maxTextLength);
    await db.addTTSHistory(username, message, amount, 'played');

    const audioBase64 = await generateTTSAudio(message);
    io.emit('play-tts', { username, message, amount, audio: audioBase64, volume: cfg.volume });
    io.emit('tts-update');

    res.json({ success: true });
  } catch(e) {
    console.error('[TTS] Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Test manuel depuis le panel
app.post('/api/tts/test', async (req, res) => {
  try {
    const cfg = await getTTSSettings();
    const message = String(req.body.message || '').trim().slice(0, cfg.maxTextLength);
    if (!message) return res.status(400).json({ error: 'message requis' });
    if (await db.isTTSBlacklisted(message)) return res.status(400).json({ error: 'Message bloqué par la blacklist' });

    await db.addTTSHistory('Test Panel', message, 0, 'test');
    const audioBase64 = await generateTTSAudio(message);
    io.emit('play-tts', { username: 'Test Panel', message, amount: 0, audio: audioBase64, volume: cfg.volume });
    io.emit('tts-update');
    res.json({ success: true, audioGenerated: !!audioBase64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Préécoute locale : génère l'audio et le renvoie directement au navigateur
// SANS diffuser sur l'overlay ni toucher l'historique — pour tester tranquillement.
app.post('/api/tts/preview', async (req, res) => {
  try {
    const cfg = await getTTSSettings();
    const message = String(req.body.message || '').trim().slice(0, cfg.maxTextLength);
    if (!message) return res.status(400).json({ error: 'message requis' });

    const audioBase64 = await generateTTSAudio(message);
    if (!audioBase64) return res.status(500).json({ error: 'Génération audio échouée — vérifie la clé API et la voix' });
    res.json({ success: true, audio: audioBase64 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tts/history',        async (req,res) => { try { res.json({data: await db.getTTSHistory(30)}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/tts/clear-history', async (req,res) => { try { await db.clearTTSHistory(); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

app.get('/api/tts/blacklist',                  async (req,res) => { try { res.json({data: await db.getTTSBlacklist()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/tts/blacklist',           async (req,res) => { try { const {word}=req.body; if(!word) return res.status(400).json({error:'word requis'}); const ok=await db.addTTSBlacklistWord(word); res.json({success:ok}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/tts/blacklist/:id',     async (req,res) => { try { await db.deleteTTSBlacklistWord(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Récupérer la config complète (clé API masquée pour l'affichage)
app.get('/api/tts/settings', async (req, res) => {
  try {
    const cfg = await getTTSSettings();
    res.json({
      apiKeySet: !!cfg.apiKey,
      apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0,4) + '••••••••' + cfg.apiKey.slice(-4) : '',
      voiceId: cfg.voiceId,
      minDonation: cfg.minDonation,
      maxTextLength: cfg.maxTextLength,
      webhookSecretSet: !!cfg.webhookSecret,
      stability: cfg.stability,
      similarityBoost: cfg.similarityBoost,
      volume: cfg.volume,
      configured: !!(cfg.apiKey && cfg.voiceId),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mettre à jour un ou plusieurs réglages TTS depuis le panel
app.post('/api/admin/tts/settings', async (req, res) => {
  try {
    const allowed = ['api_key','voice_id','min_donation','max_text_length','webhook_secret','stability','similarity_boost','volume'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== '') {
        updates[key] = typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key];
      }
    }
    await db.setTTSConfigBulk(updates);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lister les voix disponibles sur le compte ElevenLabs connecté
app.get('/api/tts/voices', async (req, res) => {
  try {
    const cfg = await getTTSSettings();
    if (!cfg.apiKey) return res.json({ data: [], error: 'no_api_key' });
    const key = cfg.apiKey.trim();
    console.log(`[TTS] Test clé: ${key.slice(0,6)}...${key.slice(-4)} (longueur ${key.length})`);
    const r = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      timeout: 10000,
    });
    const voices = (r.data?.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category }));
    console.log(`[TTS] ${voices.length} voix chargées ✓`);
    res.json({ data: voices });
  } catch(e) {
    console.error(`[TTS] Erreur voices: status=${e.response?.status} body=${JSON.stringify(e.response?.data)}`);
    res.json({ data: [], error: e.response?.status === 401 ? 'invalid_api_key' : e.message });
  }
});

// Tester la clé API ElevenLabs (vérifie le quota restant)
app.get('/api/tts/quota', async (req, res) => {
  try {
    const cfg = await getTTSSettings();
    if (!cfg.apiKey) return res.json({ valid: false });
    const r = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': cfg.apiKey },
      timeout: 10000,
    });
    res.json({
      valid: true,
      characterCount: r.data.character_count,
      characterLimit: r.data.character_limit,
      tier: r.data.tier,
    });
  } catch(e) {
    res.json({ valid: false, error: e.response?.status === 401 ? 'invalid_api_key' : e.message });
  }
});

app.get('/overlay', (req,res) => res.sendFile(path.join(__dirname,'public','overlay.html')));
app.get('/classement', (req,res) => res.sendFile(path.join(__dirname,'public','classement.html')));



// ════════════════════════════════════════════════════════════════════
// OAuth Kick officiel (id.kick.com) — refresh automatique du token
// ════════════════════════════════════════════════════════════════════

app.get('/auth/login', (req, res) => {
  if (!kickOAuth.isConfigured()) {
    return res.status(400).send('KICK_CLIENT_ID, KICK_CLIENT_SECRET ou KICK_REDIRECT_URI manquant dans les variables Render.');
  }
  const url = kickOAuth.getAuthorizationUrl();
  console.log('[OAUTH LOGIN] URL générée:', url);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  console.log('[OAUTH CALLBACK] Requête reçue — query:', JSON.stringify(req.query));
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      console.error('[OAUTH CALLBACK] Erreur Kick:', error, error_description);
      return res.status(400).send(`Erreur Kick: ${error} — ${error_description || ''}`);
    }
    if (!code || !state) {
      console.error('[OAUTH CALLBACK] Code ou state manquant. Query complète:', req.query);
      return res.status(400).send('Code ou state manquant.');
    }

    console.log('[OAUTH CALLBACK] Code reçu, échange en cours...');
    await kickOAuth.exchangeCodeForToken(code, state);
    console.log('[OAUTH CALLBACK] ✅ Token échangé et sauvegardé avec succès');

    res.send(`
      <html><body style="font-family:sans-serif;background:#050814;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h2 style="color:#28ff66">✅ Compte Kick connecté avec succès</h2>
          <p>Le token se rafraîchira automatiquement désormais. Tu peux fermer cette page.</p>
          <script>setTimeout(()=>window.close(), 3000)</script>
        </div>
      </body></html>
    `);
  } catch (e) {
    console.error('[OAUTH CALLBACK] ❌ Exception:', e.message, e.stack);
    res.status(500).send(`<pre style="color:red;background:#111;padding:20px;font-family:monospace">Erreur: ${e.message}\n\n${e.stack || ''}</pre>`);
  }
});

app.get('/api/oauth/status', async (req, res) => {
  try {
    const connected = await kickOAuth.isConnected();
    res.json({ configured: kickOAuth.isConfigured(), connected });
  } catch (e) { res.json({ configured: false, connected: false }); }
});

app.post('/api/admin/oauth/disconnect', async (req, res) => {
  try { await kickOAuth.disconnect(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// Config système de points (montant + intervalle, pilotable depuis le panel)
// ════════════════════════════════════════════════════════════════════

const POINTS_DEFAULTS = {
  points_amount:    process.env.POINTS_PER_INTERVAL || '10',
  interval_minutes: process.env.POINTS_INTERVAL_MS ? String(parseInt(process.env.POINTS_INTERVAL_MS) / 60000) : '5',
};

app.get('/api/points/config', async (req, res) => {
  try {
    const stored = await db.getPointsConfig();
    const merged = { ...POINTS_DEFAULTS, ...stored };
    res.json({
      pointsAmount: parseInt(merged.points_amount),
      intervalMinutes: parseInt(merged.interval_minutes),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/points/config', async (req, res) => {
  try {
    const { pointsAmount, intervalMinutes } = req.body;
    const updates = {};
    if (pointsAmount !== undefined && pointsAmount !== '') {
      const n = parseInt(pointsAmount);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: 'Montant de points invalide' });
      updates.points_amount = n;
    }
    if (intervalMinutes !== undefined && intervalMinutes !== '') {
      const n = parseInt(intervalMinutes);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: 'Intervalle invalide' });
      updates.interval_minutes = n;
    }
    await db.setPointsConfigBulk(updates);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Statut du token Kick (écrit par bot.js, lu par le panel)
app.get('/api/bot-status', async (req, res) => {
  try {
    const status = await db.getAllBotStatus();
    res.json({
      tokenExpired: status.token_expired?.value === '1',
      botStartedAt: status.bot_started_at?.value || null,
      lastUpdate: status.token_expired?.updated_at || null,
      isLive: status.is_live?.value === '1',
      streamStartedAt: status.stream_started_at?.value ? parseInt(status.stream_started_at.value) : null,
      lastLiveCheckAt: status.last_live_check_at?.value ? parseInt(status.last_live_check_at.value) : null,
      lastLiveCheckSource: status.last_live_check_source?.value || null,
    });
  } catch(e) { res.json({ tokenExpired: false }); }
});




// ── Alertes OBS ───────────────────────────────────────────────────────────────
const ALERT_TYPES = ['follow','sub','renew','gift','raid','donation','bits','custom'];
const ALERT_LABELS = {
  follow:'Follow', sub:'Abonnement', renew:'Renouvellement', gift:'Sub offerte', raid:'Raid', donation:'Don', bits:'Bits', custom:'Alerte personnalisée'
};
const ALERT_DEFAULTS = {
  follow:   { enabled:true,  title:'Nouveau follow',       message:'{username} vient de follow !', image:'', sound:'', volume:35, duration:6, animation:'fade', layout:'image_top', textTop:'#ffffff', textBottom:'#22c55e' },
  sub:      { enabled:true,  title:'Nouvel abonnement',    message:'{username} vient de s’abonner !', image:'', sound:'', volume:40, duration:7, animation:'pop', layout:'image_top', textTop:'#ffffff', textBottom:'#22c55e' },
  renew:    { enabled:true,  title:'Renouvellement',       message:'{username} est sub depuis {months} mois !', image:'', sound:'', volume:40, duration:7, animation:'pop', layout:'image_top', textTop:'#ffffff', textBottom:'#22c55e' },
  gift:     { enabled:true,  title:'Sub offerte',          message:'{gifter} offre {count} sub !', image:'', sound:'', volume:40, duration:7, animation:'pop', layout:'image_top', textTop:'#ffffff', textBottom:'#22c55e' },
  raid:     { enabled:true,  title:'Raid',                 message:'{username} raid avec {count} viewers !', image:'', sound:'', volume:45, duration:8, animation:'slide', layout:'image_left', textTop:'#ffffff', textBottom:'#38bdf8' },
  donation: { enabled:false, title:'Donation',             message:'{username} donne {amount}€ : {message}', image:'', sound:'', volume:40, duration:8, animation:'pop', layout:'image_top', textTop:'#ffffff', textBottom:'#f59e0b' },
  bits:     { enabled:false, title:'Bits',                 message:'{username} envoie {amount} bits !', image:'', sound:'', volume:40, duration:7, animation:'pop', layout:'image_top', textTop:'#ffffff', textBottom:'#a78bfa' },
  custom:   { enabled:true,  title:'Alerte personnalisée', message:'Alerte test pour {username}', image:'', sound:'', volume:35, duration:6, animation:'fade', layout:'image_top', textTop:'#ffffff', textBottom:'#22c55e' }
};

function sanitizeAlertType(type) {
  const t = String(type || '').toLowerCase().trim();
  return ALERT_TYPES.includes(t) ? t : 'custom';
}
function normalizeAlertCfg(type, raw={}) {
  const d = ALERT_DEFAULTS[sanitizeAlertType(type)] || ALERT_DEFAULTS.custom;
  return {
    enabled: raw.enabled !== undefined ? !!raw.enabled : !!d.enabled,
    title: String(raw.title ?? d.title).slice(0, 80),
    message: String(raw.message ?? d.message).slice(0, 250),
    image: String(raw.image ?? d.image).slice(0, 500),
    sound: String(raw.sound ?? d.sound).slice(0, 500),
    volume: Math.min(100, Math.max(0, parseInt(raw.volume ?? d.volume) || d.volume)),
    duration: Math.min(30, Math.max(2, parseInt(raw.duration ?? d.duration) || d.duration)),
    animation: ['fade','pop','slide','zoom'].includes(String(raw.animation ?? d.animation)) ? String(raw.animation ?? d.animation) : d.animation,
    layout: ['image_top','image_left','text_only'].includes(String(raw.layout ?? d.layout)) ? String(raw.layout ?? d.layout) : d.layout,
    textTop: /^#[0-9a-f]{6}$/i.test(String(raw.textTop ?? d.textTop)) ? String(raw.textTop ?? d.textTop) : d.textTop,
    textBottom: /^#[0-9a-f]{6}$/i.test(String(raw.textBottom ?? d.textBottom)) ? String(raw.textBottom ?? d.textBottom) : d.textBottom
  };
}
async function getAlertConfig(type) {
  type = sanitizeAlertType(type);
  const raw = await db.getSettingStr('alert_config_' + type, '');
  let parsed = {};
  if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
  return normalizeAlertCfg(type, parsed);
}
async function getAllAlertConfigs() {
  const out = {};
  for (const t of ALERT_TYPES) out[t] = await getAlertConfig(t);
  return out;
}
function fillAlertTemplate(str, vars={}) {
  return String(str || '').replace(/\{(username|months|gifter|count|amount|message)\}/gi, (_, k) => String(vars[String(k).toLowerCase()] ?? ''));
}
async function pushObsAlert(type, vars={}, force=false) {
  type = sanitizeAlertType(type);
  const cfg = await getAlertConfig(type);
  if (!force && !cfg.enabled) return { success:true, ignored:true, reason:'disabled', type };
  const payload = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type,
    label: ALERT_LABELS[type] || type,
    title: fillAlertTemplate(cfg.title, vars),
    message: fillAlertTemplate(cfg.message, vars),
    vars,
    cfg,
    createdAt: new Date().toISOString()
  };
  io.emit('alert-overlay-event', payload);
  console.log('[ALERT OBS]', type, payload.message);
  return { success:true, alert: payload };
}
function kickEventToAlertType(eventType) {
  const t = normalizeKickEventType(eventType || '');
  if (t === 'channel.followed') return 'follow';
  if (t === 'channel.subscription.new') return 'sub';
  if (t === 'channel.subscription.renewal') return 'renew';
  if (t === 'channel.subscription.gifts') return 'gift';
  if (String(eventType || '').toLowerCase().includes('raid')) return 'raid';
  return '';
}

app.get('/api/widgets/alerts', async (req, res) => {
  try { res.json({ types: ALERT_TYPES, labels: ALERT_LABELS, configs: await getAllAlertConfigs() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/alerts/:type', requireAuth, async (req, res) => {
  try {
    const type = sanitizeAlertType(req.params.type);
    const cfg = normalizeAlertCfg(type, req.body || {});
    await db.setSettingStr('alert_config_' + type, JSON.stringify(cfg));
    io.emit('alert-overlay-settings', { configs: await getAllAlertConfigs() });
    res.json({ success:true, type, cfg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/alerts/:type/test', requireAuth, async (req, res) => {
  try {
    const type = sanitizeAlertType(req.params.type);
    const vars = Object.assign({ username:'Elboy78', months:3, gifter:'TestGift', count:5, amount:'10', message:'Message test' }, req.body || {});
    res.json(await pushObsAlert(type, vars, true));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Chat Overlay OBS ──────────────────────────────────────────────────────────

const CHAT_OVERLAY_DEFAULTS = {
  enabled: true,
  hideBots: true,
  ignoredUsers: 'BotRix,botrix',
  hideCommands: true,
  showPlatformIcon: true,
  showTime: false,
  fontSize: 21,
  messageDuration: 10,
  animation: 'pop',
  design: 'glass',
  maxMessages: 8
};

async function getChatOverlaySettings() {
  return {
    enabled: (await db.getSettingStr('chat_overlay_enabled', '1')) === '1',
    hideBots: (await db.getSettingStr('chat_overlay_hide_bots', '1')) === '1',
    ignoredUsers: await db.getSettingStr('chat_overlay_ignored_users', CHAT_OVERLAY_DEFAULTS.ignoredUsers),
    hideCommands: (await db.getSettingStr('chat_overlay_hide_commands', '1')) === '1',
    showPlatformIcon: (await db.getSettingStr('chat_overlay_show_platform_icon', '1')) === '1',
    showTime: (await db.getSettingStr('chat_overlay_show_time', '0')) === '1',
    fontSize: Math.min(42, Math.max(10, parseInt(await db.getSettingStr('chat_overlay_font_size', String(CHAT_OVERLAY_DEFAULTS.fontSize))) || CHAT_OVERLAY_DEFAULTS.fontSize)),
    messageDuration: Math.min(60, Math.max(0, parseInt(await db.getSettingStr('chat_overlay_message_duration', String(CHAT_OVERLAY_DEFAULTS.messageDuration))) || CHAT_OVERLAY_DEFAULTS.messageDuration)),
    animation: await db.getSettingStr('chat_overlay_animation', CHAT_OVERLAY_DEFAULTS.animation),
    design: await db.getSettingStr('chat_overlay_design', CHAT_OVERLAY_DEFAULTS.design),
    maxMessages: Math.min(30, Math.max(1, parseInt(await db.getSettingStr('chat_overlay_max_messages', String(CHAT_OVERLAY_DEFAULTS.maxMessages))) || CHAT_OVERLAY_DEFAULTS.maxMessages))
  };
}

function normalizeIgnoredUsers(raw) {
  return String(raw || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

async function emitChatOverlayMessage(msg = {}) {
  try {
    const cfg = await getChatOverlaySettings();
    const username = String(msg.username || '').trim();
    const content = String(msg.content || '').trim();
    if (!cfg.enabled || !username || !content) return false;
    const lower = username.toLowerCase();
    const ignored = normalizeIgnoredUsers(cfg.ignoredUsers);
    const badgeTypes = Array.isArray(msg.badges) ? msg.badges.map(b => String(b?.type || b?.name || '').toLowerCase()) : [];
    const looksLikeBot = /bot$/i.test(username) || lower === 'botrix' || badgeTypes.includes('bot');
    if (ignored.includes(lower)) return false;
    if (cfg.hideBots && looksLikeBot) return false;
    if (cfg.hideCommands && content.startsWith('!')) return false;
    const payload = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      username: username.slice(0, 40),
      content: content.slice(0, 500),
      platform: msg.platform || 'Kick',
      color: msg.color || '',
      at: msg.at || new Date().toISOString()
    };
    io.emit('chat-overlay-message', payload);
    return true;
  } catch(e) {
    console.warn('[CHAT OVERLAY] Message ignoré:', e.message);
    return false;
  }
}

shared.registerChatOverlayEmitter(emitChatOverlayMessage);

app.get('/api/widgets/chat-overlay', async (req, res) => {
  try { res.json(await getChatOverlaySettings()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/chat-overlay/settings', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') await db.setSettingStr('chat_overlay_enabled', b.enabled ? '1' : '0');
    if (typeof b.hideBots === 'boolean') await db.setSettingStr('chat_overlay_hide_bots', b.hideBots ? '1' : '0');
    if (typeof b.hideCommands === 'boolean') await db.setSettingStr('chat_overlay_hide_commands', b.hideCommands ? '1' : '0');
    if (typeof b.showPlatformIcon === 'boolean') await db.setSettingStr('chat_overlay_show_platform_icon', b.showPlatformIcon ? '1' : '0');
    if (typeof b.showTime === 'boolean') await db.setSettingStr('chat_overlay_show_time', b.showTime ? '1' : '0');
    if (typeof b.ignoredUsers === 'string') await db.setSettingStr('chat_overlay_ignored_users', b.ignoredUsers.slice(0, 300));
    if (b.fontSize !== undefined) await db.setSettingStr('chat_overlay_font_size', String(Math.min(42, Math.max(10, parseInt(b.fontSize) || CHAT_OVERLAY_DEFAULTS.fontSize))));
    if (b.messageDuration !== undefined) await db.setSettingStr('chat_overlay_message_duration', String(Math.min(60, Math.max(0, parseInt(b.messageDuration) || CHAT_OVERLAY_DEFAULTS.messageDuration))));
    if (b.maxMessages !== undefined) await db.setSettingStr('chat_overlay_max_messages', String(Math.min(30, Math.max(1, parseInt(b.maxMessages) || CHAT_OVERLAY_DEFAULTS.maxMessages))));
    if (typeof b.animation === 'string') await db.setSettingStr('chat_overlay_animation', b.animation.slice(0, 30));
    if (typeof b.design === 'string') await db.setSettingStr('chat_overlay_design', b.design.slice(0, 30));
    const cfg = await getChatOverlaySettings();
    io.emit('chat-overlay-settings', cfg);
    res.json({ success: true, settings: cfg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/chat-overlay/test', requireAuth, async (req, res) => {
  try {
    await emitChatOverlayMessage({ username: 'TestChat', content: req.body?.message || 'Message test overlay chat ✨', platform: 'Kick', at: new Date().toISOString() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

io.on('connection', (socket) => {
  console.log('[TTS] Overlay connecté:', socket.id);
});

app.get('/login', (req,res) => res.sendFile(path.join(__dirname,'public','login.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║  Panel Web → http://localhost:${PORT}      ║`);
  console.log(`╚════════════════════════════════════════╝`);
});
