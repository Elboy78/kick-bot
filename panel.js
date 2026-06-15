require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');

const app    = express();
const PORT   = parseInt(process.env.PANEL_PORT || '3000');
const SECRET = process.env.PANEL_SECRET || 'changez_cette_cle_secrete';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const key = req.headers['x-panel-key'] || req.query.key;
  if (key !== SECRET) return res.status(401).json({ error: 'Clé invalide' });
  next();
}

// ── Lecture ──────────────────────────────────────────────────────────────────
app.get('/api/leaderboard',   (req, res) => res.json({ data: db.getLeaderboard(Math.min(parseInt(req.query.limit||10),100)) }));
app.get('/api/viewer/:u',     (req, res) => { const v=db.getViewer(req.params.u); if(!v) return res.status(404).json({error:'Introuvable'}); res.json({data:{...v,rank:db.getViewerRank(req.params.u)}}); });
app.get('/api/stats',         (req, res) => res.json({ data: db.getGlobalStats() }));
app.get('/api/logs',          (req, res) => res.json({ data: db.getRecentLogs(Math.min(parseInt(req.query.limit||50),500)) }));
app.get('/api/active',        (req, res) => res.json({ data: db.getActiveViewers(parseInt(req.query.minutes||10)) }));
app.get('/api/levels',        (req, res) => res.json({ data: db.LEVELS }));
app.get('/api/commands',      (req, res) => res.json({ data: db.getCustomCommands() }));
app.get('/api/objectives',    (req, res) => res.json({ data: db.getObjectives() }));
app.get('/api/history',       (req, res) => res.json({ data: db.getStreamHistory(parseInt(req.query.limit||20)) }));
app.get('/api/duels',         (req, res) => res.json({ data: db.getRecentDuels(parseInt(req.query.limit||20)) }));
app.get('/api/giveaways',     (req, res) => res.json({ data: db.getGiveawayHistory(parseInt(req.query.limit||20)) }));
app.get('/api/lobby',          (req, res) => res.json({ data: db.getLobby() }));
app.post('/api/admin/lobby/remove', (req, res) => { db.removeFromLobby(req.body.username); res.json({success:true}); });
app.post('/api/admin/lobby/clear',  (req, res) => { db.clearLobby(); res.json({success:true}); });
app.get('/api/giveaway/active',(req, res) => res.json({ data: db.getActiveGiveaway() }));

// ── Admin ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/points',     requireAuth, (req, res) => { const {username,points,reason}=req.body; if(!username||typeof points!=='number') return res.status(400).json({error:'username et points requis'}); db.upsertViewer(username); db.addPoints(username,points,reason||'admin_manual'); res.json({success:true,data:db.getViewer(username)}); });
app.post('/api/admin/reset',      requireAuth, (req, res) => { const {username}=req.body; if(!username) return res.status(400).json({error:'username requis'}); db.getDB().prepare(`UPDATE viewers SET points=0,total_minutes=0,level='Bronze' WHERE username=? COLLATE NOCASE`).run(username); res.json({success:true}); });
app.post('/api/admin/clear-all',  requireAuth, (req, res) => { db.clearAllPoints(); res.json({success:true}); });

// Commandes custom
app.post('/api/admin/commands',   requireAuth, (req, res) => { const {trigger,response}=req.body; if(!trigger||!response) return res.status(400).json({error:'trigger et response requis'}); db.setCustomCommand(trigger,response); res.json({success:true}); });
app.post('/api/admin/commands/toggle', requireAuth, (req, res) => { const {trigger,enabled}=req.body; if(!trigger) return res.status(400).json({error:'trigger requis'}); db.toggleCustomCommand(trigger, enabled); res.json({success:true}); });
app.delete('/api/admin/commands/:trigger', requireAuth, (req, res) => { db.deleteCustomCommand(req.params.trigger); res.json({success:true}); });

// Commandes système toggle
app.get('/api/system-commands', (req, res) => {
  try {
    const rows = db.getDB().prepare(`SELECT * FROM system_commands_state`).all();
    res.json({ data: rows });
  } catch(e) { res.json({ data: [] }); }
});
app.post('/api/admin/system-commands/toggle', requireAuth, (req, res) => {
  const { trigger, enabled } = req.body;
  if (!trigger) return res.status(400).json({ error: 'trigger requis' });
  try {
    db.getDB().prepare(`INSERT OR REPLACE INTO system_commands_state (trigger, enabled) VALUES (?, ?)`).run(trigger, enabled ? 1 : 0);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Forcer le statut live manuellement depuis le panel
let forcedLiveStatus = null; // null=auto, true=forcé ON, false=forcé OFF

app.post('/api/admin/live/force', requireAuth, (req, res) => {
  const { status } = req.body; // 'on', 'off', ou 'auto'
  forcedLiveStatus = status === 'on' ? true : status === 'off' ? false : null;
  res.json({ success: true, forced: forcedLiveStatus });
});

app.get('/api/admin/live/status', requireAuth, (req, res) => {
  res.json({ forced: forcedLiveStatus });
});

app.get('/api/live', async (req, res) => {
  // Si statut forcé, retourner directement
  if (forcedLiveStatus !== null) {
    return res.json({ live: forcedLiveStatus, viewers: 0, title: '', forced: true });
  }
  try {
    const axios = require('axios');
    const channel = process.env.KICK_CHANNEL || '';
    const r = await axios.get('https://kick.com/api/v2/channels/'+channel, {
      headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'},timeout:6000
    });
    const live = r.data?.livestream;
    res.json({ live: !!(live?.is_live), viewers: live?.viewer_count||0, title: live?.session_title||'' });
  } catch(e) {
    res.json({ live: false, viewers: 0, title: '' });
  }
});

// Objectifs
app.post('/api/admin/objectives',      requireAuth, (req, res) => { const {title,description,target,reward}=req.body; if(!title||!target) return res.status(400).json({error:'title et target requis'}); const id=db.createObjective(title,description,target,reward); res.json({success:true,id}); });
app.put('/api/admin/objectives/:id',   requireAuth, (req, res) => { db.updateObjective(req.params.id,req.body); res.json({success:true}); });
app.delete('/api/admin/objectives/:id',requireAuth, (req, res) => { db.deleteObjective(req.params.id); res.json({success:true}); });

// Giveaway
app.post('/api/admin/giveaway/start',  requireAuth, (req, res) => { const {title,prize,cost}=req.body; if(!title||!prize) return res.status(400).json({error:'title et prize requis'}); const id=db.createGiveaway(title,prize,cost||0); res.json({success:true,id}); });
app.post('/api/admin/giveaway/close',  requireAuth, (req, res) => { const g=db.getActiveGiveaway(); if(!g) return res.status(404).json({error:'Aucun giveaway actif'}); const winner=db.closeGiveaway(g.id); res.json({success:true,winner}); });

// ── Authentification panel ───────────────────────────────────────────────────

// Routes publiques (sans auth)
app.get('/api/auth/request', (req, res) => {
  const { username, password } = req.query;
  if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Pseudo invalide' });

  // Vérifier le mot de passe partagé
  const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
  if (PANEL_PASSWORD && password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: 'wrong_password' });
  }

  const status = db.getAccessStatus(username.trim());
  if (status?.status === 'approved') return res.json({ status: 'approved', role: status.role });
  if (status?.status === 'revoked')  return res.json({ status: 'revoked' });
  db.requestAccess(username.trim());
  // Si pas de validation manuelle requise, approuver directement
  db.approveAccess(username.trim(), 'viewer');
  res.json({ status: 'approved', role: 'viewer' });
});

app.get('/api/auth/check', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username requis' });
  const status = db.getAccessStatus(username.trim());
  if (!status) return res.json({ status: 'unknown' });
  res.json({ status: status.status, role: status.role });
});

// Routes admin accès
app.get('/api/admin/access',           requireAuth, (req, res) => res.json({ data: db.getAllAccessRequests() }));
app.post('/api/admin/access/approve',  requireAuth, (req, res) => { const {username,role}=req.body; if(!username) return res.status(400).json({error:'username requis'}); db.approveAccess(username,role||'viewer'); res.json({success:true}); });
app.post('/api/admin/access/revoke',   requireAuth, (req, res) => { const {username}=req.body; if(!username) return res.status(400).json({error:'username requis'}); db.revokeAccess(username); res.json({success:true}); });
app.delete('/api/admin/access/:username', requireAuth, (req, res) => { db.deleteAccessRequest(req.params.username); res.json({success:true}); });

// Middleware auth pour le panel HTML — vérifie le cookie de session
function requirePanelAuth(req, res, next) {
  // API admin toujours accessible avec la clé
  if (req.path.startsWith('/api/')) return next();
  // Page de login toujours accessible
  if (req.path === '/login' || req.path === '/login.html') return next();
  // Fichiers statiques de login
  if (req.path === '/login.css') return next();
  next();
}

app.use(requirePanelAuth);

// Page login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Auto-approuver le propriétaire au démarrage
const PANEL_OWNER = process.env.PANEL_OWNER || '';
if (PANEL_OWNER) {
  try {
    db.initPanelAccess();
    db.requestAccess(PANEL_OWNER);
    db.approveAccess(PANEL_OWNER, 'admin');
    console.log(`[PANEL] Propriétaire auto-approuvé : ${PANEL_OWNER}`);
  } catch(e) {}
}

app.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║  Panel Web → http://localhost:${PORT}      ║`);
  console.log(`╚════════════════════════════════════════╝`);
});
