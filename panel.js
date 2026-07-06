require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { Server } = require('socket.io');
const axios   = require('axios');
const db      = require('./database');
const kickOAuth = require('./kick-oauth');

const app    = express();
const PORT   = parseInt(process.env.PANEL_PORT || '3000');
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

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
app.get('/api/leaderboard',    waitDB,    async (req,res) => { try { res.json({data: await db.getLeaderboard(Math.min(parseInt(req.query.limit||10),100))}); } catch(e){res.json({data:[]}); }});
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

app.get('/api/sub-announce', async (req, res) => {
  try {
    res.json({
      enabled:     await db.getSetting('sub_announce_enabled'),
      message_new:   await db.getSettingStr('sub_announce_new',   DEFAULT_SUB_NEW_MSG),
      message_renew: await db.getSettingStr('sub_announce_renew', DEFAULT_SUB_RENEW_MSG),
      message_gift:  await db.getSettingStr('sub_announce_gift',  DEFAULT_SUB_GIFT_MSG),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/sub-announce', async (req, res) => {
  try {
    const { enabled, message_new, message_renew, message_gift } = req.body;
    if (typeof enabled === 'boolean') await db.setSetting('sub_announce_enabled', enabled);
    if (typeof message_new   === 'string' && message_new.trim())   await db.setSettingStr('sub_announce_new',   message_new.trim());
    if (typeof message_renew === 'string' && message_renew.trim()) await db.setSettingStr('sub_announce_renew', message_renew.trim());
    if (typeof message_gift  === 'string' && message_gift.trim())  await db.setSettingStr('sub_announce_gift',  message_gift.trim());
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Webhook officiel Kick — reçu à chaque nouveau follow
// À configurer sur : kick.com/settings/developer → Event Subscriptions → channel.followed
// URL à renseigner : https://kick-bot-agkk.onrender.com/webhook/kick
app.post('/webhook/kick', async (req, res) => {
  try {
    // Kick signe les webhooks avec un header — on accepte tous pour l'instant
    const event = req.body;
    // L'event type est dans le header Kick-Event-Type OU dans le body
    const eventType = req.headers['kick-event-type'] || event?.event || event?.type || '';
    console.log('[WEBHOOK KICK]', eventType, JSON.stringify(event).slice(0, 200));

    const shared = require('./shared');

    // ── Follow ──────────────────────────────────────────────────────────────────
    if (eventType === 'channel.followed' || eventType === 'ChannelFollowed') {
      const username = event?.data?.user?.username
                    || event?.data?.follower?.username
                    || event?.data?.username
                    || 'quelqu\'un';

      const enabled = await db.getSetting('follow_announce_enabled');
      if (enabled) {
        const template = await db.getSettingStr('follow_announce_message', DEFAULT_FOLLOW_MSG);
        const message  = template.replace(/\{username\}/gi, username);
        { await shared.sendChat(message); console.log(`[FOLLOW] ${username}`); }
      }
    }

    // ── Sub nouveau ─────────────────────────────────────────────────────────────
    else if (eventType === 'channel.subscription.new') {
      const username = event?.data?.subscriber?.username || 'quelqu\'un';
      const enabled  = await db.getSetting('sub_announce_enabled');
      if (enabled) {
        const template = await db.getSettingStr('sub_announce_new', DEFAULT_SUB_NEW_MSG);
        const message  = template.replace(/\{username\}/gi, username);
        { await shared.sendChat(message); console.log(`[SUB NEW] ${username}`); }
      }
    }

    // ── Sub renouvellement ──────────────────────────────────────────────────────
    else if (eventType === 'channel.subscription.renewal') {
      const username = event?.data?.subscriber?.username || 'quelqu\'un';
      const months   = event?.data?.duration || 1;
      const enabled  = await db.getSetting('sub_announce_enabled');
      if (enabled) {
        const template = await db.getSettingStr('sub_announce_renew', DEFAULT_SUB_RENEW_MSG);
        const message  = template.replace(/\{username\}/gi, username).replace(/\{months\}/gi, months);
        { await shared.sendChat(message); console.log(`[SUB RENEW] ${username} x${months}`); }
      }
    }

    // ── Sub gift ────────────────────────────────────────────────────────────────
    else if (eventType === 'channel.subscription.gifts') {
      const gifter  = event?.data?.gifter?.username || 'Anonyme';
      const isAnon  = event?.data?.gifter?.is_anonymous || false;
      const count   = event?.data?.giftees?.length || 1;
      const enabled = await db.getSetting('sub_announce_enabled');
      if (enabled) {
        const template = await db.getSettingStr('sub_announce_gift', DEFAULT_SUB_GIFT_MSG);
        const message  = template
          .replace(/\{gifter\}/gi, isAnon ? 'un anonyme' : gifter)
          .replace(/\{count\}/gi, count);
        { await shared.sendChat(message); console.log(`[SUB GIFT] ${gifter} x${count}`); }
      }
    }

    res.json({ ok: true });
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
    const { username, followingSince } = req.body;
    if (!username) return res.status(400).json({ error: 'username requis' });
    await db.setViewerFollowingSince(username, followingSince || null);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Liste des viewers actifs sans date de follow connue — le navigateur les résout
app.get('/api/viewers/missing-follow', async (req, res) => {
  try {
    const rows = await db.getDB().execute(
      `SELECT username FROM viewers WHERE following_since IS NULL AND last_seen >= datetime('now', '-2 hours') ORDER BY last_seen DESC LIMIT 10`
    );
    res.json({ data: rows.rows.map(r => r.username) });
  } catch(e) { res.json({ data: [] }); }
});
app.get('/api/analytics/chat-week', async (req,res) => { try { res.json({data: await db.getChatActivityWeek()}); } catch(e) { res.json({data:[]}); }});
app.get('/api/analytics/sessions-viewers', async (req,res) => { try { res.json({data: await db.getSessionsWithAvgViewers(14)}); } catch(e) { res.json({data:[]}); }});

app.get('/api/levels', async (req,res) => { try { res.json({data: await db.getLevels()}); } catch(e) { res.json({data:[]}); }});

app.post('/api/admin/levels', async (req, res) => {
  try {
    const { name, min, emoji } = req.body;
    if (!name || min === undefined) return res.status(400).json({ error: 'name et min requis' });
    await db.addLevel(name, parseInt(min), emoji || '⭐');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/levels/:id', async (req, res) => {
  try {
    const { name, min, emoji } = req.body;
    if (!name || min === undefined) return res.status(400).json({ error: 'name et min requis' });
    await db.updateLevel(req.params.id, name, parseInt(min), emoji || '⭐');
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
app.post('/api/admin/commands',   requireAuth, async (req,res) => { try { const {trigger,response}=req.body; if(!trigger||!response) return res.status(400).json({error:'requis'}); await db.setCustomCommand(trigger,response); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
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
      if (req.body[key] !== undefined && req.body[key] !== '') updates[key] = req.body[key];
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
    const r = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': cfg.apiKey },
      timeout: 10000,
    });
    const voices = (r.data?.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category }));
    res.json({ data: voices });
  } catch(e) {
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
