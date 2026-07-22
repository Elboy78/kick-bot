require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const fs      = require('fs');
const crypto  = require('crypto');
const { Server } = require('socket.io');
const axios   = require('axios');
const db      = require('./database');
const kickOAuth = require('./kick-oauth');
const shared = require('./shared');
const tenant = require('./tenant');
const { createTenantManager } = require('./tenant-manager');
const widgetEngine = require('./widget-engine');
const loadSession = require('./middlewares/loadSession');
const requireAuth = require('./middlewares/requireAuth');
const requireTenant = require('./middlewares/requireTenant');
const { setSessionCookie, clearSessionCookie, setAdminTargetCookie, clearAdminTargetCookie } = require('./core/auth/session');
const { normalizeTarget } = require('./core/auth/platform-admin');

const app    = express();
const PORT   = parseInt(process.env.PANEL_PORT || '3000');
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '22mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(loadSession(db));
// Les pages/API publiques de classement doivent uniquement consulter un tenant
// existant. Un slug inventé ne doit jamais créer automatiquement un streamer.
app.use((req, res, next) => {
  req.publicTenantLookupOnly = /^\/classement\/[^/]+(?:\/)?(?:[?#].*)?$/.test(req.originalUrl || req.url || '')
    || /^\/api\/public\/(?:leaderboard|levels|streamer)\/[^/?#]+/.test(req.originalUrl || req.url || '');
  next();
});
app.use((req, res, next) => tenant.attachTenant(db, req, res, next));

// Init DB avant de démarrer
let dbReady = false;
db.ensureInit().then(async () => {
  const defaultStreamer = await db.ensureDefaultStreamer(tenant.getDefaultStreamerSeed());
  console.log(`[V2] Streamer par défaut : ${defaultStreamer.slug} (#${defaultStreamer.id})`);
  dbReady = true;
  console.log('[PANEL] DB prête ✓');
}).catch(err => {
  console.error('[PANEL] Erreur init DB:', err);
});

// Middleware : attendre que la DB soit prête
function waitDB(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Base de données en cours de chargement, réessaie dans 5 secondes' });
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (!req.authStreamer) return res.status(401).json({ error: 'Connexion Kick requise' });
  if (!req.platformAdmin) return res.status(403).json({ error: 'Accès réservé à l’administrateur ElBot' });
  next();
}

// V2 : page d'entrée = login Kick. Le panel complet vit dans /s/:streamer/dashboard.
function serveLoginOrDashboard(req, res) {
  if (req.authStreamer?.slug) {
    return res.redirect(`/s/${encodeURIComponent(req.authStreamer.slug)}/dashboard`);
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
}

app.get('/', serveLoginOrDashboard);
app.get('/login', serveLoginOrDashboard);
app.get('/login.html', serveLoginOrDashboard);


// ── Administration plateforme : accès support sécurisé ───────────────────────
app.get('/api/platform-admin/status', requireAuth, requireTenant, waitDB, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      isPlatformAdmin: Boolean(req.platformAdmin),
      identity: { id: req.authStreamer.id, slug: req.authStreamer.slug, kickUserId: req.authStreamer.kick_user_id || null },
      activeStreamer: { id: req.streamer.id, slug: req.streamer.slug, displayName: req.streamer.display_name || req.streamer.displayName || req.streamer.slug },
      impersonating: Boolean(req.isAdminImpersonation)
    }
  });
});

app.get('/api/platform-admin/streamers', requireAuth, requirePlatformAdmin, waitDB, async (req, res) => {
  try {
    const rows = await db.listStreamers();
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows.map(row => ({
      id: row.id,
      slug: row.slug,
      displayName: row.display_name || row.displayName || row.kick_username || row.slug,
      avatarUrl: row.avatar_url || row.avatarUrl || '',
      status: row.status || 'active',
      plan: row.plan || 'standard',
      assignedBotIdentityId: row.assigned_bot_identity_id || null
    })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/platform-admin/switch', requireAuth, requirePlatformAdmin, waitDB, async (req, res) => {
  try {
    const slug = tenant.normalizeSlug(req.body?.slug || '');
    if (!slug) return res.status(400).json({ error: 'Streamer requis' });
    const target = await db.getStreamerBySlug(slug).catch(() => null);
    if (!target) return res.status(404).json({ error: 'Streamer introuvable' });
    const normalized = normalizeTarget(target);
    setAdminTargetCookie(req, res, normalized);
    console.log(`[PLATFORM ADMIN] ${req.authStreamer.slug} ouvre le panel ${target.slug}`);
    res.json({ success: true, data: { slug: target.slug, redirect: `/s/${target.slug}/dashboard` } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/platform-admin/exit', requireAuth, requirePlatformAdmin, (req, res) => {
  clearAdminTargetCookie(req, res);
  console.log(`[PLATFORM ADMIN] ${req.authStreamer.slug} retourne sur son panel`);
  res.json({ success: true, data: { slug: req.authStreamer.slug, redirect: `/s/${req.authStreamer.slug}/dashboard` } });
});

// ── Support ElBot : tickets isolés par streamer + relais Discord optionnel ───
function discordSupportConfigured(){return Boolean(process.env.DISCORD_BOT_TOKEN&&process.env.DISCORD_GUILD_ID&&process.env.DISCORD_SUPPORT_CATEGORY_ID)}
async function discordSupportRequest(method,url,data){return axios({method,url:`https://discord.com/api/v10${url}`,data,headers:{Authorization:`Bot ${process.env.DISCORD_BOT_TOKEN}`,'Content-Type':'application/json'},timeout:8000})}
function supportChannelName(ticket){return `support-${String(ticket.streamer_slug||'streamer').toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,45)}-${ticket.id}`}
async function ensureDiscordSupportChannel(ticket){
  if(!discordSupportConfigured())return null;if(ticket.discord_channel_id)return ticket.discord_channel_id;
  const created=await discordSupportRequest('post',`/guilds/${process.env.DISCORD_GUILD_ID}/channels`,{name:supportChannelName(ticket),type:0,parent_id:String(process.env.DISCORD_SUPPORT_CATEGORY_ID),topic:`Ticket ElBot #${ticket.id} · ${ticket.streamer_slug} · ${ticket.category} · ${ticket.priority}`});
  const channelId=String(created.data?.id||'');if(channelId)await db.updateSupportTicket(ticket.id,ticket.streamer_id,{discordChannelId:channelId},true);return channelId||null;
}
async function postDiscordSupportMessage(ticket,message,author){
  try{const channelId=await ensureDiscordSupportChannel(ticket);if(!channelId)return false;await discordSupportRequest('post',`/channels/${channelId}/messages`,{content:`**${String(author||ticket.streamer_slug).slice(0,80)}**\n${String(message||'').slice(0,1900)}`});return true}catch(error){console.warn('[SUPPORT DISCORD]',error.response?.data?.message||error.message);return false}
}
app.get('/api/support/tickets',requireAuth,requireTenant,waitDB,async(req,res)=>{try{const allTickets=Boolean(req.platformAdmin&&!req.isAdminImpersonation);res.json({data:await db.listSupportTickets(req.streamer.id,allTickets),discordConfigured:discordSupportConfigured(),admin:allTickets})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/support/tickets',requireAuth,requireTenant,waitDB,async(req,res)=>{try{const ticket=await db.createSupportTicket(req.streamer.id,{...req.body,authorSlug:req.authStreamer.slug,authorRole:'streamer'});const first=(await db.getSupportMessages(ticket.id,req.streamer.id,false))?.[0];const discord=await postDiscordSupportMessage(ticket,`Nouveau ticket : **${ticket.subject}**\n${first?.message||''}`,req.authStreamer.slug);res.json({success:true,data:ticket,discord})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/support/tickets/:id/messages',requireAuth,requireTenant,waitDB,async(req,res)=>{try{const includeAll=Boolean(req.platformAdmin&&!req.isAdminImpersonation),ticket=await db.getSupportTicket(req.params.id,req.streamer.id,includeAll);if(!ticket)return res.status(404).json({error:'Ticket introuvable'});res.json({data:{ticket,messages:await db.getSupportMessages(ticket.id,req.streamer.id,includeAll)}})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/support/tickets/:id/messages',requireAuth,requireTenant,waitDB,async(req,res)=>{try{const isAdmin=Boolean(req.platformAdmin&&!req.isAdminImpersonation),ticket=await db.getSupportTicket(req.params.id,req.streamer.id,isAdmin);if(!ticket)return res.status(404).json({error:'Ticket introuvable'});const updated=await db.addSupportMessage(ticket.id,ticket.streamer_id,{message:req.body?.message,authorSlug:req.authStreamer.slug,authorRole:isAdmin?'admin':'streamer'},isAdmin);await postDiscordSupportMessage(updated,req.body?.message,`${req.authStreamer.slug}${isAdmin?' · Support ElBot':''}`);res.json({success:true,data:updated})}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/support/tickets/:id',requireAuth,requireTenant,waitDB,async(req,res)=>{try{const isAdmin=Boolean(req.platformAdmin&&!req.isAdminImpersonation),ticket=await db.updateSupportTicket(req.params.id,req.streamer.id,{status:req.body?.status},isAdmin);res.json({success:true,data:ticket})}catch(e){res.status(400).json({error:e.message})}});

// ── V2 Multi-streamer : socle sans casser la V1 ──────────────────────────────
app.get('/api/v2/streamers/current', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const streamer = req.streamer || await db.ensureDefaultStreamer(tenant.getDefaultStreamerSeed());
    const connected = await kickOAuth.isConnected(streamer.id).catch(() => false);
    res.json({ data: { ...streamer, oauthConnected: connected, isDefault: streamer.slug === tenant.DEFAULT_STREAMER_SLUG } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v2/streamers', requireAuth, requirePlatformAdmin, waitDB, async (req, res) => {
  try { res.json({ data: await db.listStreamers() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v2/admin/streamers', requireAuth, requirePlatformAdmin, waitDB, async (req, res) => {
  try {
    const streamer = await db.upsertStreamer({
      slug: req.body.slug,
      kickUsername: req.body.kickUsername || req.body.kick_username,
      displayName: req.body.displayName || req.body.display_name,
      avatarUrl: req.body.avatarUrl || req.body.avatar_url,
      role: req.body.role || 'streamer',
      status: req.body.status || 'active'
    });
    res.json({ success: true, data: streamer });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/v2/widgets', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const base = `${protocol}://${host}`;
    const streamer = req.streamer || await db.ensureDefaultStreamer(tenant.getDefaultStreamerSeed());
    const tokens = await db.getOverlayTokensForStreamer(streamer.id);
    const tm = createTenantManager({ db, io, streamer });
    const widgets = [];
    for (const definition of widgetEngine.listWidgets()) {
      const tokenRow = tokens[definition.id] || await db.getOrCreateOverlayToken(streamer.id, definition.id);
      let enabled = true;
      if (definition.enabledSetting) {
        const raw = await tm.getSetting(definition.enabledSetting, '1');
        enabled = !['0', 'false', 'off', 'disabled'].includes(String(raw).toLowerCase());
      }
      widgets.push({
        ...definition,
        enabled,
        url: `${base}/o/${tokenRow.token}/${definition.id}.html`,
        maskedToken: `${String(tokenRow.token).slice(0, 6)}…${String(tokenRow.token).slice(-6)}`,
        lastUsedAt: tokenRow.last_used_at || null
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ data: { streamer: streamer.slug, widgets } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/v2/obs-links', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const base = `${protocol}://${host}`;
    const streamer = req.streamer || await db.ensureDefaultStreamer(tenant.getDefaultStreamerSeed());
    const tokens = await db.getOverlayTokensForStreamer(streamer.id);
    const linkFor = (widget) => `${base}/o/${tokens[widget].token}/${widget}.html`;
    res.json({ data: {
      streamer: streamer.slug,
      mode: 'token',
      classement: `${base}/s/${streamer.slug}/classement`,
      alerts: linkFor('alerts'),
      chat: linkFor('chat'),
      songrequest: linkFor('songrequest'),
      subgoal: linkFor('subgoal'),
      memes: linkFor('memes'),
      tokens: Object.fromEntries(Object.entries(tokens).map(([k,v]) => [k, { id:v.id, widget:k, token:String(v.token).slice(0,6)+'…'+String(v.token).slice(-6), lastUsedAt:v.last_used_at || null }]))
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v2/admin/overlay-tokens/:widget/regenerate', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const base = `${protocol}://${host}`;
    const streamer = req.streamer || await db.ensureDefaultStreamer(tenant.getDefaultStreamerSeed());
    const widget = String(req.params.widget || '').replace(/\.html$/,'').toLowerCase();
    const row = await db.regenerateOverlayToken(streamer.id, widget);
    try {
      // Sécurité V2 : invalide immédiatement les anciennes sources OBS déjà ouvertes.
      // Sans ça, une ancienne source /o/<ancien-token>/songrequest.html peut continuer
      // à jouer jusqu'à son prochain refresh OBS.
      io.to(tenant.roomName(streamer.slug)).emit('overlay-token-regenerated', {
        streamer: streamer.slug,
        widget,
        at: new Date().toISOString()
      });
    } catch(e) {}
    res.json({ success:true, data:{ widget, url:`${base}/o/${row.token}/${widget}.html`, token:String(row.token).slice(0,6)+'…'+String(row.token).slice(-6) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// V2 multi-streamer : attache le tenant et force les settings par streamer.
// Ainsi, le même panel complet affiche les données du compte Kick connecté,
// pas celles du streamer par défaut.
async function setStreamerCookieMiddleware(req, res, next) {
  try {
    const slug = tenant.normalizeSlug(req.params?.streamer || req.query?.streamer || '');
    if (slug) {
      const streamer = await tenant.ensureRequestedStreamer(db, slug);
      req.streamer = streamer;
      req.streamerSlug = streamer.slug;
      res.cookie('kb_streamer', streamer.slug, { path: '/', sameSite: 'Lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
      res.setHeader('X-Streamer-Slug', streamer.slug);
    }
  } catch(e) {
    console.warn('[TENANT] Impossible de poser le streamer route:', e.message);
  }
  next();
}

function installTenantScopedSettings() {
  if (db.__tenantScopedSettingsInstalled) return;
  db.__tenantScopedSettingsInstalled = true;
  const raw = {
    getSettingStr: db.getSettingStr.bind(db),
    setSettingStr: db.setSettingStr.bind(db),
    getSetting: db.getSetting.bind(db),
    setSetting: db.setSetting.bind(db)
  };
  const globalKeys = new Set([
    // Auth / accès panel restent globaux.
    'panel_password', 'panel_owner'
  ]);
  function scopedKey(key) {
    const k = String(key || '');
    if (!k || k.startsWith('streamer:') || globalKeys.has(k)) return k;
    const slug = tenant.getCurrentStreamerSlug();
    // Hors requête tenant, on garde le comportement V1 pour bot.js et les jobs internes.
    if (!slug) return k;
    return tenant.scopedKey(slug, k);
  }
  db.getSettingStr = async (key, defaultVal = '') => raw.getSettingStr(scopedKey(key), defaultVal);
  db.setSettingStr = async (key, value) => raw.setSettingStr(scopedKey(key), value);
  db.getSetting = async (key) => raw.getSetting(scopedKey(key));
  db.setSetting = async (key, enabled) => raw.setSetting(scopedKey(key), enabled);
  db.__rawSettings = raw;
}
installTenantScopedSettings();

// V2 overlays privés : quand un widget OBS est ouvert via /o/<token>/<widget>.html,
// le navigateur n'a pas forcément un cookie fiable dans OBS. Les APIs du widget
// peuvent donc envoyer ?overlayToken=<token>. On résout alors le vrai streamer ici,
// AVANT de créer le TenantManager de la requête.
app.use(async (req, res, next) => {
  try {
    const overlayToken = String(req.query?.overlayToken || req.headers?.['x-overlay-token'] || '').trim();
    if (overlayToken && typeof db.getOverlayTokenByValue === 'function') {
      const tokenRow = await db.getOverlayTokenByValue(overlayToken);
      if (!tokenRow) {
        req.overlayTokenInvalid = true;
      } else {
        req.overlayTokenRow = tokenRow;
        if (tokenRow?.streamer_id && typeof db.getStreamerById === 'function') {
          const streamer = await db.getStreamerById(tokenRow.streamer_id);
          if (streamer) {
            req.streamer = streamer;
            req.streamerSlug = streamer.slug;
            res.setHeader('X-Streamer-Slug', streamer.slug);
          }
        }
      }
    }
  } catch(e) {
    console.warn('[OVERLAY TOKEN] Résolution API impossible:', e.message);
  }
  next();
});

app.use((req, res, next) => { req.tenantManager = createTenantManager({ db, io, req, streamer: req.streamer }); next(); });

// Routes tenant qui posent le cookie streamer avant de servir le panel/overlays.
app.get('/s/:streamer/widgets/:file', setStreamerCookieMiddleware, (req, res) => {
  const file = String(req.params.file || '').replace(/[^a-z0-9_.-]/gi, '');
  res.sendFile(path.join(__dirname, 'public', 'widgets', file));
});

app.get('/o/:token/:file', waitDB, async (req, res) => {
  try {
    const file = String(req.params.file || '').replace(/[^a-z0-9_.-]/gi, '');
    const widget = file.replace(/\.html$/,'').toLowerCase();
    const tokenRow = await db.getOverlayTokenByValue(req.params.token);
    if (!tokenRow || tokenRow.widget !== widget) return res.status(404).send('Overlay introuvable');
    const streamer = await db.getStreamerById(tokenRow.streamer_id);
    if (!streamer) return res.status(404).send('Streamer introuvable');
    req.streamer = streamer;
    req.streamerSlug = streamer.slug;
    res.cookie('kb_streamer', streamer.slug, { path: '/', sameSite: 'Lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
    res.setHeader('X-Streamer-Slug', streamer.slug);
    res.setHeader('X-Overlay-Widget', widget);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'widgets', file));
  } catch(e) {
    console.error('[OVERLAY TOKEN] Erreur:', e.message);
    res.status(500).send('Erreur overlay');
  }
});
app.get('/classement/:streamer', waitDB, (req, res) => {
  if (!req.streamer || tenant.normalizeSlug(req.params.streamer) !== req.streamer.slug) {
    return res.status(404).send('Classement introuvable');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'classement.html'));
});
// Ancienne URL conservée pour compatibilité, redirigée vers l'URL publique canonique.
app.get('/s/:streamer/classement', (req, res) => {
  res.redirect(301, `/classement/${encodeURIComponent(tenant.normalizeSlug(req.params.streamer))}`);
});
function requireOwnPanel(req, res, next) {
  const requested = tenant.normalizeSlug(req.params.streamer);
  const allowed = tenant.normalizeSlug(req.streamer?.slug || req.authStreamer?.slug);
  if (!allowed) return res.redirect('/login');
  if (requested !== allowed) return res.redirect(`/s/${allowed}/dashboard`);
  next();
}
app.get('/s/:streamer/dashboard', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/s/:streamer/dashboard.html', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/s/:streamer/panel', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/s/:streamer/panel.html', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/s/:streamer/overlays', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlays.html')));
app.get('/s/:streamer/overlays.html', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlays.html')));
app.get('/s/:streamer/account', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/s/:streamer/account.html', requireAuth, requireTenant, requireOwnPanel, (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));


app.get('/api/v2/tenant/debug', async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    res.json({ data: { ...tm.info(), overlayLinks: tm.overlayLinks(), sampleScopedKey: tm.scopedKey('songrequest_queue'), sampleSongRequestQueue: await tm.getJson('songrequest_queue', []) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v2/tenant/current', async (req, res) => {
  try { const tm = createTenantManager({ db, io, req }); res.json({ data: tm.info() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Reçoit les métadonnées de chaîne résolues par le navigateur du streamer.
// Render peut recevoir 403 sur kick.com/api/v2/channels/:slug, alors que le navigateur du streamer y a accès.
// Une fois chatroom_id enregistré, BotManager peut écouter la chaîne sans refaire de scraping.
app.post('/api/v2/streamer/chatroom', waitDB, async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    const streamer = await db.getStreamerById(tm.streamerId);
    if (!streamer) return res.status(404).json({ error: 'streamer introuvable' });
    const slug = tenant.normalizeSlug(req.body?.slug || streamer.slug);
    if (slug !== streamer.slug) return res.status(403).json({ error: 'slug mismatch' });
    const updated = await db.updateStreamerKickMeta(streamer.id, {
      channelId: req.body?.channelId || req.body?.channel_id || null,
      chatroomId: req.body?.chatroomId || req.body?.chatroom_id || null,
      broadcasterUserId: req.body?.broadcasterUserId || req.body?.broadcaster_user_id || null,
      kickUserId: req.body?.kickUserId || req.body?.kick_user_id || null,
      botEnabled: 1
    });
    io.emit('bot-channels-refresh');
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v2/core/status', waitDB, async (req, res) => {
  try {
    const botConnected = await kickOAuth.isBotConnected().catch(()=>false);
    const streamers = await db.listStreamers();
    res.json({ data: { botConnected, streamers: streamers.map(s => ({ id:s.id, slug:s.slug, chatroom_id:s.chatroom_id || null, broadcaster_user_id:s.broadcaster_user_id || null, bot_enabled:s.bot_enabled })) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/api/platform-admin/streamers/:id/plan', requireAuth, requirePlatformAdmin, waitDB, async (req, res) => {
  try {
    const streamerId = Number(req.params.id);
    const plan = String(req.body?.plan || '').trim().toLowerCase();
    if (!streamerId || !['standard','premium'].includes(plan)) return res.status(400).json({ error: 'Offre invalide' });
    const streamer = await db.getStreamerById(streamerId);
    if (!streamer) return res.status(404).json({ error: 'Streamer introuvable' });
    await db.setStreamerPlan(streamerId, plan);
    res.json({ success:true, plan });
  } catch (error) { res.status(500).json({ error:error.message }); }
});

app.get('/api/community', waitDB, async (req, res) => {
  try {
    const limit = Math.max(10, Math.min(500, parseInt(req.query.limit || '100') || 100));
    const data = await db.getCommunityData(limit, req.streamer?.id);
    res.json({ data: { streamer: req.streamer?.slug, ...data } });
  } catch (e) {
    console.error('[COMMUNAUTÉ] Lecture impossible:', e.message);
    res.status(500).json({ error: 'Historique communauté indisponible' });
  }
});

app.post('/api/admin/community/kick-gifts-import', waitDB, requireAuth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const imported = await db.importCommunityGiftLeaderboard(rows, req.streamer?.id);
    res.json({ success: true, imported });
  } catch (e) {
    console.error('[COMMUNAUTÉ] Import leaderboard Kick impossible:', e.message);
    res.status(500).json({ error: 'Import du classement Kick impossible' });
  }
});

app.get('/api/public/streamer/:streamer', waitDB, async (req, res) => {
  const requestedSlug = tenant.normalizeSlug(req.params.streamer);
  if (!req.streamer || req.streamer.slug !== requestedSlug) {
    return res.status(404).json({ error: 'Classement introuvable' });
  }
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    data: {
      slug: req.streamer.slug,
      displayName: req.streamer.display_name || req.streamer.kick_username || req.streamer.slug,
      avatarUrl: req.streamer.avatar_url || ''
    }
  });
});

app.get('/api/public/leaderboard/:streamer', waitDB, async (req, res) => {
  try {
    const requestedSlug = tenant.normalizeSlug(req.params.streamer);
    if (!req.streamer || req.streamer.slug !== requestedSlug) {
      return res.status(404).json({ error: 'Classement introuvable', data: [] });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100);
    const ignored = await getLeaderboardIgnoredUsers();
    const rawRows = await db.getLeaderboard(Math.max(limit + ignored.length + 50, limit));
    const data = filterLeaderboardUsers(rawRows, ignored)
      .slice(0, limit)
      .map((viewer, index) => ({ ...viewer, original_rank: viewer.rank, rank: index + 1 }));
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger le classement', data: [] });
  }
});

app.get('/api/public/levels/:streamer', waitDB, async (req, res) => {
  try {
    const requestedSlug = tenant.normalizeSlug(req.params.streamer);
    if (!req.streamer || req.streamer.slug !== requestedSlug) {
      return res.status(404).json({ error: 'Classement introuvable', data: [] });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ data: await getLevelsWithImages() });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les niveaux', data: [] });
  }
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
app.get('/api/channel-info', requireAuth, requireTenant, (req, res) => {
  const streamer = req.streamer || {};
  res.set('Cache-Control', 'no-store');
  res.json({
    channel: streamer.kick_username || streamer.slug,
    slug: streamer.slug,
    displayName: streamer.display_name || streamer.kick_username || streamer.slug,
    avatarUrl: streamer.avatar_url || '',
    streamerId: streamer.id
  });
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

function getSubCounterManager(source = null) {
  if (source?.getSetting && source?.setSetting) return source;
  if (source?.tenantManager) return source.tenantManager;
  const streamer = source?.streamer || source?.__streamerContext || source || null;
  return createTenantManager({ db, io, req: source?.headers ? source : null, streamer });
}

async function getSubCounterState(source = null) {
  const tm = getSubCounterManager(source);
  const latestRaw = await tm.getSetting('subcounter_latest', '[]');
  let latest = [];
  try { latest = JSON.parse(latestRaw); } catch(e) { latest = []; }
  const totalRaw = await tm.getSetting('subcounter_total', await tm.getSetting('subgoal_current', '0'));
  return {
    streamer: tm.slug,
    total: Math.max(0, parseInt(totalRaw) || 0),
    session: Math.max(0, parseInt(await tm.getSetting('subcounter_session', '0')) || 0),
    renewals: Math.max(0, parseInt(await tm.getSetting('subcounter_renewals', '0')) || 0),
    gifts: Math.max(0, parseInt(await tm.getSetting('subcounter_gifts', '0')) || 0),
    target: Math.max(1, parseInt(await tm.getSetting('subgoal_target', '50')) || 50),
    label: await tm.getSetting('subgoal_label', 'Sub Goal'),
    textPosition: await tm.getSetting('subgoal_text_position', 'inside'),
    countPosition: await tm.getSetting('subgoal_count_position', 'inside'),
    progressDisplay: await tm.getSetting('subgoal_progress_display', 'count'),
    textAlign: await tm.getSetting('subgoal_text_align', 'center'),
    latest: Array.isArray(latest) ? latest.slice(0, 12) : []
  };
}

function publicSubGoalState(state) {
  return {
    streamer: state.streamer,
    current: state.total,
    target: state.target,
    label: state.label,
    textPosition: state.textPosition,
    countPosition: state.countPosition,
    progressDisplay: state.progressDisplay,
    textAlign: state.textAlign,
    updatedAt: new Date().toISOString()
  };
}

async function emitSubCounterState(source = null) {
  const tm = getSubCounterManager(source);
  const state = await getSubCounterState(tm);
  tm.emit('subcounter-update', state);
  tm.emit('subgoal-update', publicSubGoalState(state));
  return state;
}

async function recordSubEvent(type, payload = {}, source = null) {
  try {
    const tm = getSubCounterManager(source || payload?.__streamerContext || null);
    const state = await getSubCounterState(tm);
    const amount = Math.max(1, parseInt(payload.count || 1) || 1);
    const event = {
      type,
      username: payload.username || payload.gifter || 'Anonyme',
      gifter: payload.gifter || null,
      count: amount,
      months: payload.months || null,
      at: new Date().toISOString()
    };

    // Chaque soutien reçu pendant le live fait progresser l'objectif : nouveau sub,
    // renouvellement et gifts. Les compteurs détaillés restent disponibles séparément.
    if (type === 'new' || type === 'gift') {
      state.total += amount;
      state.session += amount;
    }
    if (type === 'gift') state.gifts += amount;
    if (type === 'renewal') {
      state.total += amount;
      state.session += amount;
      state.renewals += amount;
    }

    state.latest = [event, ...state.latest].slice(0, 12);
    const communityEvent = await db.addCommunityEvent({
      type,
      username: event.username,
      gifter: event.gifter,
      amount,
      months: event.months,
      occurredAt: event.at,
      source: 'kick_event',
      sourceKey: payload.sourceKey || undefined
    }, tm.streamerId);
    await Promise.all([
      tm.setSetting('subcounter_total', String(state.total)),
      tm.setSetting('subcounter_session', String(state.session)),
      tm.setSetting('subcounter_renewals', String(state.renewals)),
      tm.setSetting('subcounter_gifts', String(state.gifts)),
      tm.setSetting('subgoal_current', String(state.total)),
      tm.setSetting('subcounter_latest', JSON.stringify(state.latest))
    ]);
    tm.emit('subcounter-update', state);
    tm.emit('subgoal-update', publicSubGoalState(state));
    if (communityEvent?.inserted) {
      tm.emit('community-update', {
        type,
        username: event.username,
        gifter: event.gifter,
        count: amount,
        at: event.at
      });
    }
    console.log(`[SUBCOUNTER:${tm.slug}] ${type} +${amount} → total=${state.total} session=${state.session}`);
    return state;
  } catch(e) {
    console.error('[SUBCOUNTER] Erreur event:', e.message);
    throw e;
  }
}

// ── Traitement commun events Kick : webhook + websocket bot ────────────────────

const processedKickEvents = new Map();
const processedKickEventSemantics = new Map();
function cleanupProcessedKickEvents() {
  const now = Date.now();
  for (const [key, ts] of processedKickEvents.entries()) {
    if (now - ts > 10 * 60 * 1000) processedKickEvents.delete(key);
  }
  for (const [key, ts] of processedKickEventSemantics.entries()) {
    if (now - ts > 12 * 1000) processedKickEventSemantics.delete(key);
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
function semanticKickEventKey(eventType,payload={}){
  const data=getPayloadData(payload),type=normalizeKickEventType(eventType);
  if(type==='channel.subscription.gifts'){
    const info=extractSubInfo(payload),recipients=[...(data?.giftees||data?.recipients||[])].map(x=>String(x?.username||x?.name||x||'').toLowerCase()).filter(Boolean).sort().join(',');
    return `${type}:${String(info.gifter||'').toLowerCase()}:${info.count}:${recipients}`;
  }
  if(type==='channel.subscription.new'||type==='channel.subscription.renewal'){
    const info=extractSubInfo(payload);return `${type}:${String(info.username||'').toLowerCase()}:${type.endsWith('renewal')?info.months:1}`;
  }
  return '';
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
function emitDashboardActivity(tm,payload){tm.emit('dashboard-activity',{id:`${Date.now()}_${Math.random().toString(36).slice(2,7)}`,at:new Date().toISOString(),...payload})}
async function settleKickReward(streamerId, redemptionId, accepted) {
  const token = await kickOAuth.getValidAccessToken(streamerId);
  if (!token) throw new Error('Reconnecte le compte streamer Kick pour gérer les récompenses.');
  const action = accepted ? 'accept' : 'reject';
  await axios.post(`https://api.kick.com/public/v1/channels/rewards/redemptions/${action}`, { ids:[String(redemptionId)] }, {
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'}, timeout:12000
  });
}
async function processTimeoutReward(tm, data) {
  const enabled = (await tm.getSetting('kick_timeout_reward_enabled','0')) === '1';
  const configuredId = String(await tm.getSetting('kick_timeout_reward_id','')).trim();
  const rewardId = String(data?.reward?.id || '').trim();
  const status = String(data?.status || 'pending').toLowerCase();
  if (!enabled || !configuredId || rewardId !== configuredId || status !== 'pending') return {ok:true,ignored:true,eventType:'channel.reward.redemption.updated'};
  const redemptionId = String(data?.id || '').trim();
  const redeemer = String(data?.redeemer?.username || 'viewer').trim().replace(/^@+/, '');
  const target = String(data?.user_input || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g,'').slice(0,25);
  const duration = Math.max(60,Math.min(86400,parseInt(await tm.getSetting('kick_timeout_reward_duration','300'))||300));
  let rejection = '';
  if (!redemptionId || !target) rejection = 'Pseudo cible manquant ou invalide';
  if (target.toLowerCase() === String(tm.slug||'').toLowerCase()) rejection = 'Le streamer est protégé';
  if (target.toLowerCase() === redeemer.toLowerCase()) rejection = 'Un viewer ne peut pas se cibler lui-même';
  const viewer = target ? await db.getViewerForStreamer(target,tm.streamerId).catch(()=>null) : null;
  let badges=[];try{badges=JSON.parse(viewer?.badges_json||'[]')}catch(_){}
  if (badges.some(b=>/moderator|broadcaster/i.test(String(b?.type||b?.text||'')))) rejection = 'Les modérateurs et le streamer sont protégés';
  if (!viewer?.kick_user_id) rejection = 'Ce viewer doit avoir parlé au moins une fois dans le chat';
  if (rejection) {
    if (redemptionId) await settleKickReward(tm.streamerId,redemptionId,false);
    console.log(`[REWARD TO:${tm.slug}] Refus ${redeemer} → ${target||'?'}: ${rejection}`);
    return {ok:true,rejected:true,reason:rejection,eventType:'channel.reward.redemption.updated'};
  }
  const success = await shared.moderateUser(target,viewer.kick_user_id,'timeout',duration,`Récompense Kick achetée par ${redeemer}`,{streamerId:tm.streamerId,slug:tm.slug});
  await settleKickReward(tm.streamerId,redemptionId,!!success);
  if (!success) throw new Error(`Le timeout de @${target} a échoué; la récompense a été remboursée.`);
  await db.addModerationLog('timeout',target,duration,`Récompense points Kick par ${redeemer}`,'',redeemer).catch(()=>{});
  console.log(`[REWARD TO:${tm.slug}] ${redeemer} → ${target} (${duration}s)`);
  return {ok:true,accepted:true,target,duration,eventType:'channel.reward.redemption.updated'};
}
async function processKickEvent(eventTypeRaw, payload = {}) {
  const eventContext = payload?.__streamerContext || payload?.streamer || null;
  const tm = getSubCounterManager(eventContext);
  const eventType = normalizeKickEventType(eventTypeRaw || payload?.event || payload?.type || '');
  const data = getPayloadData(payload);
  const dedupe = `${tm.slug}:${eventDedupeKey(eventType, payload)}`;
  const persistentEventKey=`kick:${eventDedupeKey(eventType,payload)}`;
  const semanticRaw=semanticKickEventKey(eventType,payload),semantic=semanticRaw?`${tm.slug}:${semanticRaw}`:'';
  cleanupProcessedKickEvents();
  if (processedKickEvents.has(dedupe)) return { ok: true, duplicate: true, eventType };
  if (semantic&&processedKickEventSemantics.has(semantic)) return {ok:true,duplicate:true,eventType};
  processedKickEvents.set(dedupe, Date.now());
  if(semantic)processedKickEventSemantics.set(semantic,Date.now());

  if (eventType === 'channel.reward.redemption.updated') return processTimeoutReward(tm,data);

  if (eventType === 'channel.followed') {
    const username = pick(
      data?.user?.username, data?.follower?.username, data?.username,
      data?.user?.name, data?.follower?.name,
      payload?.user?.username, payload?.username
    ) || 'quelqu\'un';

    await db.addCommunityEvent({
      type: 'follow', username, occurredAt: data?.created_at || payload?.created_at || new Date().toISOString(),
      source: 'kick_event', sourceKey: `follow:${username.toLowerCase()}:${data?.created_at || payload?.created_at || eventDedupeKey(eventType, payload)}`
    }, tm.streamerId);
    emitDashboardActivity(tm,{type:'follow',username});

    const enabled = await db.getSetting('follow_announce_enabled');
    // Synchronise aussi l'ancien réglage utilisé par le tracker followers de bot.js
    await db.setSetting('follow_alerts', enabled).catch(()=>{});
    await pushObsAlert('follow', { username }, false, tm).catch(e=>console.warn('[ALERT OBS] follow ignorée:', e.message));
    if (enabled) {
      const template = await db.getSettingStr('follow_announce_message', DEFAULT_FOLLOW_MSG);
      const message = template.replace(/\{username\}/gi, username).replace(/@\s*@/g, '@');
      await sendAnnouncementToChat(message, `FOLLOW ${username}`);
    }
    return { ok: true, eventType, username };
  }

  if (eventType === 'channel.subscription.new') {
    const info = extractSubInfo(payload);
    await recordSubEvent('new', { username: info.username, count: 1, sourceKey:persistentEventKey }, tm);
    emitDashboardActivity(tm,{type:'sub',username:info.username});
    await pushObsAlert('sub', { username: info.username }, false, tm).catch(e=>console.warn('[ALERT OBS] sub ignorée:', e.message));
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
    await recordSubEvent('renewal', { username: info.username, months: info.months, sourceKey:persistentEventKey }, tm);
    emitDashboardActivity(tm,{type:'renewal',username:info.username,months:info.months});
    await pushObsAlert('renew', { username: info.username, months: info.months }, false, tm).catch(e=>console.warn('[ALERT OBS] renew ignorée:', e.message));
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
    await recordSubEvent('gift', { gifter, count, sourceKey:persistentEventKey }, tm);
    emitDashboardActivity(tm,{type:'gift',username:gifter,count});
    await pushObsAlert('gift', { gifter, count }, false, tm).catch(e=>console.warn('[ALERT OBS] gift ignorée:', e.message));
    const enabled = await db.getSetting('sub_announce_enabled');
    if (enabled) {
      const template = await db.getSettingStr('sub_announce_gift', DEFAULT_SUB_GIFT_MSG);
      const message = template.replace(/\{gifter\}/gi, gifter).replace(/\{count\}/gi, String(count));
      await sendAnnouncementToChat(message, `SUB GIFT ${gifter} x${count}`);
    }
    return { ok: true, eventType, gifter, count };
  }


  if (String(eventTypeRaw || eventType || '').toLowerCase().includes('raid')) {
    const username = pick(data?.raider?.username, data?.user?.username, data?.username, data?.raider?.name, data?.user?.name) || "quelqu'un";
    const count = parseInt(data?.viewer_count || data?.viewers || data?.count || data?.amount || 1) || 1;
    await pushObsAlert('raid', { username, count, viewerCount: count }, false, tm).catch(e=>console.warn('[ALERT OBS] raid ignorée:', e.message));
    emitDashboardActivity(tm,{type:'raid',username,count});
    return { ok:true, eventType:'channel.raid', username, count };
  }

  return { ok: true, ignored: true, eventType };
}

shared.registerKickEventHandler(processKickEvent);

// Webhook officiel Kick — reçu à chaque nouveau follow/sub
// À configurer sur : kick.com/settings/developer → Event Subscriptions
// URL à renseigner : https://TON-LIEN-RENDER/webhook/kick
app.post('/webhook/kick', async (req, res) => {
  try {
    let event = req.body || {};
    const eventType = req.headers['kick-event-type'] || event?.event || event?.type || '';
    const broadcasterId = req.headers['kick-event-broadcaster-id']
      || event?.broadcaster_user_id || event?.broadcaster?.user_id || event?.broadcaster?.id
      || event?.data?.broadcaster_user_id || event?.data?.broadcaster?.user_id || event?.data?.broadcaster?.id;
    const webhookStreamer = await db.getStreamerByBroadcasterUserId(broadcasterId);
    if (!webhookStreamer) {
      console.warn('[WEBHOOK KICK] Streamer introuvable pour broadcaster_user_id:', broadcasterId || 'absent');
      return res.status(202).json({ ok: true, ignored: true, reason: 'unknown_streamer' });
    }
    event = { ...event, __streamerContext: { id: webhookStreamer.id, slug: webhookStreamer.slug } };
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

// Liste de tous les viewers connus sans date de follow : le navigateur les résout
// progressivement, y compris pour reconstruire l'historique antérieur au bot.
app.get('/api/viewers/missing-follow', async (req, res) => {
  try {
    const rows = await db.getViewersMissingFollow(10);
    res.json({ data: rows.map(r => r.username) });
  } catch(e) { res.json({ data: [] }); }
});
app.get('/api/viewers/badge-sync', requireAuth, requireTenant, async (req, res) => {
  try {
    const rows = await db.getViewersForBadgeSync(10);
    res.json({ data: rows.map(r => r.username) });
  } catch(e) { res.json({ data: [] }); }
});
app.post('/api/viewer/kick-profile', requireAuth, requireTenant, async (req, res) => {
  try {
    const { username, followingSince, subscribedFor, badges, giftCount } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username requis' });
    await db.setViewerKickProfile(username, { followingSince, subscribedFor, badges, giftCount });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/admin/announcements',            async (req,res) => { try { const {message,interval_ms}=req.body; if(!message) return res.status(400).json({error:'requis'}); const id=await db.addAnnouncement(message,interval_ms||600000);await shared.reloadAnnouncements();res.json({success:true,id}); } catch(e){res.status(500).json({error:e.message}); }});
app.put('/api/admin/announcements/:id', requireAuth, requireTenant, async (req,res) => { try { const {message,interval_ms}=req.body;if(!String(message||'').trim())return res.status(400).json({error:'Message requis'});const row=await db.updateAnnouncement(req.params.id,message,interval_ms);await shared.reloadAnnouncements();res.json({success:true,data:row}); } catch(e){res.status(500).json({error:e.message}); }});
app.post('/api/admin/announcements/toggle',     async (req,res) => { try { await db.toggleAnnouncement(req.body.id,req.body.enabled);await shared.reloadAnnouncements();res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});
app.delete('/api/admin/announcements/:id',      async (req,res) => { try { await db.deleteAnnouncement(req.params.id);await shared.reloadAnnouncements();res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

const SPAM_FILTER_DEFAULTS={
  caps:{action:'timeout',duration:30,exclude:'none',announce:false,probation:false,maxAmount:30,minChars:10,maxPercent:50},
  links:{action:'timeout',duration:120,exclude:'subscribers',announce:false,probation:false,allowlist:['kick.com','youtube.com','youtu.be'],blocklist:[]},
  emotes:{action:'timeout',duration:30,exclude:'subscribers',announce:false,probation:false,maxAmount:15},
  paragraph:{action:'timeout',duration:30,exclude:'none',announce:false,probation:false,maxAmount:140},
  symbols:{action:'timeout',duration:15,exclude:'none',announce:false,probation:false,maxAmount:25,minChars:10,maxPercent:50},
  repetition:{action:'timeout',duration:30,exclude:'none',announce:false,probation:false,maxRepeats:15,minChars:3},
  zalgo:{action:'timeout',duration:30,exclude:'none',announce:false,probation:false,maxAmount:15},
  oneMan:{action:'timeout',duration:30,exclude:'none',announce:false,probation:false,minChars:4,minMessages:5,lookback:30,threshold:75}
};
const SPAM_DEFAULTS={level:0,filters:{caps:false,links:false,emotes:false,paragraph:false,symbols:false,repetition:false,zalgo:false,oneMan:false},settings:SPAM_FILTER_DEFAULTS};
function spamList(v,fallback=[]){return (Array.isArray(v)?v:String(v||'').split(/[\n,;]+/)).map(x=>String(x).trim().toLowerCase()).filter(Boolean).slice(0,100).length?(Array.isArray(v)?v:String(v||'').split(/[\n,;]+/)).map(x=>String(x).trim().toLowerCase()).filter(Boolean).slice(0,100):fallback}
function normalizeSpamConfig(raw={}){const level=Math.max(0,Math.min(3,Number(raw.level)||0)),settings={};for(const [key,defaults] of Object.entries(SPAM_FILTER_DEFAULTS)){const source=raw.settings?.[key]||{};settings[key]={...defaults,...source,action:['timeout','ban','delete'].includes(source.action)?source.action:defaults.action,duration:Math.max(1,Number(source.duration)||defaults.duration),exclude:['none','subscribers'].includes(source.exclude)?source.exclude:defaults.exclude,announce:!!source.announce,probation:!!source.probation};if(key==='links'){settings[key].allowlist=spamList(source.allowlist,defaults.allowlist);settings[key].blocklist=spamList(source.blocklist,[])}}return {level,filters:{...SPAM_DEFAULTS.filters,...(raw.filters||{})},settings}}
app.get('/api/spam/config',requireAuth,requireTenant,async(req,res)=>{try{const tm=createTenantManager({db,io,req}),raw=await tm.getSetting('spam_filters_config','{}');let parsed={};try{parsed=JSON.parse(raw||'{}')}catch(_){}res.json({data:normalizeSpamConfig(parsed)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/admin/spam/config',requireAuth,requireTenant,async(req,res)=>{try{const tm=createTenantManager({db,io,req}),cfg=normalizeSpamConfig(req.body||{});await tm.setSetting('spam_filters_config',JSON.stringify(cfg));res.json({success:true,data:cfg})}catch(e){res.status(500).json({error:e.message})}});

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
const tenant = require('./tenant');
const { createTenantManager } = require('./tenant-manager');
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
    const state = await getSubCounterState(req.tenantManager || req);
    res.json({ current: state.total, target: state.target, label: state.label, textPosition: state.textPosition, countPosition: state.countPosition, progressDisplay: state.progressDisplay, textAlign: state.textAlign });
  } catch(e) { res.json({ current: 0, target: 50, label: 'Sub Goal', textPosition: 'inside', countPosition: 'inside', progressDisplay: 'count', textAlign: 'center' }); }
});

app.get('/api/widgets/subcounter', async (req, res) => {
  try { res.json(await getSubCounterState(req.tenantManager || req)); }
  catch(e) { res.json(SUB_COUNTER_DEFAULTS); }
});

app.post('/api/admin/widgets/subcounter/test', requireAuth, async (req, res) => {
  try {
    const type = ['new','gift','renewal'].includes(req.body.type) ? req.body.type : 'new';
    const username = String(req.body.username || 'TestSub').slice(0, 40);
    const count = Math.max(1, parseInt(req.body.count || 1) || 1);
    const months = Math.max(1, parseInt(req.body.months || 1) || 1);
    const state = await recordSubEvent(type, { username, gifter: username, count, months }, req.tenantManager || req);
    res.json({ success: true, state });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subcounter/total', requireAuth, async (req, res) => {
  try {
    const total = Math.max(0, parseInt(req.body.total) || 0);
    await req.tenantManager.setSetting('subcounter_total', String(total));
    await req.tenantManager.setSetting('subgoal_current', String(total));
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subcounter/session/reset', requireAuth, async (req, res) => {
  try {
    await req.tenantManager.setSetting('subcounter_session', '0');
    await req.tenantManager.setSetting('subcounter_renewals', '0');
    await req.tenantManager.setSetting('subcounter_gifts', '0');
    await req.tenantManager.setSetting('subcounter_latest', '[]');
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/admin/widgets/subgoal/label', requireAuth, async (req, res) => {
  try {
    const label = String(req.body.label || 'Sub Goal').trim().slice(0, 40) || 'Sub Goal';
    await req.tenantManager.setSetting('subgoal_label', label);
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
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
    await req.tenantManager.setSetting('subgoal_text_position', textPosition);
    await req.tenantManager.setSetting('subgoal_count_position', countPosition);
    await req.tenantManager.setSetting('subgoal_progress_display', progressDisplay);
    await req.tenantManager.setSetting('subgoal_text_align', textAlign);
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/subgoal/target', requireAuth, async (req, res) => {
  try {
    const target = Math.max(1, parseInt(req.body.target) || 50);
    await req.tenantManager.setSetting('subgoal_target', String(target));
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/subgoal/adjust', requireAuth, async (req, res) => {
  try {
    const delta = parseInt(req.body.delta) || 0;
    const state = await getSubCounterState(req.tenantManager || req);
    const total = Math.max(0, state.total + delta);
    await req.tenantManager.setSetting('subcounter_total', String(total));
    await req.tenantManager.setSetting('subgoal_current', String(total));
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/widgets/subgoal/reset', requireAuth, async (req, res) => {
  try {
    await req.tenantManager.setSetting('subcounter_total', '0');
    await req.tenantManager.setSetting('subgoal_current', '0');
    res.json({ success: true, ...(await emitSubCounterState(req.tenantManager || req)) });
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
// Etat mémoire Song Request V2 : 100 % isolé par streamer.
// Chaque streamer a sa file, son lecteur, son volume et ses commandes OBS.
const songRequestControlSeqByStreamer = new Map();
const songRequestDesiredStatusByStreamer = new Map();

function getSongRequestTM(reqOrTm = null) {
  if (reqOrTm && typeof reqOrTm.getSetting === 'function') return reqOrTm;
  if (reqOrTm?.tenantManager) return reqOrTm.tenantManager;
  return createTenantManager({ db, io, req: reqOrTm || null, streamer: reqOrTm?.streamer || null });
}
function songRequestSlug(tm) {
  return tenant.normalizeSlug(tm?.slug || tenant.getCurrentStreamerSlug());
}
function rejectInvalidSongRequestOverlay(req, res) {
  // Si une source OBS utilise /o/<token>/songrequest.html, le token doit rester valide.
  // On ne doit jamais retomber sur le cookie streamer, sinon un ancien lien régénéré
  // continue à piloter/écouter le lecteur.
  const token = String(req?.query?.overlayToken || req?.headers?.['x-overlay-token'] || '').trim();
  if (!token) return false;
  const widget = String(req?.overlayTokenRow?.widget || '').toLowerCase();
  if (req.overlayTokenInvalid || widget !== 'songrequest') {
    res.status(410).json({ success:false, invalidOverlay:true, error:'Lien OBS Song Request expiré ou régénéré.' });
    return true;
  }
  return false;
}
function getSongRequestSeq(tm) {
  const slug = songRequestSlug(tm);
  if (!songRequestControlSeqByStreamer.has(slug)) songRequestControlSeqByStreamer.set(slug, Date.now());
  return songRequestControlSeqByStreamer.get(slug);
}
function nextSongRequestSeq(tm) {
  const slug = songRequestSlug(tm);
  const seq = getSongRequestSeq(tm) + 1;
  songRequestControlSeqByStreamer.set(slug, seq);
  return seq;
}
function getSongRequestDesiredStatus(tm) {
  return songRequestDesiredStatusByStreamer.get(songRequestSlug(tm)) || null;
}
function setSongRequestDesiredStatus(tm, status) {
  if (!status) songRequestDesiredStatusByStreamer.delete(songRequestSlug(tm));
  else songRequestDesiredStatusByStreamer.set(songRequestSlug(tm), status);
}

async function getSongRequestPlayerState(reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const state = await tm.getJson('songrequest_player_state', {});
  return {
    itemId: state?.itemId || '',
    status: state?.status || 'stopped',
    currentTime: Number(state?.currentTime || 0),
    duration: Number(state?.duration || 0),
    volume: (() => { const v = Number(state?.volume); return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100; })(),
    updatedAt: state?.updatedAt || null
  };
}
async function saveSongRequestPlayerState(patch = {}, emit = true, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const prev = await getSongRequestPlayerState(tm);
  const next = { ...prev, ...patch, streamer: songRequestSlug(tm), updatedAt: new Date().toISOString() };
  await tm.setJson('songrequest_player_state', next);
  if (emit) tm.emit('songrequest-player-state', next);
  return next;
}

async function getSongRequestControl(reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const control = await tm.getJson('songrequest_control', {});
  return {
    seq: Number(control?.seq || getSongRequestSeq(tm) || 0),
    action: control?.action || '',
    seconds: Number(control?.seconds || 0),
    volume: Number(control?.volume ?? 100),
    at: control?.at || null
  };
}
function emitSongRequestControlNow(action, payload = {}, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const control = {
    seq: nextSongRequestSeq(tm),
    action,
    ...payload,
    streamer: songRequestSlug(tm),
    at: new Date().toISOString()
  };
  tm.emit('songrequest-control', control);
  return control;
}
async function issueSongRequestControl(action, payload = {}, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const control = emitSongRequestControlNow(action, payload, tm);
  tm.setJson('songrequest_control', control).catch(e => {
    console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde contrôle impossible:`, e.message);
  });
  return control;
}

async function getSongRequestState(reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  let queue = await tm.getJson('songrequest_queue', []);
  queue = Array.isArray(queue) ? queue : [];
  const player = await getSongRequestPlayerState(tm);
  const currentItem = queue[0] || null;
  if (!currentItem) {
    player.itemId = '';
    player.status = 'stopped';
    player.currentTime = 0;
    player.duration = 0;
  } else if (player.itemId && player.itemId !== currentItem.id) {
    player.itemId = currentItem.id;
    player.currentTime = 0;
    player.duration = currentItem.duration || 0;
    if (player.status === 'stopped') player.status = 'playing';
  } else if (!player.itemId) {
    player.itemId = currentItem.id;
  }
  const desired = getSongRequestDesiredStatus(tm);
  if (currentItem && ['playing','paused','stopped'].includes(desired || '')) {
    player.status = desired;
  }
  const skipEnabled = await tm.getBool('songrequest_skip_vote_enabled', true);
  const skipRequired = Math.min(50, Math.max(1, parseInt(await tm.getSetting('songrequest_skip_vote_required', '3')) || 3));
  const storedVotes = await tm.getJson('songrequest_skip_votes', {});
  const skipVoters = currentItem && String(storedVotes?.itemId || '') === String(currentItem.id)
    ? [...new Set((Array.isArray(storedVotes.voters) ? storedVotes.voters : []).map(v => String(v).toLowerCase()))]
    : [];
  return {
    streamer: songRequestSlug(tm),
    enabled: await tm.getBool('songrequest_enabled', true),
    command: await tm.getSetting('songrequest_command', '!sr'),
    confirmMessage: await tm.getSetting('songrequest_confirm', '🎵 @{username}, ta musique a été ajoutée à la file !'),
    chatConfirmEnabled: (await tm.getSetting('songrequest_chat_confirm_enabled', '0')) === '1',
    nowPlayingChatEnabled: (await tm.getSetting('songrequest_now_playing_chat_enabled', '1')) === '1',
    nowPlayingMessage: await tm.getSetting('songrequest_now_playing_message', '🎵 Lecture : {title} · demandé par @{username}'),
    maxQueue: parseInt(await tm.getSetting('songrequest_max_queue', '30')) || 30,
    skipVoteEnabled: skipEnabled,
    skipVoteRequired: skipRequired,
    skipVotes: { count:skipVoters.length, voters:skipVoters },
    queue,
    player,
    control: await getSongRequestControl(tm)
  };
}

async function announceSongRequestNow(item,reqOrTm=null){
  if(!item)return;const tm=getSongRequestTM(reqOrTm);if((await tm.getSetting('songrequest_now_playing_chat_enabled','1'))!=='1')return;
  const template=await tm.getSetting('songrequest_now_playing_message','🎵 Lecture : {title} · demandé par @{username}');const message=String(template||'').replace(/\{title\}/gi,item.title||item.song||'Musique').replace(/\{username\}/gi,String(item.username||'Anonyme').replace(/^@+/,''));
  if(message.trim())await tenant.runWithStreamer({id:tm.streamerId,slug:tm.slug},()=>shared.sendChat(message.trim()));
}

async function saveSongRequestQueue(queue, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const clean = Array.isArray(queue) ? queue.slice(0, 100) : [];
  await tm.setJson('songrequest_queue', clean);
  if (!clean.length) {
    await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 }, false, tm);
  }
  tm.emit('songrequest-update', { streamer: songRequestSlug(tm), queue: clean });
  return clean;
}

const songRequestSkipLocks = new Map();
async function voteSongRequestSkipUnlocked(username, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const state = await getSongRequestState(tm);
  if (!state.enabled) return { error:'Le Song Request est désactivé.' };
  if (!state.skipVoteEnabled) return { error:'Le vote !skip est désactivé sur cette chaîne.' };
  const current = state.queue[0];
  if (!current) return { error:'Aucune musique n’est en lecture.' };
  const voter = String(username || '').trim().toLowerCase();
  if (!voter) return { error:'Pseudo invalide.' };
  const required = state.skipVoteRequired;
  const voters = Array.isArray(state.skipVotes?.voters) ? state.skipVotes.voters.slice() : [];
  if (voters.includes(voter)) return { success:true, duplicate:true, votes:voters.length, required };
  voters.push(voter);
  await tm.setJson('songrequest_skip_votes', { itemId:current.id, voters, updatedAt:new Date().toISOString() });
  tm.emit('songrequest-skip-votes', { itemId:current.id, count:voters.length, required });
  if (voters.length < required) return { success:true, votes:voters.length, required };

  state.queue.shift();
  await saveSongRequestQueue(state.queue, tm);
  await tm.setJson('songrequest_skip_votes', {});
  const next = state.queue[0] || null;
  setSongRequestDesiredStatus(tm, next ? 'playing' : 'stopped');
  await saveSongRequestPlayerState({ itemId:next?.id || '', status:next ? 'playing' : 'stopped', currentTime:0, duration:next?.duration || 0 }, true, tm);
  await issueSongRequestControl('next', {}, tm);
  await announceSongRequestNow(next,tm);
  return { success:true, skipped:true, votes:voters.length, required, next:next?.title || '' };
}

async function voteSongRequestSkip(username, reqOrTm = null) {
  const tm=getSongRequestTM(reqOrTm), key=String(tm.streamerId||tm.slug||'default');
  const previous=songRequestSkipLocks.get(key)||Promise.resolve();
  let release;
  const current=new Promise(resolve=>{release=resolve});
  songRequestSkipLocks.set(key,current);
  await previous.catch(()=>{});
  try{return await voteSongRequestSkipUnlocked(username,tm)}
  finally{release();if(songRequestSkipLocks.get(key)===current)songRequestSkipLocks.delete(key)}
}

async function addSongRequest(username, song, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const state = await getSongRequestState(tm);
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
  const startsNow=state.queue.length===0;state.queue.push(item);
  await saveSongRequestQueue(state.queue, tm);
  if(startsNow)await announceSongRequestNow(item,tm);
  console.log(`[SONGREQUEST:${songRequestSlug(tm)}] Ajouté: ${item.title || item.song} (${item.videoId || 'sans vidéo'})`);
  return item;
}

try {
  shared.registerSongRequestAdder(async (username, song, ctx = null) => {
    const run = async () => {
      const tm = createTenantManager({ db, io, streamer: ctx?.streamer || (ctx?.streamerId ? { id: ctx.streamerId, slug: ctx.slug } : null) });
      const item = await addSongRequest(username, song, tm);
      return { ok: true, item, streamer: songRequestSlug(tm) };
    };
    if (ctx?.streamerId && tenant?.runWithStreamer) {
      return tenant.runWithStreamer({ id: ctx.streamerId, slug: ctx.slug }, run);
    }
    return run();
  });
  shared.registerSongRequestSkipVoter(async (username, ctx = null) => {
    const run = async () => {
      const tm = createTenantManager({ db, io, streamer: ctx?.streamer || (ctx?.streamerId ? { id:ctx.streamerId, slug:ctx.slug } : null) });
      return voteSongRequestSkip(username, tm);
    };
    if (ctx?.streamerId && tenant?.runWithStreamer) return tenant.runWithStreamer({ id:ctx.streamerId, slug:ctx.slug }, run);
    return run();
  });
  console.log('[SONGREQUEST] Pont panel/bot V2 enregistré ✓');
} catch(e) {
  console.warn("[SONGREQUEST] Impossible d'enregistrer le pont panel/bot:", e.message);
}

app.get('/api/widgets/songrequest', async (req, res) => {
  if (rejectInvalidSongRequestOverlay(req, res)) return;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try { res.json(await getSongRequestState(req)); }
  catch(e) { res.json({ enabled:false, command:'!sr', confirmMessage:'', maxQueue:30, queue:[], player:{status:'stopped'} }); }
});

app.post('/api/admin/widgets/songrequest/settings', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    if (typeof req.body.enabled === 'boolean') await tm.setBool('songrequest_enabled', req.body.enabled);
    if (typeof req.body.command === 'string') {
      let command = req.body.command.trim().slice(0,20) || '!sr';
      if (!command.startsWith('!')) command = '!' + command;
      await tm.setSetting('songrequest_command', command.toLowerCase());
    }
    if (typeof req.body.confirmMessage === 'string') await tm.setSetting('songrequest_confirm', req.body.confirmMessage.trim().slice(0,180));
    if (typeof req.body.chatConfirmEnabled === 'boolean') await tm.setSetting('songrequest_chat_confirm_enabled', req.body.chatConfirmEnabled ? '1' : '0');
    if (typeof req.body.nowPlayingChatEnabled === 'boolean') await tm.setSetting('songrequest_now_playing_chat_enabled', req.body.nowPlayingChatEnabled ? '1' : '0');
    if (typeof req.body.nowPlayingMessage === 'string') await tm.setSetting('songrequest_now_playing_message', req.body.nowPlayingMessage.trim().slice(0,220));
    if (req.body.maxQueue !== undefined) await tm.setSetting('songrequest_max_queue', String(Math.min(100, Math.max(1, parseInt(req.body.maxQueue) || 30))));
    if (typeof req.body.skipVoteEnabled === 'boolean') await tm.setBool('songrequest_skip_vote_enabled', req.body.skipVoteEnabled);
    if (req.body.skipVoteRequired !== undefined) await tm.setSetting('songrequest_skip_vote_required', String(Math.min(50, Math.max(1, parseInt(req.body.skipVoteRequired) || 3))));
    const state = await getSongRequestState(tm);
    tm.emit('songrequest-settings-update', state);
    res.json({ success:true, ...state });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/add', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const item = await addSongRequest(req.body.username || 'Streamer', req.body.song || '', tm);
    res.json({ success:true, item, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/delete', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const id = req.body.id;
    const wasCurrent = state.queue[0]?.id === id;
    await saveSongRequestQueue(state.queue.filter(x => x.id !== id), tm);
    if (wasCurrent) await issueSongRequestControl('load-current', {}, tm);
    res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});


app.post('/api/admin/widgets/songrequest/move', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const id = String(req.body.id || '');
    const direction = String(req.body.direction || '').toLowerCase();
    const index = state.queue.findIndex(item => String(item.id) === id);

    if (index < 1) return res.status(400).json({ error:'Musique en attente introuvable' });

    const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
    if (target < 1 || target >= state.queue.length) {
      return res.json({ success:true, ...(await getSongRequestState(tm)) });
    }

    [state.queue[index], state.queue[target]] = [state.queue[target], state.queue[index]];
    await saveSongRequestQueue(state.queue, tm);
    return res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});


app.post('/api/admin/widgets/songrequest/reorder', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const current = state.queue[0] || null;
    const waiting = state.queue.slice(1);
    const requestedIds = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    const waitingById = new Map(waiting.map(item => [String(item.id), item]));

    if (requestedIds.length !== waiting.length || new Set(requestedIds).size !== requestedIds.length) {
      return res.status(400).json({ error:'Ordre de file invalide' });
    }

    const reordered = requestedIds.map(id => waitingById.get(id));
    if (reordered.some(item => !item)) {
      return res.status(400).json({ error:'Une musique de la file est introuvable' });
    }

    const queue = current ? [current, ...reordered] : reordered;
    await saveSongRequestQueue(queue, tm);
    return res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/play-item', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const id = String(req.body.id || '');
    const index = state.queue.findIndex(item => String(item.id) === id);
    if (index < 0) return res.status(404).json({ error:'Musique introuvable' });

    if (index > 0) {
      const [selected] = state.queue.splice(index, 1);
      state.queue.unshift(selected);
      await saveSongRequestQueue(state.queue, tm);
    }

    const current = state.queue[0] || null;
    setSongRequestDesiredStatus(tm, current ? 'playing' : 'stopped');
    await saveSongRequestPlayerState({
      itemId: current?.id || '',
      status: current ? 'playing' : 'stopped',
      currentTime: 0,
      duration: current?.duration || 0
    }, true, tm);
    await issueSongRequestControl('load-current', { autoplay:true }, tm);
    await announceSongRequestNow(current,tm);
    return res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/update-item', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const id = String(req.body.id || '');
    const item = state.queue.find(entry => String(entry.id) === id);
    if (!item) return res.status(404).json({ error:'Musique introuvable' });

    if (typeof req.body.title === 'string') item.title = req.body.title.trim().slice(0, 160) || item.title;
    if (typeof req.body.username === 'string') item.username = req.body.username.trim().slice(0, 60) || 'Anonyme';

    await saveSongRequestQueue(state.queue, tm);
    return res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/widgets/songrequest/next', async (req, res) => {
  if (rejectInvalidSongRequestOverlay(req, res)) return;
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    state.queue.shift();
    await saveSongRequestQueue(state.queue, tm);
    setSongRequestDesiredStatus(tm, state.queue[0] ? 'playing' : 'stopped');
    await saveSongRequestPlayerState({ itemId: state.queue[0]?.id || '', status: state.queue[0] ? 'playing' : 'stopped', currentTime: 0, duration: state.queue[0]?.duration || 0 }, true, tm);
    await issueSongRequestControl('next', {}, tm);
    await announceSongRequestNow(state.queue[0],tm);
    res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/next', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    state.queue.shift();
    await saveSongRequestQueue(state.queue, tm);
    setSongRequestDesiredStatus(tm, state.queue[0] ? 'playing' : 'stopped');
    await saveSongRequestPlayerState({ itemId: state.queue[0]?.id || '', status: state.queue[0] ? 'playing' : 'stopped', currentTime: 0, duration: state.queue[0]?.duration || 0 }, true, tm);
    await issueSongRequestControl('next', {}, tm);
    await announceSongRequestNow(state.queue[0],tm);
    res.json({ success:true, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/clear', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    await saveSongRequestQueue([], tm);
    setSongRequestDesiredStatus(tm, 'stopped');
    await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 }, true, tm);
    await issueSongRequestControl('stop', {}, tm);
    res.json({ success:true, ...(await getSongRequestState(tm)) });
  }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/widgets/songrequest/play', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const cur = state.queue[0];
    const patch = { itemId: cur?.id || '', status: cur ? 'playing' : 'stopped' };

    setSongRequestDesiredStatus(tm, patch.status);

    // Temps réel d'abord : OBS reçoit PLAY immédiatement.
    const control = emitSongRequestControlNow('play', {}, tm);

    // Persistance ensuite, sans bloquer la réponse ni la commande OBS.
    tm.setJson('songrequest_control', control).catch(() => {});
    saveSongRequestPlayerState(patch, true, tm).catch(error => {
      console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde play impossible:`, error.message);
    });

    res.json({ success:true, player: { ...(state.player || {}), ...patch } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/pause', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestPlayerState(tm);
    const patch = { status:'paused' };

    setSongRequestDesiredStatus(tm, 'paused');

    const control = emitSongRequestControlNow('pause', {}, tm);
    tm.setJson('songrequest_control', control).catch(() => {});
    saveSongRequestPlayerState(patch, true, tm).catch(error => {
      console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde pause impossible:`, error.message);
    });

    res.json({ success:true, player: { ...state, ...patch } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/seek', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestPlayerState(tm);
    const seconds = Math.max(0, parseFloat(req.body.seconds || 0) || 0);
    const patch = { currentTime: seconds };

    const control = emitSongRequestControlNow('seek', { seconds }, tm);
    tm.setJson('songrequest_control', control).catch(() => {});
    saveSongRequestPlayerState(patch, true, tm).catch(error => {
      console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde seek impossible:`, error.message);
    });

    res.json({ success:true, player: { ...state, ...patch } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/admin/widgets/songrequest/volume', requireAuth, async (req, res) => {
  try {
    const tm = getSongRequestTM(req);
    const raw = Number(req.body.volume ?? 100);
    const volume = Math.max(0, Math.min(100, Number.isFinite(raw) ? Math.round(raw) : 100));
    const state = await getSongRequestPlayerState(tm);
    const next = { ...state, streamer: songRequestSlug(tm), volume, updatedAt: new Date().toISOString() };

    const control = emitSongRequestControlNow('volume', { volume }, tm);

    tm.setJson('songrequest_control', control).catch(() => {});
    tm.setJson('songrequest_player_state', next).catch(error => {
      console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde volume impossible:`, error.message);
    });
    tm.emit('songrequest-player-state', next);

    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/widgets/songrequest/player-state', async (req, res) => {
  if (rejectInvalidSongRequestOverlay(req, res)) return;
  try {
    const tm = getSongRequestTM(req);
    const state = await getSongRequestState(tm);
    const currentItem = state.queue[0] || null;
    const bodyItemId = typeof req.body.itemId === 'string' ? req.body.itemId : '';
    if (!currentItem) {
      const next = await saveSongRequestPlayerState({ itemId:'', status:'stopped', currentTime:0, duration:0 }, true, tm);
      return res.json({ success:true, ignored:true, player: next });
    }
    if (bodyItemId && bodyItemId !== currentItem.id) {
      return res.json({ success:true, ignored:true, player: state.player });
    }
    const patch = { itemId: currentItem.id };
    if (typeof req.body.status === 'string') {
      const status = String(req.body.status).toLowerCase();
      // Seule la fin réelle de YouTube peut modifier la commande officielle.
      // PLAY / PAUSE viennent uniquement du panel ou du Companion.
      if (status === 'ended') {
        patch.status = 'stopped';
        setSongRequestDesiredStatus(tm, 'stopped');
      }
    }
    if (req.body.currentTime !== undefined) patch.currentTime = Math.max(0, parseFloat(req.body.currentTime) || 0);
    if (req.body.duration !== undefined) patch.duration = Math.max(0, parseFloat(req.body.duration) || 0);
    // IMPORTANT : le volume est un réglage demandé par le panel/Companion, pas un état remonté par OBS.
    // Les widgets OBS, surtout les anciens liens encore ouverts, ne peuvent donc plus remettre le volume à 100.
    const next = await saveSongRequestPlayerState(patch, true, tm);
    res.json({ success:true, player: next });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

async function runSongRequestMacro(action, reqOrTm = null) {
  const tm = getSongRequestTM(reqOrTm);
  const state = await getSongRequestState(tm);
  const cur = state.queue[0] || null;

  if (action === 'toggle') {
    const currentStatus = getSongRequestDesiredStatus(tm) || state.player?.status || 'stopped';
    action = currentStatus === 'playing' ? 'pause' : 'play';
  }

  if (action === 'play') {
    setSongRequestDesiredStatus(tm, cur ? 'playing' : 'stopped');
    await issueSongRequestControl('play', {}, tm);
    const patch = { itemId: cur?.id || '', status: cur ? 'playing' : 'stopped' };
    saveSongRequestPlayerState(patch, true, tm).catch(e => console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde play macro impossible:`, e.message));
    return { action:'play', player: { ...(state.player || {}), ...patch } };
  }

  if (action === 'pause') {
    setSongRequestDesiredStatus(tm, 'paused');
    await issueSongRequestControl('pause', {}, tm);
    const patch = { status:'paused' };
    saveSongRequestPlayerState(patch, true, tm).catch(e => console.warn(`[SONGREQUEST:${songRequestSlug(tm)}] Sauvegarde pause macro impossible:`, e.message));
    return { action:'pause', player: { ...(state.player || {}), ...patch } };
  }

  if (action === 'next') {
    state.queue.shift();
    await saveSongRequestQueue(state.queue, tm);
    const nextItem = state.queue[0] || null;
    setSongRequestDesiredStatus(tm, nextItem ? 'playing' : 'stopped');
    await issueSongRequestControl('next', {}, tm);
    const next = await saveSongRequestPlayerState({ itemId: nextItem?.id || '', status: nextItem ? 'playing' : 'stopped', currentTime: 0, duration: nextItem?.duration || 0 }, true, tm);
    await announceSongRequestNow(nextItem,tm);
    return { action:'next', player: next };
  }

  if (action === 'stop') {
    setSongRequestDesiredStatus(tm, 'stopped');
    await issueSongRequestControl('stop', {}, tm);
    const next = await saveSongRequestPlayerState({ status:'stopped', currentTime:0 }, true, tm);
    return { action:'stop', player: next };
  }

  throw new Error('Action macro invalide');
}

async function songRequestMacroHandler(req, res) {
  if (rejectInvalidSongRequestOverlay(req, res)) return;
  try {
    const action = String(req.params.action || req.body?.action || 'toggle').toLowerCase();
    if (!['toggle','play','pause','next','stop'].includes(action)) return res.status(400).json({ error:'Action invalide' });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const tm = getSongRequestTM(req);
    const result = await runSongRequestMacro(action, tm);
    res.json({ success:true, streamer: songRequestSlug(tm), ...result, ...(await getSongRequestState(tm)) });
  } catch(e) { res.status(500).json({ error:e.message }); }
}
app.get('/api/widgets/songrequest/macro/:action', songRequestMacroHandler);
app.post('/api/widgets/songrequest/macro/:action', songRequestMacroHandler);
app.get('/api/songrequest/macro/:action', songRequestMacroHandler);
app.post('/api/songrequest/macro/:action', songRequestMacroHandler);

app.get('/api/chests', async (req, res) => {
  try { res.json(await chests.getPublicState()); } catch(e) { res.json({ season: null, chests: [] }); }
});
app.post('/api/admin/chests/new-season', requireAuth, async (req, res) => {
  try {
    const r = await chests.newSeason();
    io.emit('chests-update');
    const shared = require('./shared');
const tenant = require('./tenant');
const { createTenantManager } = require('./tenant-manager');
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
const tenant = require('./tenant');
const { createTenantManager } = require('./tenant-manager');
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
const tenant = require('./tenant');
const { createTenantManager } = require('./tenant-manager');
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

// Followers — toujours pour le compte Kick de la session courante.
app.get('/api/followers', requireAuth, requireTenant, async (req, res) => {
  try {
    const channel = req.streamer?.kick_username || req.streamer?.slug;
    if (!channel) return res.status(401).json({ count: 0, error: 'streamer_missing' });
    const data = await fetchKickAPI(channel);
    if (!data) return res.json({ count: 0 });
    const count = data?.followers_count || data?.followersCount || 0;
    res.set('Cache-Control', 'no-store');
    res.json({ count, channel });
  } catch(e) { res.json({ count: 0 }); }
});

// État live séparé par streamer. Une mise à jour du panel A ne peut plus écraser B.
const liveFromBrowserByStreamer = new Map();
const forcedLiveStatusByStreamer = new Map();
function currentStreamerKey(req) { return Number(req.streamer?.id || req.authSession?.streamerId || 0); }

app.post('/api/live/update', requireAuth, requireTenant, (req, res) => {
  const streamerId = currentStreamerKey(req);
  if (!streamerId) return res.status(401).json({ error: 'streamer_missing' });
  const { live, viewers, followers, vodUuid, streamTitle, streamStartedAt } = req.body;
  liveFromBrowserByStreamer.set(streamerId, {
    live: !!live, viewers: Number(viewers)||0, followers: Number(followers)||0,
    vodUuid: vodUuid||'', streamTitle: streamTitle||'', streamStartedAt: streamStartedAt||null,
    updatedAt: Date.now()
  });
  res.json({ success: true });
});

app.post('/api/admin/live/force', requireAuth, requireTenant, (req,res) => {
  const streamerId = currentStreamerKey(req);
  const { status } = req.body;
  const forced = status === 'on' ? true : status === 'off' ? false : null;
  if (forced === null) forcedLiveStatusByStreamer.delete(streamerId);
  else forcedLiveStatusByStreamer.set(streamerId, forced);
  res.json({ success:true, forced });
});
app.get('/api/admin/live/status', requireAuth, requireTenant, (req,res) => {
  const streamerId = currentStreamerKey(req);
  res.json({ forced: forcedLiveStatusByStreamer.has(streamerId) ? forcedLiveStatusByStreamer.get(streamerId) : null });
});

app.get('/api/live', requireAuth, requireTenant, async (req,res) => {
  const streamerId = currentStreamerKey(req);
  const forced = forcedLiveStatusByStreamer.has(streamerId) ? forcedLiveStatusByStreamer.get(streamerId) : null;
  if (forced !== null) return res.json({ live:forced, viewers:0, forced:true });

  const browserState = liveFromBrowserByStreamer.get(streamerId);
  if (browserState?.updatedAt && Date.now() - browserState.updatedAt < 120000) {
    return res.json({ ...browserState, source: 'browser' });
  }

  try {
    const channel = req.streamer?.kick_username || req.streamer?.slug;
    if (!channel) return res.status(401).json({ live:false, viewers:0, error:'streamer_missing' });
    const data = await fetchKickAPI(channel);
    if (!data) return res.json({ live:false, viewers:0, error:'api_blocked' });
    const live = data?.livestream;
    res.set('Cache-Control', 'no-store');
    res.json({
      live: !!live,
      viewers: live?.viewer_count || 0,
      followers: data?.followers_count || data?.followersCount || 0,
      channel,
      source: 'server',
    });
  } catch(e) { res.json({ live:false, viewers:0 }); }
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

async function generateTTSAudio(text, voiceIdOverride = '') {
  const cfg = await getTTSSettings();
  const voiceId=String(voiceIdOverride||cfg.voiceId||'');
  if (!cfg.apiKey || !voiceId || voiceId==='system-fr') return null;
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: cfg.stability, similarity_boost: cfg.similarityBoost } },
      { headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 }
    );
    return Buffer.from(r.data).toString('base64');
  } catch(e) {
    console.error('[TTS] Erreur ElevenLabs:', e.response?.status || e.message);
    return null;
  }
}

let memeVoicesCache={at:0,rows:[]};
let memeElevenLabsDisabledUntil=0;
async function getPublicMemeVoices(){
  if(Date.now()-memeVoicesCache.at<10*60*1000&&memeVoicesCache.rows.length)return memeVoicesCache.rows;
  const cfg=await getTTSSettings(),rows=[
    {id:'builtin:female-fr',name:'Femme · Français'},{id:'builtin:male-fr',name:'Homme · Français'},
    {id:'builtin:robot-fr',name:'Robot · Français'},{id:'builtin:en',name:'English voice'},
    {id:'builtin:es',name:'Voz española'},{id:'builtin:de',name:'Deutsche Stimme'},
    {id:'builtin:it',name:'Voce italiana'},{id:'builtin:ja',name:'日本語の音声'}
  ];
  if(cfg.apiKey&&Date.now()>=memeElevenLabsDisabledUntil)try{const r=await axios.get('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':cfg.apiKey.trim()},timeout:10000});for(const v of (r.data?.voices||[]).slice(0,30))rows.push({id:String(v.voice_id),name:String(v.name||'Voix IA')})}catch(e){
    // Une ancienne cle enregistree ne doit ni polluer les logs ni bloquer les
    // voix integrees du navigateur. Une erreur d'authentification suspend
    // ElevenLabs pendant une heure; les voix femme/homme/robot restent actives.
    if(Number(e.response?.status)===401)memeElevenLabsDisabledUntil=Date.now()+60*60*1000;
    else console.warn('[MEMES TTS] Service externe temporairement indisponible:',e.response?.status||e.message);
  }
  memeVoicesCache={at:Date.now(),rows};return rows;
}

async function generateFallbackTTSAudio(text) {
  try {
    const r = await axios.get('https://translate.google.com/translate_tts', {
      params: { ie:'UTF-8', client:'tw-ob', tl:'fr', q:String(text || '').slice(0, 160) },
      headers: { 'User-Agent':'Mozilla/5.0', Accept:'audio/mpeg,*/*' },
      responseType:'arraybuffer', timeout:15000
    });
    return Buffer.from(r.data).toString('base64');
  } catch(e) {
    console.error('[TTS MEMES] Voix de secours indisponible:', e.response?.status || e.message);
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

    const donationTM = getAlertTM(req);
    await pushObsAlert('donation', { username, amount: amount.toFixed(2), message }, false, donationTM).catch(e => console.warn('[ALERT OBS] donation ignorée:', e.message));

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
app.get('/classement', (req,res) => res.redirect('/'));



function getLegacyStreamerCookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER) || Boolean(process.env.RENDER_EXTERNAL_URL);
  return { path: '/', sameSite: 'lax', secure, httpOnly: true };
}
function setStreamerSessionCookie(res, slug) {
  const clean = tenant.normalizeSlug(slug);
  res.cookie('kb_streamer', clean, {
    ...getLegacyStreamerCookieOptions(),
    maxAge: 60 * 60 * 24 * 365 * 1000,
  });
}
function clearStreamerCookie(res) {
  res.clearCookie('kb_streamer', getLegacyStreamerCookieOptions());
}


// Connexion du compte BOT unique (ex: BOT7UP). Ce compte est utilisé uniquement
// pour écrire dans les chats, jamais pour identifier le panel streamer.
app.get('/auth/bot/login', (req, res) => {
  if (!kickOAuth.isConfigured()) {
    return res.status(400).send('KICK_CLIENT_ID, KICK_CLIENT_SECRET ou KICK_REDIRECT_URI manquant dans les variables Render.');
  }
  const url = kickOAuth.getAuthorizationUrl(null, { mode: 'bot_login', returnTo: '/api/v2/core/status' });
  console.log('[OAUTH BOT] Connexion du compte bot lancée');
  res.redirect(url);
});

// Connexion d'une identité de bot. Le streamer reste connecté avec son propre
// compte dans le panel ; cette autorisation OAuth concerne uniquement le compte
// qui écrira dans le chat.
app.get('/auth/bot-identity/login', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    if (!kickOAuth.isConfigured()) return res.status(400).send('OAuth Kick non configuré sur le serveur.');
    const choice = String(req.query.choice || '').trim().toLowerCase();
    const options = await db.getBotAssignmentOptions(req.streamer.id);
    let identityId = null;
    if (choice === 'elbot') {
      if (!req.platformAdmin) return res.status(403).send('Seul l’administrateur ElBot peut autoriser le compte global ElBot.');
      identityId = options.elbot?.id;
    } else if (choice === 'custom') {
      if (!options.premium && !req.platformAdmin) return res.status(403).send('Le bot personnalisé est réservé aux comptes Premium.');
    } else {
      return res.status(400).send('Identité de bot invalide.');
    }
    const url = kickOAuth.getAuthorizationUrl(null, {
      mode: 'bot_identity_login',
      returnTo: `/s/${encodeURIComponent(req.streamer.slug)}/dashboard`,
      streamerId: req.streamer.id,
      identityId,
      botType: choice,
      platformAdmin: Boolean(req.platformAdmin)
    });
    res.redirect(url);
  } catch (e) { res.status(500).send(e.message); }
});

// ════════════════════════════════════════════════════════════════════
// OAuth Kick officiel (id.kick.com) — refresh automatique du token
// ════════════════════════════════════════════════════════════════════

app.get('/auth/login', (req, res) => {
  // Une session encore valide ouvre directement le panel : aucune nouvelle
  // autorisation Kick n'est demandée tant que l'utilisateur ne se déconnecte pas.
  if (req.authStreamer?.slug) {
    return res.redirect(`/s/${encodeURIComponent(req.authStreamer.slug)}/dashboard`);
  }
  if (!kickOAuth.isConfigured()) {
    return res.status(400).send('KICK_CLIENT_ID, KICK_CLIENT_SECRET ou KICK_REDIRECT_URI manquant dans le fichier .env.');
  }
  const url = kickOAuth.getAuthorizationUrl(null, { mode: 'streamer_login', returnTo: '' });
  console.log('[OAUTH LOGIN V2] Connexion streamer Kick lancée');
  return res.redirect(url);
});

const MEME_AUTH_COOKIE='elbot_meme_identity';
function memeAuthCookieOptions(req){const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();return{httpOnly:true,secure:forwarded==='https'||req.secure||process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:30*86400000}}
app.get('/auth/meme/login',async(req,res)=>{
  try{
    if(!kickOAuth.isConfigured())return res.status(503).send('Connexion Kick indisponible.');
    const token=String(req.query.token||''),streamer=await db.getStreamerBySlug(tenant.normalizeSlug(req.query.streamer||''));
    if(!streamer)return res.status(404).send('Chaîne inconnue.');
    const access=await db.getMemeAccessToken(token,streamer.id);if(!access)return res.status(410).send('Lien meme expiré. Retape !meme dans le chat.');
    const url=kickOAuth.getAuthorizationUrl('user:read',{mode:'meme_viewer_login',memeToken:token,streamerId:streamer.id,expectedUsername:access.username,returnTo:`/memes/${streamer.slug}?token=${token}`});
    res.redirect(url);
  }catch(e){res.status(500).send(e.message)}
});
app.get('/auth/meme/moderator',async(req,res)=>{
  try{
    if(!kickOAuth.isConfigured())return res.status(503).send('Connexion Kick indisponible.');
    const streamer=await db.getStreamerBySlug(tenant.normalizeSlug(req.query.streamer||''));if(!streamer)return res.status(404).send('Chaîne inconnue.');
    res.redirect(kickOAuth.getAuthorizationUrl('user:read',{mode:'meme_moderator_login',streamerId:streamer.id,returnTo:`/memes-moderation/${streamer.slug}`}));
  }catch(e){res.status(500).send(e.message)}
});

app.get('/auth/callback', async (req, res) => {
  console.log('[OAUTH CALLBACK V2] Requête reçue — query:', JSON.stringify(req.query));
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`Erreur Kick: ${error} — ${error_description || ''}`);
    if (!code || !state) return res.status(400).send('Code ou state manquant.');

    const token = await kickOAuth.exchangeCodeForToken(code, state);
    const mode = token.meta?.mode || 'streamer_login';
    const kickUser = await kickOAuth.fetchCurrentUser(token.accessToken);
    const username = kickUser.username || kickUser.displayName || kickUser.id;
    if(mode==='meme_viewer_login'){
      const streamerId=Number(token.meta?.streamerId),memeToken=String(token.meta?.memeToken||''),streamer=await db.getStreamerById(streamerId),access=await db.getMemeAccessToken(memeToken,streamerId);
      if(!streamer||!access)throw new Error('Lien meme expiré. Retape !meme dans le chat.');
      const expected=tenant.normalizeSlug(access.username),connected=tenant.normalizeSlug(username);
      if(!connected||connected!==expected)throw new Error(`Ce lien est réservé à @${access.username}. Tu es connecté avec @${username||'inconnu'}.`);
      const identity=await db.createMemeAuthSession(streamerId,kickUser.id||'',connected,'viewer');
      await db.authenticateMemeAccessToken(memeToken,streamerId,kickUser.id||'',identity.session_token);
      res.cookie(MEME_AUTH_COOKIE,identity.session_token,memeAuthCookieOptions(req));
      console.log(`[MEME AUTH:${streamer.slug}] @${access.username} vérifié par Kick (${kickUser.id||'id inconnu'})`);
      return res.redirect(`/memes/${encodeURIComponent(streamer.slug)}?token=${encodeURIComponent(memeToken)}`);
    }
    if(mode==='meme_moderator_login'){
      const streamerId=Number(token.meta?.streamerId),streamer=await db.getStreamerById(streamerId);
      if(!streamer)throw new Error('Chaîne inconnue.');
      if(!await verifyMemeModerator(streamer,username,kickUser.id||''))throw new Error(`@${username} n’est pas modérateur de la chaîne ${streamer.slug}.`);
      const identity=await db.createMemeAuthSession(streamerId,kickUser.id||'',username,'moderator');
      res.cookie(MEME_AUTH_COOKIE,identity.session_token,memeAuthCookieOptions(req));
      return res.redirect(`/memes-moderation/${encodeURIComponent(streamer.slug)}`);
    }
    if (mode === 'bot_login') {
      const bot7up = await db.getBotIdentityByKey('bot7up');
      if (bot7up) {
        await db.saveOAuthToken(bot7up.oauth_provider, token.accessToken, token.refreshToken, token.expiresAt);
        await db.markBotIdentityConnected(bot7up.id, kickUser);
      }
      await db.setBotStatus('bot_oauth_username', username || 'bot');
      await db.setBotStatus('bot_oauth_connected_at', Date.now().toString());
      console.log(`[OAUTH BOT] ✅ Compte bot connecté: ${username}`);
      return res.redirect('/api/v2/core/status');
    }
    if (mode === 'bot_identity_login') {
      const streamerId = Number(token.meta?.streamerId);
      const botType = String(token.meta?.botType || '').toLowerCase();
      const streamer = await db.getStreamerById(streamerId);
      if (!streamer) throw new Error('Streamer de destination introuvable.');
      let identity;
      if (botType === 'elbot') {
        const connectedBotSlug = tenant.normalizeSlug(username);
        if (!['elbotapp','eibotapp'].includes(connectedBotSlug)) throw new Error(`Le compte connecté est ${username}. Connecte obligatoirement le compte Kick ElBotApp/EIBotApp.`);
        identity = await db.getBotIdentityById(token.meta?.identityId) || await db.getBotIdentityByKey('elbot');
        if (!identity || identity.bot_key !== 'elbot') throw new Error('Identité ElBot invalide.');
        await db.saveOAuthToken(identity.oauth_provider, token.accessToken, token.refreshToken, token.expiresAt);
        await db.markBotIdentityConnected(identity.id, kickUser);
        await db.enableStreamersForBotIdentity(identity.id);
      } else if (botType === 'custom') {
        const options = await db.getBotAssignmentOptions(streamerId);
        if (!options.premium && !token.meta?.platformAdmin) throw new Error('Ce streamer ne possède pas l’offre Premium.');
        identity = await db.connectCustomBotIdentity(streamerId, kickUser);
        await db.saveOAuthToken(identity.oauth_provider, token.accessToken, token.refreshToken, token.expiresAt);
        await db.assignBotIdentity(streamerId, 'custom', { platformAdmin:Boolean(token.meta?.platformAdmin) });
        await db.enableStreamersForBotIdentity(identity.id);
      } else {
        throw new Error('Type de bot OAuth invalide.');
      }
      console.log(`[OAUTH BOT V3] ✅ ${identity.display_name} connecté pour ${streamer.slug}`);
      return res.redirect(`/s/${encodeURIComponent(streamer.slug)}/dashboard?bot_connected=1`);
    }
    if (!username) throw new Error('Kick n’a pas renvoyé de pseudo exploitable.');
    const slug = tenant.normalizeSlug(username);

    const channelInfo = await kickOAuth.fetchChannelInfoForUser(token.accessToken, kickUser).catch(() => ({}));
    const streamer = await db.upsertStreamer({
      slug,
      kickUserId: kickUser.id || null,
      kickUsername: username,
      displayName: kickUser.displayName || username,
      avatarUrl: kickUser.avatar || '',
      channelId: channelInfo.channelId || null,
      chatroomId: channelInfo.chatroomId || null,
      broadcasterUserId: channelInfo.broadcasterUserId || kickUser.id || null,
      role: 'streamer',
      status: 'active',
      botEnabled: 1
    });

    await db.saveOAuthToken(kickOAuth.providerForStreamer(streamer.id), token.accessToken, token.refreshToken, token.expiresAt);
    try {
      await kickOAuth.subscribeStreamerEvents(token.accessToken, streamer.broadcaster_user_id || kickUser.id);
      await db.setStreamerSetting(streamer.id, 'kick_event_subscription_status', 'active');
      await db.setStreamerSetting(streamer.id, 'kick_event_subscription_error', '');
      console.log(`[OAUTH CALLBACK V2] ✅ Webhooks Kick enregistrés pour ${slug}`);
    } catch (subscriptionError) {
      await db.setStreamerSetting(streamer.id, 'kick_event_subscription_status', 'error').catch(()=>{});
      await db.setStreamerSetting(streamer.id, 'kick_event_subscription_error', String(subscriptionError.response?.data?.message || subscriptionError.message || '').slice(0, 300)).catch(()=>{});
      console.error(`[OAUTH CALLBACK V2] Webhooks Kick non enregistrés pour ${slug}:`, subscriptionError.response?.data || subscriptionError.message);
    }
    // Compatibilité V1 : si c'est le streamer par défaut, on garde aussi le provider global kick.
    if (slug === tenant.DEFAULT_STREAMER_SLUG) {
      await db.saveOAuthToken('kick', token.accessToken, token.refreshToken, token.expiresAt);
    }

    // Nouvelle connexion : on annule aussi un éventuel panel ouvert en mode super-admin.
clearAdminTargetCookie(req, res);

// La session est obligatoirement liée au streamer réellement retourné par Kick.
setSessionCookie(req, res, {
  id: streamer.id,
  slug: streamer.slug
});

// Ancien cookie conservé temporairement pour les parties V2 encore compatibles.
setStreamerSessionCookie(res, streamer.slug); // compatibilité temporaire avec les pages publiques V2
    console.log(`[OAUTH CALLBACK V2] ✅ Streamer connecté: ${slug} (#${streamer.id})`);
    res.redirect(`/s/${slug}/dashboard`);
  } catch (e) {
    console.error('[OAUTH CALLBACK V2] ❌ Exception:', e.response?.data || e.message, e.stack);
    res.status(500).send(`<pre style="color:#ff5c7a;background:#111;padding:20px;font-family:monospace;white-space:pre-wrap">Erreur OAuth V2: ${e.message}\n\n${e.stack || ''}</pre>`);
  }
});


app.get('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  clearAdminTargetCookie(req, res);
  clearStreamerCookie(res);
  res.redirect('/login');
});

app.get('/api/oauth/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const configured = kickOAuth.isConfigured();

  try {
    if (!req.authSession?.streamerId || !req.authStreamer) {
      return res.json({
        configured,
        authenticated: false,
        connected: false,
        streamer: null
      });
    }

    const streamer = req.authStreamer;

    const connected = await kickOAuth
      .isConnected(streamer.id)
      .catch(() => false);

    return res.json({
      configured,
      authenticated: true,
      connected: Boolean(connected),
      streamer: {
        id: streamer.id,
        slug: streamer.slug,
        displayName:
          streamer.display_name ||
          streamer.displayName ||
          streamer.kick_username ||
          streamer.slug
      }
    });
  } catch (error) {
    console.error('[OAUTH STATUS]', error);

    return res.json({
      configured,
      authenticated: false,
      connected: false,
      streamer: null
    });
  }
});

app.post('/api/admin/oauth/disconnect', requireAuth, requireTenant, async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    await kickOAuth.disconnect(tm.streamerId);
    clearStreamerCookie(res);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-identity', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const options = await db.getBotAssignmentOptions(req.streamer.id);
    res.set('Cache-Control', 'no-store');
    const clean = identity => identity ? {
      id: identity.id,
      key: identity.bot_key,
      displayName: identity.display_name,
      kickUsername: identity.kick_username,
      kind: identity.kind,
      status: identity.status
    } : null;
    res.json({ data: {
      streamer: { id:req.streamer.id, slug:req.streamer.slug, plan:req.streamer.plan || 'standard' },
      assigned: clean(options.assigned),
      elbot: clean(options.elbot),
      custom: clean(options.custom),
      premium: options.premium,
      platformAdmin: Boolean(req.platformAdmin),
      lockedToBot7up: options.lockedToBot7up
    }});
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/channel-rewards/timeout',requireAuth,requireTenant,waitDB,async(req,res)=>{
  try{
    const tm=createTenantManager({db,io,req});
    res.set('Cache-Control','no-store');
    res.json({data:{
      enabled:(await tm.getSetting('kick_timeout_reward_enabled','0'))==='1',
      rewardId:await tm.getSetting('kick_timeout_reward_id',''),
      title:await tm.getSetting('kick_timeout_reward_title','Timeout un viewer'),
      cost:parseInt(await tm.getSetting('kick_timeout_reward_cost','1000'))||1000,
      duration:parseInt(await tm.getSetting('kick_timeout_reward_duration','300'))||300,
      oauthConnected:await kickOAuth.isConnected(tm.streamerId)
    }});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/admin/channel-rewards/timeout/setup',requireAuth,requireTenant,waitDB,async(req,res)=>{
  try{
    const tm=createTenantManager({db,io,req}),token=await kickOAuth.getValidAccessToken(tm.streamerId);
    if(!token)return res.status(409).json({error:'Reconnecte le compte streamer Kick pour autoriser les récompenses de chaîne.'});
    const title=String(req.body?.title||'Timeout un viewer').trim().slice(0,50)||'Timeout un viewer';
    const cost=Math.max(1,Math.min(10000000,parseInt(req.body?.cost)||1000));
    const duration=Math.max(60,Math.min(86400,parseInt(req.body?.duration)||300));
    const enabled=req.body?.enabled!==false,rewardId=String(await tm.getSetting('kick_timeout_reward_id','')).trim();
    const body={title,cost,is_enabled:enabled,is_user_input_required:true,should_redemptions_skip_request_queue:false,background_color:'#168cff',description:`Choisis le pseudo du viewer à timeout pendant ${duration} secondes.`};
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'};
    let reward;
    if(rewardId){
      try{const response=await axios.patch(`https://api.kick.com/public/v1/channels/rewards/${rewardId}`,body,{headers,timeout:12000});reward=response.data?.data||response.data}
      catch(e){if(e.response?.status!==404)throw e}
    }
    if(!reward){const response=await axios.post('https://api.kick.com/public/v1/channels/rewards',body,{headers,timeout:12000});reward=response.data?.data||response.data}
    const id=String(reward?.id||rewardId||'');if(!id)throw new Error('Kick n’a renvoyé aucun identifiant de récompense.');
    await Promise.all([
      tm.setSetting('kick_timeout_reward_enabled',enabled?'1':'0'),tm.setSetting('kick_timeout_reward_id',id),
      tm.setSetting('kick_timeout_reward_title',title),tm.setSetting('kick_timeout_reward_cost',String(cost)),tm.setSetting('kick_timeout_reward_duration',String(duration))
    ]);
    res.json({success:true,data:{enabled,rewardId:id,title,cost,duration}});
  }catch(e){
    const detail=e.response?.data?.message||e.response?.data?.error||e.message;
    const scope=/scope|forbidden|403/i.test(String(detail))?'Reconnecte le compte streamer Kick afin d’accorder les droits Récompenses et Modération.':detail;
    res.status(e.response?.status===403?409:500).json({error:scope});
  }
});

app.post('/api/bot-identity/assign', requireAuth, requireTenant, waitDB, async (req, res) => {
  try {
    const identity = await db.assignBotIdentity(req.streamer.id, req.body?.choice, { platformAdmin:Boolean(req.platformAdmin) });
    res.json({ success:true, assigned:{ id:identity.id, key:identity.bot_key, displayName:identity.display_name, status:identity.status } });
  } catch (e) { res.status(400).json({ error:e.message }); }
});

app.get('/api/v2/dashboard-summary', requireAuth, requireTenant, async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    const sr = await getSongRequestState();
    const sub = await getSubCounterState().catch(() => ({ total:0, session:0 }));
    const stats = await db.getGlobalStats().catch(() => ({}));
    res.json({
      data: {
        streamer: { ...tm.info(), oauthConnected: await kickOAuth.isConnected(tm.streamerId) },
        overlayLinks: tm.overlayLinks(),
        songRequest: { queueLength: sr.queue?.length || 0, current: sr.queue?.[0] || null, player: sr.player || {} },
        subGoal: { total: sub.total || 0, session: sub.session || 0, target: sub.target || 0 },
        live: { messages: stats?.total_messages || stats?.messages || 0 }
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v2/dashboard-activity',requireAuth,requireTenant,async(req,res)=>{try{res.set('Cache-Control','no-store');res.json({data:await db.getRecentCommunityEvents(20,req.streamer?.id)})}catch(e){res.json({data:[]})}});

app.get('/api/v2/account', requireAuth, requireTenant, async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    const st = req.streamer || {};
    res.json({ data: {
      ...tm.info(),
      id: tm.streamerId,
      role: st.role || 'streamer',
      kickUsername: st.kick_username || st.kickUsername || st.slug || tm.slug,
      avatarUrl: st.avatar_url || st.avatarUrl || '',
      oauthConnected: await kickOAuth.isConnected(tm.streamerId),
      overlayLinks: tm.overlayLinks()
    } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v2/overlays', async (req, res) => {
  try {
    const tm = createTenantManager({ db, io, req });
    const links = tm.overlayLinks();
    res.json({ data: {
      streamer: tm.slug,
      items: [
        { key:'songrequest', name:'Song Request', desc:'Musique actuelle + file d’attente', url: links.songrequest },
        { key:'alerts', name:'Alertes', desc:'Follow, sub, gift, raid', url: links.alerts },
        { key:'chat', name:'Chat Overlay', desc:'Chat Kick en overlay OBS', url: links.chat },
        { key:'subgoal', name:'Sub Goal', desc:'Objectif de subs', url: links.subgoal },
        { key:'memes', name:'Memes', desc:'Memes interactifs du chat', url: links.memes },
        { key:'classement', name:'Classement viewers', desc:'Page publique du classement', url: links.classement }
      ]
    } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// Config système de points (montant + intervalle, pilotable depuis le panel)
// ════════════════════════════════════════════════════════════════════

const POINTS_DEFAULTS = {
  points_amount:    '5',
  interval_minutes: '10',
  starting_points:  '100',
};

app.get('/api/points/config', async (req, res) => {
  try {
    const stored = await db.getPointsConfig();
    const merged = { ...POINTS_DEFAULTS, ...stored };
    res.json({
      pointsAmount: parseInt(merged.points_amount),
      intervalMinutes: parseInt(merged.interval_minutes),
      startingPoints: parseInt(merged.starting_points),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/points/config', async (req, res) => {
  try {
    const { pointsAmount, intervalMinutes, startingPoints } = req.body;
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
    if (startingPoints !== undefined && startingPoints !== '') {
      const n=parseInt(startingPoints); if(isNaN(n)||n<0||n>1000000)return res.status(400).json({error:'Points de départ invalides'}); updates.starting_points=n;
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
const ALERT_LABELS = { follow:'Follow', sub:'Abonnement', renew:'Renouvellement', gift:'Sub offerte', raid:'Raid', donation:'Donation', bits:'Bits', custom:'Alerte personnalisée' };
const ALERT_DEFAULTS = {
  follow:   { enabled:true,  title:'Nouveau follow',       message:'{username} vient de follow !', media:'', mediaType:'image', sound:'', volume:35, duration:6, enterAnimation:'pop', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#22c55e', accent:'#22c55e', background:'rgba(7,10,18,.86)', showLabel:true },
  sub:      { enabled:true,  title:'Nouvel abonnement',    message:'{username} vient de s’abonner !', media:'', mediaType:'image', sound:'', volume:40, duration:7, enterAnimation:'bounce', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#22c55e', accent:'#22c55e', background:'rgba(7,10,18,.86)', showLabel:true },
  renew:    { enabled:true,  title:'Renouvellement',       message:'{username} est sub depuis {months} mois !', media:'', mediaType:'image', sound:'', volume:40, duration:7, enterAnimation:'pop', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#22c55e', accent:'#22c55e', background:'rgba(7,10,18,.86)', showLabel:true },
  gift:     { enabled:true,  title:'Sub offerte',          message:'{gifter} offre {count} sub !', media:'', mediaType:'image', sound:'', volume:40, duration:7, enterAnimation:'bounce', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#f59e0b', accent:'#f59e0b', background:'rgba(7,10,18,.86)', showLabel:true },
  raid:     { enabled:true,  title:'Raid',                 message:'{username} raid avec {count} viewers !', media:'', mediaType:'image', sound:'', volume:45, duration:8, enterAnimation:'slide_left', exitAnimation:'slide_right', layout:'image_left', position:'center', font:'Inter', titleSize:38, messageSize:24, textTop:'#ffffff', textBottom:'#38bdf8', accent:'#38bdf8', background:'rgba(7,10,18,.86)', showLabel:true },
  donation: { enabled:false, title:'Donation',             message:'{username} donne {amount}€ : {message}', media:'', mediaType:'image', sound:'', volume:40, duration:8, enterAnimation:'pop', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#f59e0b', accent:'#f59e0b', background:'rgba(7,10,18,.86)', showLabel:true },
  bits:     { enabled:false, title:'Bits',                 message:'{username} envoie {amount} bits !', media:'', mediaType:'image', sound:'', volume:40, duration:7, enterAnimation:'zoom', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#a78bfa', accent:'#a78bfa', background:'rgba(7,10,18,.86)', showLabel:true },
  custom:   { enabled:true,  title:'Alerte personnalisée', message:'Alerte test pour {username}', media:'', mediaType:'image', sound:'', volume:35, duration:6, enterAnimation:'fade', exitAnimation:'fade', layout:'image_top', position:'center', font:'Inter', titleSize:36, messageSize:24, textTop:'#ffffff', textBottom:'#22c55e', accent:'#22c55e', background:'rgba(7,10,18,.86)', showLabel:true }
};

function sanitizeAlertType(type) {
  const t = String(type || '').toLowerCase().trim();
  return ALERT_TYPES.includes(t) ? t : 'custom';
}
function sanitizeProfileId(value) {
  return String(value || 'default').toLowerCase().trim().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'default';
}
function normalizeAlertCfg(type, raw={}) {
  const d = ALERT_DEFAULTS[sanitizeAlertType(type)] || ALERT_DEFAULTS.custom;
  const animations = ['fade','pop','zoom','bounce','shake','flip','glitch','slide_left','slide_right','slide_up','slide_down'];
  const legacyAnimation = String(raw.animation || '');
  const media = String(raw.media ?? raw.image ?? d.media).slice(0, 7_000_000);
  const volumeValue = Number(raw.volume ?? d.volume);
  const durationValue = Number(raw.duration ?? d.duration);
  return {
    enabled: raw.enabled !== undefined ? !!raw.enabled : !!d.enabled,
    title: String(raw.title ?? d.title).slice(0, 120),
    message: String(raw.message ?? d.message).slice(0, 400),
    media,
    image: media,
    mediaType: ['image','video'].includes(String(raw.mediaType ?? d.mediaType)) ? String(raw.mediaType ?? d.mediaType) : 'image',
    sound: String(raw.sound ?? d.sound).slice(0, 7_000_000),
    volume: Math.min(100, Math.max(0, Number.isFinite(volumeValue) ? volumeValue : d.volume)),
    duration: Math.min(60, Math.max(1, Number.isFinite(durationValue) ? durationValue : d.duration)),
    enterAnimation: animations.includes(String(raw.enterAnimation || legacyAnimation || d.enterAnimation)) ? String(raw.enterAnimation || legacyAnimation || d.enterAnimation) : d.enterAnimation,
    exitAnimation: animations.includes(String(raw.exitAnimation || d.exitAnimation)) ? String(raw.exitAnimation || d.exitAnimation) : d.exitAnimation,
    animation: animations.includes(String(raw.enterAnimation || legacyAnimation || d.enterAnimation)) ? String(raw.enterAnimation || legacyAnimation || d.enterAnimation) : d.enterAnimation,
    layout: ['image_top','image_left','image_right','text_only','fullscreen'].includes(String(raw.layout ?? d.layout)) ? String(raw.layout ?? d.layout) : d.layout,
    position: ['top_left','top_center','top_right','center','bottom_left','bottom_center','bottom_right'].includes(String(raw.position ?? d.position)) ? String(raw.position ?? d.position) : d.position,
    font: String(raw.font ?? d.font).replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,60) || 'Inter',
    titleSize: Math.min(96, Math.max(14, parseInt(raw.titleSize ?? d.titleSize) || d.titleSize)),
    messageSize: Math.min(72, Math.max(12, parseInt(raw.messageSize ?? d.messageSize) || d.messageSize)),
    textTop: /^#[0-9a-f]{6}$/i.test(String(raw.textTop ?? d.textTop)) ? String(raw.textTop ?? d.textTop) : d.textTop,
    textBottom: /^#[0-9a-f]{6}$/i.test(String(raw.textBottom ?? d.textBottom)) ? String(raw.textBottom ?? d.textBottom) : d.textBottom,
    accent: /^#[0-9a-f]{6}$/i.test(String(raw.accent ?? d.accent)) ? String(raw.accent ?? d.accent) : d.accent,
    background: String(raw.background ?? d.background).slice(0,80),
    showLabel: raw.showLabel !== undefined ? !!raw.showLabel : !!d.showLabel
  };
}
function getAlertTM(reqOrTm=null) {
  if (reqOrTm && typeof reqOrTm.getSetting === 'function') return reqOrTm;
  if (reqOrTm?.tenantManager) return reqOrTm.tenantManager;
  return createTenantManager({ db, io, req:reqOrTm || null, streamer:reqOrTm?.streamer || null });
}
async function getAlertProfiles(tm) {
  tm = getAlertTM(tm);
  let profiles = await tm.getJson('alert_profiles', null);
  if (!Array.isArray(profiles) || !profiles.length) profiles = [{ id:'default', name:'Défaut' }];
  return profiles.map(p=>({ id:sanitizeProfileId(p.id), name:String(p.name || p.id || 'Profil').slice(0,50) }));
}
async function getActiveAlertProfile(tm) {
  tm = getAlertTM(tm);
  const profiles = await getAlertProfiles(tm);
  const wanted = sanitizeProfileId(await tm.getSetting('alert_active_profile','default'));
  return profiles.find(p=>p.id===wanted)?.id || profiles[0].id;
}
async function getAlertConfig(type, tm, profileId=null) {
  tm = getAlertTM(tm); type = sanitizeAlertType(type);
  const profile = sanitizeProfileId(profileId || await getActiveAlertProfile(tm));
  let raw = await tm.getSetting(`alert_profile_${profile}_${type}`, '');
  if (!raw && profile === 'default') raw = await tm.getSetting('alert_config_' + type, '');
  let parsed = {}; if (raw) { try { parsed = JSON.parse(raw); } catch {} }
  return normalizeAlertCfg(type, parsed);
}
async function getAllAlertConfigs(tm, profileId=null) {
  tm = getAlertTM(tm); const out = {};
  for (const t of ALERT_TYPES) out[t] = await getAlertConfig(t, tm, profileId);
  return out;
}
function fillAlertTemplate(str, vars={}) {
  return String(str || '').replace(/\{(username|months|gifter|count|amount|message|viewerCount|goal|subtier)\}/gi, (_, k) => String(vars[String(k).toLowerCase()] ?? ''));
}
async function appendAlertHistory(tm, payload) {
  const hist = await tm.getJson('alert_history', []);
  const next = [payload, ...(Array.isArray(hist)?hist:[])].slice(0,100);
  await tm.setJson('alert_history', next);
}
async function pushObsAlert(type, vars={}, force=false, reqOrTm=null) {
  const tm = getAlertTM(reqOrTm); type = sanitizeAlertType(type);
  const profile = await getActiveAlertProfile(tm);
  const cfg = await getAlertConfig(type, tm, profile);
  if (!force && !cfg.enabled) return { success:true, ignored:true, reason:'disabled', type, streamer:tm.slug };
  const payload = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    streamer: tm.slug, profile, type, label: ALERT_LABELS[type] || type,
    title: fillAlertTemplate(cfg.title, vars), message: fillAlertTemplate(cfg.message, vars),
    vars, cfg, createdAt: new Date().toISOString()
  };
  tm.emit('alert-overlay-event', payload);
  // Le payload complet permet à l'overlay de récupérer une alerte manquée après
  // une brève coupure Socket.IO, avec exactement le média et le son d'origine.
  await appendAlertHistory(tm, payload).catch(()=>{});
  console.log(`[ALERT OBS:${tm.slug}]`, type, payload.message);
  return { success:true, alert:payload };
}
function kickEventToAlertType(eventType) {
  const t = normalizeKickEventType(eventType || '');
  if (t === 'channel.followed') return 'follow'; if (t === 'channel.subscription.new') return 'sub';
  if (t === 'channel.subscription.renewal') return 'renew'; if (t === 'channel.subscription.gifts') return 'gift';
  if (String(eventType || '').toLowerCase().includes('raid')) return 'raid'; return '';
}

app.get('/api/widgets/alerts', async (req, res) => {
  try {
    if (req.overlayTokenInvalid) return res.status(410).json({ error:'Lien OBS expiré', invalidOverlay:true });
    const tm = getAlertTM(req), profiles = await getAlertProfiles(tm), activeProfile = await getActiveAlertProfile(tm);
    res.set('Cache-Control','no-store');
    res.json({ streamer:tm.slug, types:ALERT_TYPES, labels:ALERT_LABELS, profiles, activeProfile, configs:await getAllAlertConfigs(tm, activeProfile) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/widgets/alerts/history', async (req,res)=>{
  try { const tm=getAlertTM(req); res.json({ streamer:tm.slug, data:await tm.getJson('alert_history',[]) }); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/widgets/alerts/events', async (req,res)=>{
  try {
    if (req.overlayTokenInvalid) return res.status(410).json({error:'Lien OBS expiré',invalidOverlay:true});
    const tm=getAlertTM(req), history=await tm.getJson('alert_history',[]);
    const sinceMs=Date.parse(String(req.query.since||''))||0;
    const data=(Array.isArray(history)?history:[])
      .filter(item=>item?.cfg&&Date.parse(String(item.createdAt||''))>sinceMs)
      .sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0))
      .slice(-30);
    res.set('Cache-Control','no-store');
    res.json({streamer:tm.slug,data,serverTime:new Date().toISOString()});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/widgets/alerts/profiles', requireAuth, async (req,res)=>{
  try {
    const tm=getAlertTM(req), id=sanitizeProfileId(req.body.id || req.body.name), name=String(req.body.name || id).trim().slice(0,50);
    let profiles=await getAlertProfiles(tm); if(!profiles.some(p=>p.id===id)) profiles.push({id,name});
    await tm.setJson('alert_profiles',profiles); await tm.setSetting('alert_active_profile',id);
    tm.emit('alert-overlay-settings',{activeProfile:id,configs:await getAllAlertConfigs(tm,id)});
    res.json({success:true,profiles,activeProfile:id});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/widgets/alerts/profile/activate', requireAuth, async (req,res)=>{
  try { const tm=getAlertTM(req), id=sanitizeProfileId(req.body.id); const profiles=await getAlertProfiles(tm); if(!profiles.some(p=>p.id===id)) return res.status(404).json({error:'Profil introuvable'}); await tm.setSetting('alert_active_profile',id); const configs=await getAllAlertConfigs(tm,id); tm.emit('alert-overlay-settings',{activeProfile:id,configs}); res.json({success:true,activeProfile:id,configs}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/admin/widgets/alerts/profiles/:id', requireAuth, async (req,res)=>{
  try { const tm=getAlertTM(req), id=sanitizeProfileId(req.params.id); if(id==='default') return res.status(400).json({error:'Le profil Défaut ne peut pas être supprimé'}); let profiles=(await getAlertProfiles(tm)).filter(p=>p.id!==id); if(!profiles.length) profiles=[{id:'default',name:'Défaut'}]; await tm.setJson('alert_profiles',profiles); const active=await getActiveAlertProfile(tm); if(active===id) await tm.setSetting('alert_active_profile',profiles[0].id); res.json({success:true,profiles,activeProfile:await getActiveAlertProfile(tm)}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/widgets/alerts/:type', requireAuth, async (req, res) => {
  try { const tm=getAlertTM(req), type=sanitizeAlertType(req.params.type), profile=sanitizeProfileId(req.body.profile || await getActiveAlertProfile(tm)), cfg=normalizeAlertCfg(type,req.body||{}); await tm.setSetting(`alert_profile_${profile}_${type}`,JSON.stringify(cfg)); tm.emit('alert-overlay-settings',{activeProfile:profile,configs:await getAllAlertConfigs(tm,profile)}); res.json({success:true,streamer:tm.slug,profile,type,cfg}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/widgets/alerts/:type/test', requireAuth, async (req, res) => {
  try { const tm=getAlertTM(req), type=sanitizeAlertType(req.params.type), vars=Object.assign({username:'Elboy78',months:3,gifter:'TestGift',count:5,amount:'10',message:'Message test',viewerCount:125,goal:50,subtier:'Tier 1'},req.body||{}); res.json(await pushObsAlert(type,vars,true,tm)); }
  catch(e){res.status(500).json({error:e.message});}
});

// ── Chat Overlay OBS V2 — 100 % isolé par streamer ───────────────────────────

const CHAT_OVERLAY_DEFAULTS = {
  enabled: true,
  hideBots: true,
  ignoredUsers: 'BotRix,botrix',
  hideCommands: true,
  showPlatformIcon: true,
  showTime: false,
  showAvatars: true,
  showBadges: true,
  groupMessages: true,
  groupWindow: 12,
  highlightRoles: true,
  fontSize: 21,
  messageDuration: 10,
  animation: 'pop',
  design: 'premium',
  maxMessages: 8
};

function getChatOverlayTM(source = null) {
  if (source?.tenantManager) return source.tenantManager;
  if (source?.streamerId || source?.slug) {
    return createTenantManager({ db, io, streamer: {
      id: source.streamerId || source.id,
      slug: source.slug,
      display_name: source.displayName || source.slug
    }});
  }
  return createTenantManager({ db, io, req: source?.headers ? source : null, streamer: source?.streamer || null });
}

async function getChatOverlayToken(tm) {
  try {
    if (!tm?.streamerId || typeof db.getOrCreateOverlayToken !== 'function') return '';
    const row = await db.getOrCreateOverlayToken(tm.streamerId, 'chat');
    return String(row?.token || '');
  } catch(e) { return ''; }
}

const CHAT_OVERLAY_CONFIG_KEY = 'chat_overlay_config_v3';

function normalizeChatOverlayConfig(input = {}, streamer = '') {
  const source = input && typeof input === 'object' ? input : {};

  const bool = (key, fallback) =>
    typeof source[key] === 'boolean' ? source[key] : fallback;

  const integer = (key, fallback, min, max) => {
    const parsed = Number.parseInt(source[key], 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(max, Math.max(min, value));
  };

  const text = (key, fallback, maxLength) => {
    if (typeof source[key] !== 'string') return fallback;
    return source[key].slice(0, maxLength);
  };

  return {
    enabled: bool('enabled', CHAT_OVERLAY_DEFAULTS.enabled),
    hideBots: bool('hideBots', CHAT_OVERLAY_DEFAULTS.hideBots),
    ignoredUsers: text(
      'ignoredUsers',
      CHAT_OVERLAY_DEFAULTS.ignoredUsers,
      500
    ),
    hideCommands: bool(
      'hideCommands',
      CHAT_OVERLAY_DEFAULTS.hideCommands
    ),
    showPlatformIcon: bool(
      'showPlatformIcon',
      CHAT_OVERLAY_DEFAULTS.showPlatformIcon
    ),
    showTime: bool('showTime', CHAT_OVERLAY_DEFAULTS.showTime),
    showAvatars: bool(
      'showAvatars',
      CHAT_OVERLAY_DEFAULTS.showAvatars
    ),
    showBadges: bool(
      'showBadges',
      CHAT_OVERLAY_DEFAULTS.showBadges
    ),
    groupMessages: bool(
      'groupMessages',
      CHAT_OVERLAY_DEFAULTS.groupMessages
    ),
    groupWindow: integer(
      'groupWindow',
      CHAT_OVERLAY_DEFAULTS.groupWindow,
      2,
      60
    ),
    highlightRoles: bool(
      'highlightRoles',
      CHAT_OVERLAY_DEFAULTS.highlightRoles
    ),
    fontSize: integer(
      'fontSize',
      CHAT_OVERLAY_DEFAULTS.fontSize,
      10,
      42
    ),
    messageDuration: integer(
      'messageDuration',
      CHAT_OVERLAY_DEFAULTS.messageDuration,
      0,
      60
    ),
    animation: text(
      'animation',
      CHAT_OVERLAY_DEFAULTS.animation,
      30
    ),
    design: text(
      'design',
      CHAT_OVERLAY_DEFAULTS.design,
      30
    ),
    maxMessages: integer(
      'maxMessages',
      CHAT_OVERLAY_DEFAULTS.maxMessages,
      1,
      30
    ),
    streamer: String(streamer || source.streamer || '')
  };
}

async function getLegacyChatOverlaySettings(tm) {
  const get = (key, fallback) => tm.getSetting(key, fallback);

  return {
    enabled: (await get('chat_overlay_enabled', '1')) === '1',
    hideBots: (await get('chat_overlay_hide_bots', '1')) === '1',
    ignoredUsers: await get(
      'chat_overlay_ignored_users',
      CHAT_OVERLAY_DEFAULTS.ignoredUsers
    ),
    hideCommands:
      (await get('chat_overlay_hide_commands', '1')) === '1',
    showPlatformIcon:
      (await get('chat_overlay_show_platform_icon', '1')) === '1',
    showTime:
      (await get('chat_overlay_show_time', '0')) === '1',
    showAvatars:
      (await get('chat_overlay_show_avatars', '1')) === '1',
    showBadges:
      (await get('chat_overlay_show_badges', '1')) === '1',
    groupMessages:
      (await get('chat_overlay_group_messages', '1')) === '1',
    groupWindow: Number.parseInt(
      await get(
        'chat_overlay_group_window',
        String(CHAT_OVERLAY_DEFAULTS.groupWindow)
      ),
      10
    ),
    highlightRoles:
      (await get('chat_overlay_highlight_roles', '1')) === '1',
    fontSize: Number.parseInt(
      await get(
        'chat_overlay_font_size',
        String(CHAT_OVERLAY_DEFAULTS.fontSize)
      ),
      10
    ),
    messageDuration: Number.parseInt(
      await get(
        'chat_overlay_message_duration',
        String(CHAT_OVERLAY_DEFAULTS.messageDuration)
      ),
      10
    ),
    animation: await get(
      'chat_overlay_animation',
      CHAT_OVERLAY_DEFAULTS.animation
    ),
    design: await get(
      'chat_overlay_design',
      CHAT_OVERLAY_DEFAULTS.design
    ),
    maxMessages: Number.parseInt(
      await get(
        'chat_overlay_max_messages',
        String(CHAT_OVERLAY_DEFAULTS.maxMessages)
      ),
      10
    )
  };
}

async function getChatOverlaySettings(source = null) {
  const tm = getChatOverlayTM(source);
  let stored = null;

  try {
    stored = await tm.getJson(CHAT_OVERLAY_CONFIG_KEY, null);
  } catch (error) {
    console.warn(
      `[CHAT OVERLAY:${tm.slug}] Lecture config V3 impossible:`,
      error.message
    );
  }

  if (!stored || typeof stored !== 'object') {
    stored = normalizeChatOverlayConfig(
      await getLegacyChatOverlaySettings(tm),
      tm.slug
    );

    try {
      await tm.setJson(CHAT_OVERLAY_CONFIG_KEY, stored);
    } catch (error) {
      console.warn(
        `[CHAT OVERLAY:${tm.slug}] Migration V3 impossible:`,
        error.message
      );
    }
  }

  return normalizeChatOverlayConfig(stored, tm.slug);
}

function normalizeIgnoredUsers(raw) {
  return String(raw || '').split(/[\n,;]+/).map(x => x.trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
}

function normalizeChatBadges(badges) {
  return (Array.isArray(badges) ? badges : []).slice(0, 8).map(b => ({
    type: String(b?.type || b?.name || '').slice(0, 40),
    text: String(b?.text || b?.type || b?.name || '').slice(0, 40),
    count: Number(b?.count || 0) || 0
  }));
}

async function emitChatOverlayMessage(msg = {}, ctx = null) {
  try {
    const tm = getChatOverlayTM(ctx || msg?.ctx || null);
    if (!tm?.slug) return false;
    const username = String(msg.username || '').trim();
    const content = String(msg.content || '').trim();
    if (!username || !content) return false;
    emitDashboardActivity(tm,{type:'chat',username:username.slice(0,60),content:content.slice(0,180),at:msg.at||new Date().toISOString()});
    const cfg = await getChatOverlaySettings(tm);
    if (!cfg.enabled) return true;

    const lower = username.replace(/^@+/, '').toLowerCase();
    const ignored = normalizeIgnoredUsers(cfg.ignoredUsers);
    const badges = normalizeChatBadges(msg.badges);
    const badgeTypes = badges.map(b => b.type.toLowerCase());
    const looksLikeBot = /bot$/i.test(username) || lower === 'botrix' || badgeTypes.includes('bot');
    if (ignored.includes(lower)) return false;
    if (cfg.hideBots && looksLikeBot) return false;
    if (cfg.hideCommands && content.startsWith('!')) return false;

    const overlayToken = await getChatOverlayToken(tm);
    const payload = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      streamer: tm.slug,
      overlayToken,
      username: username.slice(0, 60),
      content: content.slice(0, 800),
      badges,
      platform: msg.platform || 'Kick',
      color: String(msg.color || '').slice(0, 30),
      avatarUrl: String(msg.avatarUrl || msg.avatar_url || '').slice(0, 500),
      at: msg.at || new Date().toISOString()
    };
    tm.emit('chat-overlay-message', payload);
    return true;
  } catch(e) {
    console.warn('[CHAT OVERLAY V2] Message ignoré:', e.message);
    return false;
  }
}

shared.registerChatOverlayEmitter(emitChatOverlayMessage);

app.get('/api/widgets/chat-overlay', async (req, res) => {
  try {
    if (req.overlayTokenInvalid) return res.status(404).json({ error:'overlay_invalid', enabled:false });
    const tm = req.tenantManager || getChatOverlayTM(req);
    const settings = await getChatOverlaySettings(tm);
    const currentToken = await getChatOverlayToken(tm);
    const requestedToken = String(req.query.overlayToken || '').trim();
    if (requestedToken && requestedToken !== currentToken) return res.status(404).json({ error:'overlay_invalid', enabled:false });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ ...settings, overlayToken: currentToken, tokenValid:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/widgets/chat-overlay/settings', requireAuth, async (req, res) => {
  try {
    const tm = req.tenantManager || getChatOverlayTM(req);
    const cfg = normalizeChatOverlayConfig(req.body || {}, tm.slug);

    // Une seule écriture atomique contient tous les paramètres.
    await tm.setJson(CHAT_OVERLAY_CONFIG_KEY, cfg);

    // Anciennes clés conservées temporairement pour compatibilité.
    await Promise.all([
      tm.setSetting('chat_overlay_enabled', cfg.enabled ? '1' : '0'),
      tm.setSetting('chat_overlay_hide_bots', cfg.hideBots ? '1' : '0'),
      tm.setSetting(
        'chat_overlay_hide_commands',
        cfg.hideCommands ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_show_platform_icon',
        cfg.showPlatformIcon ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_show_time',
        cfg.showTime ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_show_avatars',
        cfg.showAvatars ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_show_badges',
        cfg.showBadges ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_group_messages',
        cfg.groupMessages ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_group_window',
        String(cfg.groupWindow)
      ),
      tm.setSetting(
        'chat_overlay_highlight_roles',
        cfg.highlightRoles ? '1' : '0'
      ),
      tm.setSetting(
        'chat_overlay_ignored_users',
        cfg.ignoredUsers
      ),
      tm.setSetting(
        'chat_overlay_font_size',
        String(cfg.fontSize)
      ),
      tm.setSetting(
        'chat_overlay_message_duration',
        String(cfg.messageDuration)
      ),
      tm.setSetting(
        'chat_overlay_max_messages',
        String(cfg.maxMessages)
      ),
      tm.setSetting(
        'chat_overlay_animation',
        cfg.animation
      ),
      tm.setSetting(
        'chat_overlay_design',
        cfg.design
      )
    ]);

    const overlayToken = await getChatOverlayToken(tm);

    tm.emit('chat-overlay-settings', {
      ...cfg,
      overlayToken
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      streamer: tm.slug,
      settings: cfg
    });
  } catch (error) {
    console.error('[CHAT OVERLAY SETTINGS SAVE]', error);
    res.status(500).json({
      error: error.message || 'Enregistrement impossible'
    });
  }
});

app.post('/api/admin/widgets/chat-overlay/test', requireAuth, async (req, res) => {
  try {
    const tm = req.tenantManager || getChatOverlayTM(req);
    const overlayToken = await getChatOverlayToken(tm);
    const payload = {
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      streamer: tm.slug,
      overlayToken,
      username: String(req.body?.username || 'Elboy78').slice(0, 60),
      content: String(req.body?.message || 'Message test Overlay Chat ✨').slice(0, 800),
      badges: [{ type:'moderator', text:'MOD' }],
      platform: 'Kick',
      color: '#53fc18',
      avatarUrl: '',
      at: new Date().toISOString(),
      isTest: true
    };

    // Un test OBS doit toujours être visible, même si l'overlay est désactivé
    // ou si les filtres masquent habituellement ce type de message.
    tm.emit('chat-overlay-message', payload);
    res.json({ success: true, delivered: true, streamer: tm.slug, payload });
  } catch(e) {
    console.error('[CHAT OVERLAY TEST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// Memes interactifs — bibliothèque et overlay isolés par streamer
// ════════════════════════════════════════════════════════════════════
const MEMES_CONFIG_KEY = 'memes_config_v1';
const memeCooldowns = new Map();
function cleanMemeKey(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0,32); }
function safeRemoteMediaUrl(v) {
  const raw = String(v || '').trim().slice(0,1000);
  if (!raw) return '';
  try { const u = new URL(raw); return ['https:','http:'].includes(u.protocol) ? u.toString() : ''; } catch (_) { return ''; }
}
function normalizeMemeConfig(raw = {}) {
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0,100).map((m, i) => ({
    id: cleanMemeKey(m.id) || `meme_${i+1}`,
    name: String(m.name || m.id || `Meme ${i+1}`).trim().slice(0,60),
    mediaUrl: safeRemoteMediaUrl(m.mediaUrl), soundUrl: safeRemoteMediaUrl(m.soundUrl),
    duration: Math.max(2,Math.min(20,Number(m.duration)||6)),
    cost: Math.max(0,Math.min(1000000,Math.floor(Number(m.cost)||0))),
    cooldown: Math.max(0,Math.min(3600,Math.floor(Number(m.cooldown)||30))),
    allowText: m.allowText !== false, enabled: m.enabled !== false
  })).filter(m => m.id && m.mediaUrl);
  const positions=['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right'];
  const launchSoundTypes=['pop','chime','bell','digital'];
  return { enabled:raw.enabled===true, mode:['instant','trust','approval'].includes(raw.mode)?raw.mode:'trust', duration:Math.max(2,Math.min(20,Number(raw.duration)||6)), cost:Math.max(0,raw.cost===undefined?75:Number(raw.cost)||0), cooldown:Math.max(0,Math.min(3600,raw.cooldown===undefined?60:Number(raw.cooldown)||0)), size:Math.max(20,Math.min(100,Number(raw.size)||80)), position:positions.includes(raw.position)?raw.position:'center', maxFileMb:Math.max(1,Math.min(25,Number(raw.maxFileMb)||15)), maxText:Math.max(0,Math.min(160,raw.maxText===undefined?100:Number(raw.maxText)||0)), maxVideoDuration:Math.max(10,Math.min(20,Number(raw.maxVideoDuration)||20)), launchSound:raw.launchSound!==false, launchSoundType:launchSoundTypes.includes(raw.launchSoundType)?raw.launchSoundType:'pop', launchSoundVolume:Math.max(0,Math.min(100,Number(raw.launchSoundVolume??55))), viewerTts:raw.viewerTts===true, volume:0, items };
}
async function getMemesConfig(tm) {
  try { return normalizeMemeConfig(JSON.parse(await tm.getSetting(MEMES_CONFIG_KEY, '{}'))); }
  catch (_) { return normalizeMemeConfig({}); }
}
function cleanMemeText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
async function executeMeme(username, memeKey, customText, tm, testMode = false) {
  const cfg = await getMemesConfig(tm);
  if (!cfg.enabled && !testMode) return { error:'Les memes sont désactivés sur cette chaîne.' };
  const item = cfg.items.find(x => x.enabled && (x.id === cleanMemeKey(memeKey) || x.name.toLowerCase() === String(memeKey).toLowerCase()));
  if (!item) return { error:'Meme introuvable.' };
  const cooldownKey = `${tm.streamerId}:${item.id}`;
  const remaining = Math.ceil(((memeCooldowns.get(cooldownKey)||0)-Date.now())/1000);
  if (remaining > 0 && !testMode) return { error:`Ce meme revient dans ${remaining}s.` };
  if (item.cost > 0 && !testMode) {
    const viewer = await db.getViewer(username);
    if (!viewer || Number(viewer.meme_points||0) < item.cost) return { error:`Il faut ${item.cost} points mèmes.` };
    await db.addMemePoints(username, -item.cost);
  }
  if (!testMode) memeCooldowns.set(cooldownKey, Date.now() + item.cooldown*1000);
  const payload = { id:`${Date.now()}_${Math.random().toString(36).slice(2,7)}`, memeId:item.id, name:item.name, username:String(username||'Viewer').slice(0,60), text:item.allowText?cleanMemeText(customText,cfg.maxText):'', mediaUrl:item.mediaUrl, soundUrl:item.soundUrl, duration:item.duration, launchSound:cfg.launchSound, launchSoundType:cfg.launchSoundType, launchSoundVolume:cfg.launchSoundVolume, volume:cfg.volume, at:new Date().toISOString() };
  await db.createMemeEvent(tm.streamerId, payload);
  tm.emit('meme-overlay-event', payload);
  return { ok:true, payload };
}
shared.registerMemeTrigger(async (username, meme, text, ctx = null) => {
  const run = async () => executeMeme(username, meme, text, createTenantManager({ db, io, streamer:ctx?.streamer || { id:ctx?.streamerId, slug:ctx?.slug } }));
  return ctx?.streamerId && tenant.runWithStreamer ? tenant.runWithStreamer({id:ctx.streamerId,slug:ctx.slug},run) : run();
});

app.get('/api/admin/memes', requireAuth, requireTenant, async (req,res) => {
  try {
    const tm=createTenantManager({db,io,req}); const config=await getMemesConfig(tm);
    const protocol=req.headers['x-forwarded-proto']||req.protocol||'https', base=`${protocol}://${req.get('host')}`;
    const token=await db.getOrCreateOverlayToken(tm.streamerId,'memes');
    const testToken=await db.createMemeAccessToken(tm.streamerId,'Test Panel',2);
    const points=await db.getPointsConfig(), leaderboard=await db.getMemeLeaderboard(10);
    res.json({data:{config,overlayUrl:`${base}/o/${token.token}/memes.html`,viewerUrl:`${base}/memes/${tm.slug}?token=${testToken}`,moderatorUrl:`${base}/memes-moderation/${tm.slug}`,points:{amount:Number(points.meme_points_amount||5),interval:Number(points.meme_interval_minutes||10),starting:Number(points.meme_starting_points||100)},leaderboard}});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/admin/memes', requireAuth, requireTenant, async (req,res) => {
  try { const tm=createTenantManager({db,io,req}), config=normalizeMemeConfig(req.body||{}), serialized=JSON.stringify(config); await tm.setSetting(MEMES_CONFIG_KEY,serialized); await db.setPointsConfigBulk({meme_points_amount:Math.max(0,Number(req.body?.pointsAmount)||0),meme_interval_minutes:Math.max(1,Number(req.body?.pointsInterval)||10),meme_starting_points:Math.max(0,Number(req.body?.startingPoints)||0)}); const persisted=await db.getStreamerSetting(tm.streamerId,MEMES_CONFIG_KEY,''); if(persisted!==serialized)throw new Error('La sauvegarde SQLite du widget a échoué'); tm.emit('meme-overlay-settings',config); res.set('Cache-Control','no-store'); res.json({success:true,data:JSON.parse(persisted),streamerId:tm.streamerId}); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/api/admin/memes/test', requireAuth, requireTenant, async (req,res) => {
  try { const tm=createTenantManager({db,io,req}); const result=await executeMeme('Test Panel',req.body?.id,req.body?.text||'Test personnalisé',tm,true); if(result.error)return res.status(400).json(result); res.json(result); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/admin/memes/stop', requireAuth, requireTenant, async (req,res) => { const tm=createTenantManager({db,io,req}); tm.emit('meme-overlay-stop',{at:new Date().toISOString()}); res.json({success:true}); });
app.post('/api/admin/memes/points',requireAuth,requireTenant,async(req,res)=>{try{const username=String(req.body?.username||'').trim().replace(/^@+/,''),amount=Number(req.body?.amount);if(!username||!Number.isFinite(amount)||amount===0)return res.status(400).json({error:'Pseudo et montant requis'});if(Math.abs(amount)>1000000)return res.status(400).json({error:'Montant trop élevé'});await db.addMemePoints(username,Math.trunc(amount));const viewer=await db.getViewer(username);res.json({success:true,data:{username:viewer?.username||username,points:Number(viewer?.meme_points||0)}})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/memes/submissions',requireAuth,requireTenant,async(req,res)=>{const tm=createTenantManager({db,io,req});res.json({data:await db.getMemeSubmissions(tm.streamerId,String(req.query.status||'all'))})});
app.post('/api/admin/memes/submissions/:id/:action',requireAuth,requireTenant,async(req,res)=>{const tm=createTenantManager({db,io,req}),row=await db.getMemeSubmission(req.params.id,tm.streamerId);if(!row)return res.status(404).json({error:'Introuvable'});if(req.params.action==='approve'){const cfg=await getMemesConfig(tm),payload={username:row.username,text:row.text,mediaUrl:row.media_url,mediaType:row.media_type,ttsUrl:row.tts_url,speakText:row.tts_requested&&!row.tts_url?row.text:'',speechPreset:row.tts_voice||'',duration:cfg.duration,size:cfg.size,position:cfg.position,launchSound:cfg.launchSound,launchSoundType:cfg.launchSoundType,launchSoundVolume:cfg.launchSoundVolume,volume:0,at:new Date().toISOString()};await db.createMemeEvent(tm.streamerId,payload);tm.emit('meme-overlay-event',payload)}await db.setMemeSubmissionStatus(row.id,tm.streamerId,req.params.action==='approve'?'approved':'rejected');res.json({success:true})});

const memeTempDir=path.join(__dirname,'data','meme-temp');fs.mkdirSync(memeTempDir,{recursive:true});
function memeAuthCookieValue(req){return String(tenant.parseCookies(req)?.[MEME_AUTH_COOKIE]||'')}
async function getMemeIdentity(req,streamerId){return db.getMemeAuthSession(memeAuthCookieValue(req),streamerId)}
async function memeAccessAuthorized(req,access,token){
  if(Number(access?.trusted)===2)return true;
  const identity=await getMemeIdentity(req,access?.streamer_id);if(!identity||!['viewer','moderator'].includes(identity.role)||tenant.normalizeSlug(identity.username)!==tenant.normalizeSlug(access?.username))return false;
  if(!access.kick_user_id||access.auth_session!==identity.session_token)access=await db.authenticateMemeAccessToken(token,access.streamer_id,identity.kick_user_id,identity.session_token);
  return !!access?.kick_user_id;
}
function profileBadges(payload){
  const found=[],seen=new Set();
  const add=value=>{if(!value||typeof value!=='object'||seen.has(value))return;const kind=String(value.type||value.slug||value.name||value.badge_type||'').trim();if(kind){seen.add(value);found.push(value)}};
  const visit=(value,key='')=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){if(/badge/i.test(key))value.forEach(add);value.forEach(v=>visit(v,key));return}add(value);for(const [k,v] of Object.entries(value))visit(v,k)};
  visit(payload);return found;
}
function isModeratorBadge(b){
  const type=String(b?.type||b?.slug||b?.name||b?.badge_type||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  return ['moderator','mod','broadcaster','channel_moderator','channel_broadcaster'].includes(type)||/(^|_)moderator$/.test(type);
}
function profileSaysModerator(payload){
  let allowed=false;
  const visit=value=>{if(allowed||!value||typeof value!=='object')return;for(const [rawKey,rawValue] of Object.entries(value)){const key=String(rawKey).toLowerCase().replace(/[\s-]+/g,'_'),text=String(rawValue||'').toLowerCase();if((key==='is_moderator'||key==='moderator'||key==='is_broadcaster'||key==='broadcaster')&&(rawValue===true||rawValue===1||text==='true'||text==='1')){allowed=true;return}if(['role','channel_role','user_role'].includes(key)&&['moderator','mod','broadcaster','owner'].includes(text)){allowed=true;return}if(rawValue&&typeof rawValue==='object')visit(rawValue)}};
  visit(payload);return allowed;
}
function profileContainsUsername(payload,username){
  const expected=tenant.normalizeSlug(username);let found=false;
  const visit=value=>{if(found||!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return}const candidate=tenant.normalizeSlug(value.username||value.name||value.slug||value.user?.username||value.user?.name||'');if(candidate&&candidate===expected){found=true;return}Object.values(value).forEach(visit)};
  visit(payload);return found;
}
async function verifyMemeModerator(streamer,username,kickUserId=''){
  const normalized=tenant.normalizeSlug(username);if(normalized===tenant.normalizeSlug(streamer.slug)||normalized===tenant.normalizeSlug(streamer.kick_username))return true;
  const cachedModerator=async()=>{const viewer=await tenant.runWithStreamer(streamer,()=>db.getViewer(normalized));let badges=[];try{badges=JSON.parse(viewer?.badges_json||'[]')}catch(_e){}const checkedAt=viewer?.badges_synced_at?new Date(String(viewer.badges_synced_at).replace(' ','T')+'Z').getTime():0;return !!checkedAt&&Date.now()-checkedAt<86400000&&badges.some(isModeratorBadge)};
  const wasCachedModerator=await cachedModerator();
  const headers={Accept:'application/json','User-Agent':'Mozilla/5.0'};
  if(kickUserId){
    try{
      const identity=await axios.get(`https://kick.com/api/internal/v1/channels/${encodeURIComponent(streamer.slug)}/chatroom/users/${encodeURIComponent(String(kickUserId))}/identity`,{headers,timeout:8000});
      const badges=profileBadges(identity.data),verified=profileSaysModerator(identity.data)||badges.some(isModeratorBadge);if(badges.length)await tenant.runWithStreamer(streamer,()=>db.setViewerKickProfile(normalized,{badges}));if(verified){console.log(`[MEME MOD:${streamer.slug}] @${normalized} confirmé par identité chat`);return true}
    }catch(e){console.warn(`[MEME MOD:${streamer.slug}] Identité chat indisponible pour @${normalized}: ${e.response?.status||e.message}`)}
  }
  try{
    const moderators=await axios.get(`https://kick.com/api/internal/v1/channels/${encodeURIComponent(streamer.slug)}/community/moderators`,{headers,timeout:8000});
    if(profileContainsUsername(moderators.data,normalized)){console.log(`[MEME MOD:${streamer.slug}] @${normalized} confirmé par liste modérateurs`);return true}
  }catch(e){console.warn(`[MEME MOD:${streamer.slug}] Liste modérateurs indisponible: ${e.response?.status||e.message}`)}
  try{
    const response=await axios.get(`https://kick.com/api/v2/channels/${encodeURIComponent(streamer.slug)}/users/${encodeURIComponent(normalized)}`,{headers,timeout:8000});
    const badges=profileBadges(response.data),verified=profileSaysModerator(response.data)||badges.some(isModeratorBadge);if(badges.length)await tenant.runWithStreamer(streamer,()=>db.setViewerKickProfile(normalized,{badges}));return verified||wasCachedModerator;
  }catch(e){
    console.warn(`[MEME MOD:${streamer.slug}] Fiche Kick indisponible pour @${normalized}: ${e.response?.status||e.message}`);
    return wasCachedModerator;
  }
}
const cleanupMemeFiles=()=>{for(const file of fs.readdirSync(memeTempDir)){const full=path.join(memeTempDir,file);try{if(Date.now()-fs.statSync(full).mtimeMs>86400000)fs.unlinkSync(full)}catch(_){}}};cleanupMemeFiles();setInterval(cleanupMemeFiles,3600000).unref();
app.get('/meme-media/:file',(req,res)=>{const file=String(req.params.file||'').replace(/[^a-z0-9_.-]/gi,'');res.sendFile(path.join(memeTempDir,file))});
app.get('/memes/:streamer',(req,res)=>res.sendFile(path.join(__dirname,'public','memes-submit.html')));
app.get('/memes-moderation/:streamer',(req,res)=>res.sendFile(path.join(__dirname,'public','memes-moderation.html')));
async function requireMemeModerator(req,res){
  const streamer=await db.getStreamerBySlug(tenant.normalizeSlug(req.params.streamer));if(!streamer){res.status(404).json({error:'Chaîne inconnue'});return null}
  const identity=await getMemeIdentity(req,streamer.id);if(!identity||identity.role!=='moderator'){res.status(401).json({error:'Connexion modérateur requise',authUrl:`/auth/meme/moderator?streamer=${encodeURIComponent(streamer.slug)}`});return null}
  const verifiedAt=new Date(String(identity.verified_at||'').replace(' ','T')+'Z').getTime();if(!verifiedAt||Date.now()-verifiedAt>10*60*1000){if(!await verifyMemeModerator(streamer,identity.username,identity.kick_user_id)){await db.deleteMemeAuthSession(identity.session_token);res.status(403).json({error:'Tu n’es plus modérateur de cette chaîne.'});return null}await db.refreshMemeAuthSession(identity.session_token,streamer.id)}
  return {streamer,identity,tm:createTenantManager({db,io,streamer,req})};
}
app.get('/api/public/memes-moderation/:streamer',async(req,res)=>{const auth=await requireMemeModerator(req,res);if(!auth)return;res.set('Cache-Control','no-store');res.json({data:{username:auth.identity.username,streamer:auth.streamer.display_name||auth.streamer.slug,mode:(await getMemesConfig(auth.tm)).mode,submissions:await db.getMemeSubmissions(auth.streamer.id,'all')}})});
app.post('/api/public/memes-moderation/:streamer/mode',async(req,res)=>{const auth=await requireMemeModerator(req,res);if(!auth)return;const mode=String(req.body?.mode||'');if(!['trust','approval','instant'].includes(mode))return res.status(400).json({error:'Mode invalide'});const cfg=await getMemesConfig(auth.tm),saved=normalizeMemeConfig({...cfg,mode});await auth.tm.setSetting(MEMES_CONFIG_KEY,JSON.stringify(saved));auth.tm.emit('meme-overlay-settings',saved);res.json({success:true,mode:saved.mode})});
app.post('/api/public/memes-moderation/:streamer/:id/:action',async(req,res)=>{const auth=await requireMemeModerator(req,res);if(!auth)return;const action=String(req.params.action),row=await db.getMemeSubmission(req.params.id,auth.streamer.id);if(!row||row.status!=='pending')return res.status(404).json({error:'Envoi en attente introuvable'});if(action==='approve'){const cfg=await getMemesConfig(auth.tm),payload={username:row.username,text:row.text,mediaUrl:row.media_url,mediaType:row.media_type,ttsUrl:row.tts_url,speakText:row.tts_requested&&!row.tts_url?row.text:'',speechPreset:row.tts_voice||'',duration:cfg.duration,size:cfg.size,position:cfg.position,launchSound:cfg.launchSound,launchSoundType:cfg.launchSoundType,launchSoundVolume:cfg.launchSoundVolume,volume:0,at:new Date().toISOString()};await db.createMemeEvent(auth.streamer.id,payload);auth.tm.emit('meme-overlay-event',payload)}else if(action!=='reject')return res.status(400).json({error:'Action invalide'});await db.setMemeSubmissionStatus(row.id,auth.streamer.id,action==='approve'?'approved':'rejected');res.json({success:true})});
app.get('/api/public/memes/:streamer/config',async(req,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate');const s=await db.getStreamerBySlug(tenant.normalizeSlug(req.params.streamer));if(!s)return res.status(404).json({error:'Chaîne inconnue'});const tm=createTenantManager({db,io,streamer:s,req}),c=await getMemesConfig(tm),token=String(req.query.token||''),access=await db.getMemeAccessToken(token,s.id);if(!access)return res.status(410).json({error:'Lien expiré. Retape !meme dans le chat.'});if(c.mode==='trust'&&!access.trusted)return res.status(403).json({error:'Le mode Confiance est réservé aux abonnés.'});if(!await memeAccessAuthorized(req,access,token))return res.status(401).json({error:'Connexion Kick requise',authRequired:true,expectedUsername:access.username,authUrl:`/auth/meme/login?streamer=${encodeURIComponent(s.slug)}&token=${encodeURIComponent(token)}`});res.json({data:{enabled:c.enabled,maxText:c.maxText,maxFileMb:c.maxFileMb,maxVideoDuration:c.maxVideoDuration,viewerTts:c.viewerTts,cost:c.cost,streamer:s.display_name||s.slug,username:access.username,authenticated:true,voices:await getPublicMemeVoices()}})});
app.post('/api/public/memes/:streamer/submit',async(req,res)=>{try{
  const s=await db.getStreamerBySlug(tenant.normalizeSlug(req.params.streamer));if(!s)return res.status(404).json({error:'Chaîne inconnue'});
  const tm=createTenantManager({db,io,streamer:s,req}),cfg=await getMemesConfig(tm);if(!cfg.enabled)return res.status(403).json({error:'Widget désactivé'});
  const text=cleanMemeText(req.body?.text,cfg.maxText),data=String(req.body?.image||''),token=String(req.body?.token||''),wantsTts=req.body?.readText===true;
  const access=await db.getMemeAccessToken(token,s.id);if(!access)return res.status(401).json({error:'Lien expiré. Retape !meme dans le chat.'});
  if(cfg.mode==='trust'&&!access.trusted)return res.status(403).json({error:'Le mode Confiance est réservé aux abonnés.'});
  if(!await memeAccessAuthorized(req,access,token))return res.status(401).json({error:'Reconnecte-toi avec le compte Kick autorisé.'});
  const m=data.match(/^data:(image\/(png|jpeg|gif|webp)|video\/(mp4|webm));base64,([A-Za-z0-9+/=]+)$/);if(!m)return res.status(400).json({error:'Image, GIF ou vidéo MP4/WebM invalide'});
  const mediaType=m[1].startsWith('video/')?'video':'image',videoDuration=Number(req.body?.videoDuration||0);
  if(mediaType==='video'&&(!videoDuration||videoDuration>cfg.maxVideoDuration+.25))return res.status(400).json({error:`La vidéo doit durer ${cfg.maxVideoDuration} secondes maximum`});
  const bytes=Buffer.from(m[4],'base64');if(bytes.length>cfg.maxFileMb*1024*1024)return res.status(413).json({error:'Fichier trop volumineux'});
  if(text){const banned=await tenant.runWithStreamer(s,()=>db.checkBannedWords(text));if(banned)return res.status(400).json({error:'Texte refusé'})}
  const username=access.username,cooldownKey=`viewer:${s.id}:${username.toLowerCase()}`,remaining=Math.ceil(((memeCooldowns.get(cooldownKey)||0)-Date.now())/1000);if(remaining>0)return res.status(429).json({error:`Réessaie dans ${remaining}s`});
  const viewer=await tenant.runWithStreamer(s,()=>db.getViewer(username));if(access.trusted!==2&&cfg.cost>0&&(!viewer||Number(viewer.meme_points||0)<cfg.cost))return res.status(400).json({error:`Il faut ${cfg.cost} points mèmes`});
  if(wantsTts&&(!cfg.viewerTts||!text))return res.status(400).json({error:'Lecture IA indisponible ou texte vide'});
  const subtype=m[2]||m[3],ext=subtype==='jpeg'?'jpg':subtype,file=`${s.id}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;await fs.promises.writeFile(path.join(memeTempDir,file),bytes);const mediaUrl=`/meme-media/${file}`;
  let ttsUrl=null,ttsVoice='';if(wantsTts){const voices=await getPublicMemeVoices(),voiceId=String(req.body?.voiceId||'builtin:female-fr'),selected=voices.some(v=>v.id===voiceId)?voiceId:'builtin:female-fr';ttsVoice=selected;if(!selected.startsWith('builtin:')){const audio=await tenant.runWithStreamer(s,async()=>await generateTTSAudio(text,selected));if(audio){const audioFile=`${s.id}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.mp3`;await fs.promises.writeFile(path.join(memeTempDir,audioFile),Buffer.from(audio,'base64'));ttsUrl=`/meme-media/${audioFile}`}}}
  if(access.trusted!==2&&cfg.cost>0)await tenant.runWithStreamer(s,()=>db.addMemePoints(username,-cfg.cost));
  const trusted=!!access.trusted,instant=cfg.mode==='instant'||(cfg.mode==='trust'&&trusted),status=instant?'approved':'pending';
  const row=await db.createMemeSubmission(s.id,username,text,mediaUrl,status,{mediaType,ttsUrl,ttsRequested:wantsTts,ttsVoice,kickUserId:access.kick_user_id});memeCooldowns.set(cooldownKey,Date.now()+cfg.cooldown*1000);
  if(instant){const payload={username,text,mediaUrl,mediaType,ttsUrl,speakText:wantsTts&&!ttsUrl?text:'',speechPreset:ttsVoice,duration:mediaType==='video'?Math.min(cfg.maxVideoDuration,videoDuration):cfg.duration,size:cfg.size,position:cfg.position,launchSound:cfg.launchSound,launchSoundType:cfg.launchSoundType,launchSoundVolume:cfg.launchSoundVolume,volume:0,at:new Date().toISOString()};await db.createMemeEvent(s.id,payload);tm.emit('meme-overlay-event',payload)}
  await db.consumeMemeAccessToken(token,s.id);res.json({success:true,status,submissionId:row?.id})
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/widgets/memes', async (req,res) => {
  try { if(req.overlayTokenInvalid || req.overlayTokenRow?.widget !== 'memes') return res.status(404).json({error:'overlay_invalid'}); const tm=createTenantManager({db,io,req}); res.json({data:await getMemesConfig(tm),events:await db.getMemeEvents(tm.streamerId,req.query.after||0)}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

io.on('connection', (socket) => {
  const requested = socket.handshake?.query?.streamer || socket.handshake?.auth?.streamer || socket.handshake?.headers?.['x-streamer-slug'];
  const slug = requested ? tenant.normalizeSlug(requested) : '';
  if (slug) {
    const room = tenant.roomName(slug);
    socket.join(room);
    socket.emit('tenant-joined', { room, slug });
    console.log(`[SOCKET] Connecté ${socket.id} → ${room}`);
  } else {
    console.log('[SOCKET] Connecté sans tenant:', socket.id);
  }
  socket.on('tenant-join', (joinSlug) => {
    const clean = tenant.normalizeSlug(joinSlug);
    const room = tenant.roomName(clean);
    socket.join(room);
    socket.emit('tenant-joined', { room, slug: clean });
  });
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║  Panel Web → http://localhost:${PORT}      ║`);
  console.log(`╚════════════════════════════════════════╝`);
});
