require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');

const app    = express();
const PORT   = parseInt(process.env.PANEL_PORT || '3000');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) { next(); }

// Init DB
db.ensureInit().then(async () => {
  const owner = process.env.PANEL_OWNER || '';
  if (owner) {
    await db.requestAccess(owner);
    await db.approveAccess(owner, 'admin');
    console.log(`[PANEL] Propriétaire auto-approuvé : ${owner}`);
  }
}).catch(console.error);

// ── API lecture ───────────────────────────────────────────────────────────────
app.get('/api/leaderboard',    async (req,res) => { try { res.json({data: await db.getLeaderboard(Math.min(parseInt(req.query.limit||10),100))}); } catch(e){res.json({data:[]}); }});
app.get('/api/viewer/:u',      async (req,res) => { try { const v=await db.getViewer(req.params.u); if(!v) return res.status(404).json({error:'Introuvable'}); res.json({data:{...v,rank:await db.getViewerRank(req.params.u)}}); } catch(e){res.status(500).json({error:e.message}); }});
app.get('/api/stats',          async (req,res) => { try { res.json({data: await db.getGlobalStats()}); } catch(e){res.json({data:{}}); }});
app.get('/api/logs',           async (req,res) => { try { res.json({data: await db.getRecentLogs(Math.min(parseInt(req.query.limit||50),500))}); } catch(e){res.json({data:[]}); }});
app.get('/api/active',         async (req,res) => { try { res.json({data: await db.getActiveViewers(parseInt(req.query.minutes||10))}); } catch(e){res.json({data:[]}); }});
app.get('/api/levels',         (req,res) => res.json({data: db.LEVELS}));
app.get('/api/commands',       async (req,res) => { try { res.json({data: await db.getCustomCommands()}); } catch(e){res.json({data:[]}); }});
app.get('/api/objectives',     async (req,res) => { try { res.json({data: await db.getObjectives()}); } catch(e){res.json({data:[]}); }});
app.get('/api/history',        async (req,res) => { try { res.json({data: await db.getStreamHistory(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/duels',          async (req,res) => { try { res.json({data: await db.getRecentDuels(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/giveaways',      async (req,res) => { try { res.json({data: await db.getGiveawayHistory(parseInt(req.query.limit||20))}); } catch(e){res.json({data:[]}); }});
app.get('/api/giveaway/active',async (req,res) => { try { res.json({data: await db.getActiveGiveaway()}); } catch(e){res.json({data:null}); }});
app.get('/api/lobby',          async (req,res) => { try { res.json({data: await db.getLobby()}); } catch(e){res.json({data:[]}); }});

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
app.get('/api/system-commands', async (req,res) => { try { const rows = await db.getCustomCommands(); res.json({data:[]}); } catch(e){res.json({data:[]}); }});
app.post('/api/admin/system-commands/toggle', requireAuth, async (req,res) => { try { res.json({success:true}); } catch(e){res.status(500).json({error:e.message}); }});

// Live force
let forcedLiveStatus = null;
app.post('/api/admin/live/force', requireAuth, (req,res) => { const {status}=req.body; forcedLiveStatus=status==='on'?true:status==='off'?false:null; res.json({success:true,forced:forcedLiveStatus}); });
app.get('/api/admin/live/status', requireAuth, (req,res) => res.json({forced:forcedLiveStatus}));

// Live status
app.get('/api/live', async (req,res) => {
  if (forcedLiveStatus !== null) return res.json({live:forcedLiveStatus,viewers:0,forced:true});
  try {
    const axios = require('axios');
    const r = await axios.get(`https://kick.com/api/v2/channels/${process.env.KICK_CHANNEL||''}`, {
      headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'},timeout:6000
    });
    const live = r.data?.livestream;
    res.json({live:!!(live?.is_live),viewers:live?.viewer_count||0});
  } catch(e) { res.json({live:false,viewers:0}); }
});

app.get('/login', (req,res) => res.sendFile(path.join(__dirname,'public','login.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║  Panel Web → http://localhost:${PORT}      ║`);
  console.log(`╚════════════════════════════════════════╝`);
});
