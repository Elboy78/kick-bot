require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { Server } = require('socket.io');
const axios   = require('axios');
const db      = require('./database');

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
app.get('/api/levels',         (req,res) => res.json({data: db.LEVELS}));
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
  const { live, viewers, followers } = req.body;
  liveFromBrowser = { live: !!live, viewers: viewers||0, followers: followers||0, updatedAt: Date.now() };
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
// TTS — Text To Speech pour les dons
// ════════════════════════════════════════════════════════════════════

const TTS_MIN_DONATION   = parseFloat(process.env.TTS_MIN_DONATION || '0');
const TTS_MAX_TEXT_LEN   = parseInt(process.env.TTS_MAX_TEXT_LENGTH || '180');
const TTS_WEBHOOK_SECRET = process.env.TTS_WEBHOOK_SECRET || '';
const TTS_VOICE_ID       = process.env.ELEVENLABS_VOICE_ID || '';
const TTS_API_KEY        = process.env.ELEVENLABS_API_KEY || '';

async function generateTTSAudio(text) {
  if (!TTS_API_KEY || !TTS_VOICE_ID) return null;
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE_ID}`,
      { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { 'xi-api-key': TTS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 }
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
    // Vérification du secret si configuré
    if (TTS_WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== TTS_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const username = String(req.body.username || req.body.from || 'Anonyme');
    const amount   = parseFloat(req.body.amount || 0);
    let message    = String(req.body.message || '').trim();

    if (!await db.getSetting('tts_enabled')) {
      return res.json({ ignored: true, reason: 'tts_disabled' });
    }
    if (amount < TTS_MIN_DONATION) {
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

    message = message.slice(0, TTS_MAX_TEXT_LEN);
    await db.addTTSHistory(username, message, amount, 'played');

    const audioBase64 = await generateTTSAudio(message);
    io.emit('play-tts', { username, message, amount, audio: audioBase64 });
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
    const message = String(req.body.message || '').trim().slice(0, TTS_MAX_TEXT_LEN);
    if (!message) return res.status(400).json({ error: 'message requis' });
    if (await db.isTTSBlacklisted(message)) return res.status(400).json({ error: 'Message bloqué par la blacklist' });

    await db.addTTSHistory('Test Panel', message, 0, 'test');
    const audioBase64 = await generateTTSAudio(message);
    io.emit('play-tts', { username: 'Test Panel', message, amount: 0, audio: audioBase64 });
    io.emit('tts-update');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tts/history',        async (req,res) => { try { res.json({data: await db.getTTSHistory(30)}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/tts/clear-history', async (req,res) => { try { await db.clearTTSHistory(); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

app.get('/api/tts/blacklist',                  async (req,res) => { try { res.json({data: await db.getTTSBlacklist()}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/tts/blacklist',           async (req,res) => { try { const {word}=req.body; if(!word) return res.status(400).json({error:'word requis'}); const ok=await db.addTTSBlacklistWord(word); res.json({success:ok}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/tts/blacklist/:id',     async (req,res) => { try { await db.deleteTTSBlacklistWord(req.params.id); res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Statut du token Kick (écrit par bot.js, lu par le panel)
app.get('/api/bot-status', async (req, res) => {
  try {
    const status = await db.getAllBotStatus();
    res.json({
      tokenExpired: status.token_expired?.value === '1',
      botStartedAt: status.bot_started_at?.value || null,
      lastUpdate: status.token_expired?.updated_at || null,
    });
  } catch(e) { res.json({ tokenExpired: false }); }
});

app.get('/api/tts/config', (req, res) => {
  res.json({
    configured: !!(TTS_API_KEY && TTS_VOICE_ID),
    minDonation: TTS_MIN_DONATION,
    maxTextLength: TTS_MAX_TEXT_LEN,
  });
});

app.get('/overlay', (req,res) => res.sendFile(path.join(__dirname,'public','overlay.html')));

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
