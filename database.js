/**
 * database.js — Base de données Turso (libSQL)
 * Persiste entre les redéploiements Render
 */

const { createClient } = require('@libsql/client');

let client = null;

function getDB() {
  if (!client) {
    if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
      client = createClient({
        url:       process.env.TURSO_URL,
        authToken: process.env.TURSO_TOKEN,
        syncUrl:   undefined,
      });
      console.log('[DB] Connecté à Turso ✓');
    } else {
      // Fallback local SQLite si pas de Turso configuré
      const Database = require('better-sqlite3');
      const path = require('path');
      const fs = require('fs');
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const db = new Database(path.join(dataDir, 'viewers.db'));
      db.pragma('journal_mode = WAL');
      console.log('[DB] SQLite local (fallback) ✓');
      return db;
    }
  }
  return client;
}

// Wrapper pour exécuter des requêtes compatibles Turso et SQLite
async function run(sql, params = []) {
  const db = getDB();
  if (db.execute) {
    // Turso
    await db.execute({ sql, args: params });
  } else {
    // SQLite
    db.prepare(sql).run(...params);
  }
}

async function all(sql, params = []) {
  const db = getDB();
  if (db.execute) {
    const result = await db.execute({ sql, args: params });
    return result.rows.map(row => {
      const obj = {};
      result.columns.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  } else {
    return db.prepare(sql).all(...params);
  }
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

// ─── Init Schema ──────────────────────────────────────────────────────────────

async function initSchema() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS viewers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      kick_user_id  TEXT,
      points        INTEGER NOT NULL DEFAULT 0,
      total_minutes INTEGER NOT NULL DEFAULT 0,
      sessions      INTEGER NOT NULL DEFAULT 0,
      level         TEXT    NOT NULL DEFAULT 'Bronze',
      last_seen     TEXT,
      first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS points_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      points     INTEGER NOT NULL,
      reason     TEXT    NOT NULL DEFAULT 'watch_time',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS stream_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at      TEXT,
      peak_viewers  INTEGER DEFAULT 0,
      avg_viewers   INTEGER DEFAULT 0,
      viewer_sum    INTEGER DEFAULT 0,
      viewer_samples INTEGER DEFAULT 0,
      duration_min  INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS custom_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger    TEXT NOT NULL UNIQUE,
      response   TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS objectives (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT,
      target      INTEGER NOT NULL,
      reward      TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      achieved    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS duels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger  TEXT NOT NULL,
      opponent    TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      winner      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS giveaways (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      prize      TEXT NOT NULL,
      cost       INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'open',
      winner     TEXT,
      entries    TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at   TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS lobby (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT NOT NULL UNIQUE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS panel_access (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'pending',
      role       TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS quotes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      author     TEXT,
      added_by   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS counters (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      value      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS timers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      message    TEXT NOT NULL,
      interval_ms INTEGER NOT NULL DEFAULT 300000,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      joined_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS polls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      question   TEXT NOT NULL,
      options    TEXT NOT NULL DEFAULT '[]',
      votes      TEXT NOT NULL DEFAULT '{}',
      status     TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at   TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS shoutouts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      message    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message     TEXT NOT NULL,
      interval_ms INTEGER NOT NULL DEFAULT 600000,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_sent   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS banned_words (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT NOT NULL UNIQUE,
      action     TEXT NOT NULL DEFAULT 'timeout',
      duration   INTEGER NOT NULL DEFAULT 300,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS command_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger    TEXT NOT NULL,
      username   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS chat_activity_daily (
      date            TEXT PRIMARY KEY,
      message_count   INTEGER NOT NULL DEFAULT 0,
      unique_chatters TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS level_config (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      min_points INTEGER NOT NULL DEFAULT 0,
      emoji      TEXT NOT NULL DEFAULT '⭐',
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS points_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tts_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider     TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS bot_status (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tts_blacklist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tts_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT,
      message     TEXT NOT NULL,
      amount      REAL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'played',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS bot_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '1',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS system_commands_state (
      trigger  TEXT PRIMARY KEY,
      enabled  INTEGER NOT NULL DEFAULT 1
    )`,
  ];

  for (const sql of tables) {
    try {
      await run(sql);
    } catch(e) {
      // Table déjà existante — ignorer
      if (!e.message?.includes('already exists')) {
        console.error('[DB] Erreur création table:', e.message);
      }
    }
  }
  console.log('[DB] Schema initialisé ✓');
}

// ─── Niveaux ──────────────────────────────────────────────────────────────────

// Renvoie la date du jour (YYYY-MM-DD) en heure de Paris, peu importe le fuseau
// du serveur (Render tourne en UTC, ce qui décale "aujourd'hui" autour de minuit).
function todayParis() {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(new Date()); // format en-CA => YYYY-MM-DD
}

const DEFAULT_LEVELS = [
  { name: 'Bronze',  min: 0,     emoji: '🥉' },
  { name: 'Argent',  min: 500,   emoji: '🥈' },
  { name: 'Or',      min: 1500,  emoji: '🥇' },
  { name: 'Platine', min: 3000,  emoji: '💎' },
  { name: 'Diamant', min: 6000,  emoji: '💠' },
  { name: 'Légende', min: 12000, emoji: '👑' },
];

async function ensureLevelsSeeded() {
  const count = await get(`SELECT COUNT(*) as c FROM level_config`);
  if (count?.c > 0) return;
  for (let i = 0; i < DEFAULT_LEVELS.length; i++) {
    const l = DEFAULT_LEVELS[i];
    await run(`INSERT INTO level_config (name, min_points, emoji, sort_order) VALUES (?, ?, ?, ?)`, [l.name, l.min, l.emoji, i]);
  }
}

async function getLevels() {
  await ensureLevelsSeeded();
  const rows = await all(`SELECT * FROM level_config ORDER BY min_points ASC`);
  return rows.map(r => ({ id: r.id, name: r.name, min: r.min_points, emoji: r.emoji }));
}

async function addLevel(name, min, emoji) {
  const maxOrder = await get(`SELECT MAX(sort_order) as m FROM level_config`);
  await run(`INSERT INTO level_config (name, min_points, emoji, sort_order) VALUES (?, ?, ?, ?)`,
    [name, min, emoji || '⭐', (maxOrder?.m ?? -1) + 1]);
}

async function updateLevel(id, name, min, emoji) {
  await run(`UPDATE level_config SET name = ?, min_points = ?, emoji = ? WHERE id = ?`, [name, min, emoji, id]);
}

async function deleteLevel(id) {
  await run(`DELETE FROM level_config WHERE id = ?`, [id]);
}

async function getLevel(points) {
  const levels = await getLevels();
  let level = levels[0] || DEFAULT_LEVELS[0];
  for (const l of levels) { if (points >= l.min) level = l; }
  return level;
}

async function getNextLevel(points) {
  const levels = await getLevels();
  for (const l of levels) { if (points < l.min) return l; }
  return null;
}

// ─── Viewers ──────────────────────────────────────────────────────────────────

async function upsertViewer(username, kickUserId = null) {
  await run(`
    INSERT INTO viewers (username, kick_user_id, last_seen)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      last_seen    = datetime('now'),
      kick_user_id = COALESCE(?, kick_user_id)
  `, [username.toLowerCase(), kickUserId, kickUserId]);
}

async function addPoints(username, points, reason = 'watch_time', minutesWatched = 0) {
  await run(`
    UPDATE viewers
    SET points        = MAX(0, points + ?),
        total_minutes = total_minutes + ?,
        last_seen     = datetime('now')
    WHERE username = ?
  `, [points, minutesWatched, username.toLowerCase()]);

  const viewer = await get(`SELECT points FROM viewers WHERE username = ?`, [username.toLowerCase()]);
  if (viewer) {
    const level = await getLevel(viewer.points);
    await run(`UPDATE viewers SET level = ? WHERE username = ?`, [level.name, username.toLowerCase()]);
  }

  await run(`INSERT INTO points_log (username, points, reason) VALUES (?, ?, ?)`,
    [username.toLowerCase(), points, reason]);
}

async function getViewer(username) {
  return get(`SELECT * FROM viewers WHERE username = ?`, [username.toLowerCase()]);
}

async function getLeaderboard(limit = 10) {
  const rows = await all(`
    SELECT username, points, total_minutes, sessions, last_seen, level
    FROM viewers
    ORDER BY points DESC, last_seen DESC
    LIMIT ?
  `, [limit]);
  return rows.map((v, i) => ({ ...v, rank: i + 1 }));
}

async function getViewerRank(username) {
  const all_viewers = await all(`SELECT username FROM viewers ORDER BY points DESC, last_seen DESC`);
  const idx = all_viewers.findIndex(v => v.username === username.toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

async function getGlobalStats() {
  return get(`
    SELECT
      COUNT(*) as total_viewers,
      SUM(points) as total_points_distributed,
      SUM(total_minutes) as total_minutes_watched,
      AVG(points) as avg_points,
      MAX(points) as max_points,
      (SELECT username FROM viewers ORDER BY points DESC LIMIT 1) as top_viewer
    FROM viewers
  `);
}

async function getRecentLogs(limit = 50) {
  return all(`SELECT username, points, reason, created_at FROM points_log ORDER BY created_at DESC LIMIT ?`, [limit]);
}

async function getActiveViewers(minutes = 120) {
  return all(`SELECT username FROM viewers WHERE last_seen >= datetime('now', ?) ORDER BY last_seen DESC`, [`-${minutes} minutes`]);
}

async function clearAllPoints() {
  await run(`UPDATE viewers SET points = 0, total_minutes = 0, level = 'Bronze'`);
  await run(`DELETE FROM points_log`);
}

// ─── Commandes ────────────────────────────────────────────────────────────────

async function getCustomCommands() {
  return all(`SELECT * FROM custom_commands ORDER BY trigger ASC`);
}

async function getCustomCommand(trigger) {
  return get(`SELECT * FROM custom_commands WHERE trigger = ? AND enabled = 1`, [trigger.toLowerCase()]);
}

async function setCustomCommand(trigger, response) {
  await run(`
    INSERT INTO custom_commands (trigger, response) VALUES (?, ?)
    ON CONFLICT(trigger) DO UPDATE SET response = ?
  `, [trigger.toLowerCase(), response, response]);
}

async function deleteCustomCommand(trigger) {
  await run(`DELETE FROM custom_commands WHERE trigger = ?`, [trigger.toLowerCase()]);
}

async function toggleCustomCommand(trigger, enabled) {
  await run(`UPDATE custom_commands SET enabled = ? WHERE trigger = ?`, [enabled ? 1 : 0, trigger.toLowerCase()]);
}

// ─── Objectifs ────────────────────────────────────────────────────────────────

async function getObjectives() {
  return all(`SELECT * FROM objectives ORDER BY active DESC, created_at DESC`);
}

async function createObjective(title, description, target, reward) {
  const result = await run(`INSERT INTO objectives (title, description, target, reward) VALUES (?, ?, ?, ?)`, [title, description, target, reward]);
  return result;
}

async function deleteObjective(id) {
  await run(`DELETE FROM objectives WHERE id = ?`, [id]);
}

async function achieveObjective(id) {
  await run(`UPDATE objectives SET achieved = 1, active = 0 WHERE id = ?`, [id]);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

async function startSession() {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO stream_sessions (started_at) VALUES (datetime('now'))`, args: [] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO stream_sessions (started_at) VALUES (datetime('now'))`).run().lastInsertRowid;
  }
}

async function recordViewerSample(id, viewerCount) {
  await run(`UPDATE stream_sessions SET viewer_sum = viewer_sum + ?, viewer_samples = viewer_samples + 1 WHERE id = ?`, [viewerCount, id]);
}

async function endSession(id, peakViewers, durationMin) {
  const row = await get(`SELECT viewer_sum, viewer_samples FROM stream_sessions WHERE id = ?`, [id]);
  const avgViewers = row && row.viewer_samples > 0 ? Math.round(row.viewer_sum / row.viewer_samples) : peakViewers;
  await run(`UPDATE stream_sessions SET ended_at = datetime('now'), peak_viewers = ?, avg_viewers = ?, duration_min = ? WHERE id = ?`, [peakViewers, avgViewers, durationMin, id]);
}

async function getStreamHistory(limit = 10) {
  return all(`SELECT * FROM stream_sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`, [limit]);
}

// ─── Analytics : usage des commandes & activité du chat ────────────────────────

async function logCommandUsage(trigger, username) {
  await run(`INSERT INTO command_usage (trigger, username) VALUES (?, ?)`, [trigger.toLowerCase(), (username||'').toLowerCase()]);
}

async function getCommandUsageStats(days = 7) {
  const rows = await all(
    `SELECT trigger, COUNT(*) as count FROM command_usage
     WHERE created_at >= datetime('now', ?)
     GROUP BY trigger ORDER BY count DESC LIMIT 10`,
    [`-${days} days`]
  );
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map(r => ({ trigger: r.trigger, count: r.count, pct: total > 0 ? Math.round((r.count / total) * 100) : 0 }));
}

async function logChatActivity(username) {
  const today = todayParis();
  const row = await get(`SELECT * FROM chat_activity_daily WHERE date = ?`, [today]);
  if (!row) {
    await run(`INSERT INTO chat_activity_daily (date, message_count, unique_chatters) VALUES (?, 1, ?)`,
      [today, JSON.stringify([username.toLowerCase()])]);
  } else {
    let chatters = [];
    try { chatters = JSON.parse(row.unique_chatters); } catch(e) {}
    const lower = username.toLowerCase();
    if (!chatters.includes(lower)) chatters.push(lower);
    await run(`UPDATE chat_activity_daily SET message_count = message_count + 1, unique_chatters = ? WHERE date = ?`,
      [JSON.stringify(chatters), today]);
  }
}

async function getChatActivityWeek() {
  const rows = await all(`SELECT * FROM chat_activity_daily WHERE date >= date('now', '-6 days') ORDER BY date ASC`);
  const map = {};
  rows.forEach(r => {
    let chatters = [];
    try { chatters = JSON.parse(r.unique_chatters); } catch(e) {}
    map[r.date] = { messageCount: r.message_count, uniqueChatters: chatters.length };
  });
  // Compléter les 7 derniers jours (en heure de Paris) même sans données (0 par défaut)
  const todayStr = todayParis(); // YYYY-MM-DD en heure de Paris
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const todayUTCMidnight = Date.UTC(ty, tm - 1, td); // ancre neutre, juste pour décaler par jour
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const dateStr = new Date(todayUTCMidnight - i * 86400000).toISOString().slice(0, 10);
    result.push({ date: dateStr, messageCount: map[dateStr]?.messageCount || 0, uniqueChatters: map[dateStr]?.uniqueChatters || 0 });
  }
  return result;
}

async function getSessionsWithAvgViewers(limit = 14) {
  return all(`SELECT id, started_at, avg_viewers, peak_viewers, duration_min FROM stream_sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`, [limit]);
}

// ─── Duels ────────────────────────────────────────────────────────────────────

async function createDuel(challenger, opponent, amount) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO duels (challenger, opponent, amount) VALUES (?, ?, ?)`, args: [challenger.toLowerCase(), opponent.toLowerCase(), amount] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO duels (challenger, opponent, amount) VALUES (?, ?, ?)`).run(challenger.toLowerCase(), opponent.toLowerCase(), amount).lastInsertRowid;
  }
}

async function getPendingDuel(opponent) {
  return get(`SELECT * FROM duels WHERE opponent = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [opponent.toLowerCase()]);
}

async function resolveDuel(id, winner) {
  await run(`UPDATE duels SET status = 'resolved', winner = ? WHERE id = ?`, [winner, id]);
}

async function cancelDuel(id) {
  await run(`UPDATE duels SET status = 'cancelled' WHERE id = ?`, [id]);
}

async function getRecentDuels(limit = 10) {
  return all(`SELECT * FROM duels ORDER BY created_at DESC LIMIT ?`, [limit]);
}

// ─── Giveaway ─────────────────────────────────────────────────────────────────

async function createGiveaway(title, prize, cost = 0) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO giveaways (title, prize, cost) VALUES (?, ?, ?)`, args: [title, prize, cost] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO giveaways (title, prize, cost) VALUES (?, ?, ?)`).run(title, prize, cost).lastInsertRowid;
  }
}

async function getActiveGiveaway() {
  return get(`SELECT * FROM giveaways WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
}

async function joinGiveaway(id, username) {
  const g = await get(`SELECT entries FROM giveaways WHERE id = ?`, [id]);
  if (!g) return false;
  const entries = JSON.parse(g.entries);
  if (entries.includes(username.toLowerCase())) return false;
  entries.push(username.toLowerCase());
  await run(`UPDATE giveaways SET entries = ? WHERE id = ?`, [JSON.stringify(entries), id]);
  return true;
}

async function closeGiveaway(id) {
  const g = await get(`SELECT * FROM giveaways WHERE id = ?`, [id]);
  if (!g) return null;
  const entries = JSON.parse(g.entries);
  if (!entries.length) return null;
  const winner = entries[Math.floor(Math.random() * entries.length)];
  await run(`UPDATE giveaways SET status = 'closed', winner = ?, ended_at = datetime('now') WHERE id = ?`, [winner, id]);
  return winner;
}

async function getGiveawayHistory(limit = 10) {
  return all(`SELECT * FROM giveaways WHERE status = 'closed' ORDER BY ended_at DESC LIMIT ?`, [limit]);
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

async function getLobby() {
  return all(`SELECT * FROM lobby ORDER BY joined_at ASC`);
}

async function joinLobby(username) {
  try {
    await run(`INSERT INTO lobby (username) VALUES (?)`, [username.toLowerCase()]);
    return true;
  } catch(e) {
    console.error(`[LOBBY] Erreur ajout ${username}:`, e.message);
    return false;
  }
}

async function removeFromLobby(username) {
  await run(`DELETE FROM lobby WHERE username = ?`, [username.toLowerCase()]);
}

async function clearLobby() {
  await run(`DELETE FROM lobby`);
}

// ─── Accès Panel ─────────────────────────────────────────────────────────────

async function initPanelAccess() {
  // Déjà créé dans initSchema
}

async function requestAccess(username) {
  try {
    await run(`INSERT INTO panel_access (username) VALUES (?) ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now') WHERE status = 'pending'`, [username.toLowerCase()]);
    return true;
  } catch(e) { return false; }
}

async function getAccessStatus(username) {
  return get(`SELECT * FROM panel_access WHERE username = ?`, [username.toLowerCase()]);
}

async function getAllAccessRequests() {
  return all(`SELECT * FROM panel_access ORDER BY created_at DESC`);
}

async function approveAccess(username, role = 'viewer') {
  await run(`UPDATE panel_access SET status = 'approved', role = ?, updated_at = datetime('now') WHERE username = ?`, [role, username.toLowerCase()]);
}

async function revokeAccess(username) {
  await run(`UPDATE panel_access SET status = 'revoked', updated_at = datetime('now') WHERE username = ?`, [username.toLowerCase()]);
}

async function deleteAccessRequest(username) {
  await run(`DELETE FROM panel_access WHERE username = ?`, [username.toLowerCase()]);
}

// ─── Points Config (montant et intervalle pilotables depuis le panel) ─────────

async function getPointsConfig() {
  const rows = await all(`SELECT * FROM points_config`);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}
async function setPointsConfigValue(key, value) {
  await run(
    `INSERT INTO points_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [key, String(value), String(value)]
  );
}
async function setPointsConfigBulk(obj) {
  for (const [key, value] of Object.entries(obj)) {
    await setPointsConfigValue(key, value);
  }
}

// ─── TTS Config (réglages pilotables depuis le panel) ──────────────────────────

async function getTTSConfig() {
  const rows = await all(`SELECT * FROM tts_config`);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}
async function setTTSConfigValue(key, value) {
  await run(
    `INSERT INTO tts_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [key, String(value), String(value)]
  );
}
async function setTTSConfigBulk(obj) {
  for (const [key, value] of Object.entries(obj)) {
    await setTTSConfigValue(key, value);
  }
}

// ─── OAuth Tokens (Kick officiel) ──────────────────────────────────────────────

async function saveOAuthToken(provider, accessToken, refreshToken, expiresAt) {
  await run(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')`,
    [provider, accessToken, refreshToken, expiresAt, accessToken, refreshToken, expiresAt]
  );
}
async function getOAuthToken(provider) {
  return get(`SELECT * FROM oauth_tokens WHERE provider = ?`, [provider]);
}
async function deleteOAuthToken(provider) {
  await run(`DELETE FROM oauth_tokens WHERE provider = ?`, [provider]);
}

// ─── Bot Status (état partagé entre bot.js et panel.js) ───────────────────────

async function setBotStatus(key, value) {
  await run(`INSERT INTO bot_status (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [key, String(value), String(value)]);
}
async function getBotStatus(key) {
  const r = await get(`SELECT value, updated_at FROM bot_status WHERE key = ?`, [key]);
  return r || null;
}
async function getAllBotStatus() {
  const rows = await all(`SELECT * FROM bot_status`);
  const result = {};
  rows.forEach(r => { result[r.key] = { value: r.value, updated_at: r.updated_at }; });
  return result;
}

// ─── TTS (Text-To-Speech dons) ─────────────────────────────────────────────────

async function getTTSBlacklist() { return all(`SELECT * FROM tts_blacklist ORDER BY word ASC`); }
async function addTTSBlacklistWord(word) {
  try { await run(`INSERT INTO tts_blacklist (word) VALUES (?)`, [word.toLowerCase().trim()]); return true; }
  catch(e) { return false; }
}
async function deleteTTSBlacklistWord(id) { await run(`DELETE FROM tts_blacklist WHERE id = ?`, [id]); }
async function isTTSBlacklisted(text) {
  const words = await getTTSBlacklist();
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w.word));
}

async function getTTSHistory(limit = 30) { return all(`SELECT * FROM tts_history ORDER BY created_at DESC LIMIT ?`, [limit]); }
async function addTTSHistory(username, message, amount, status) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO tts_history (username, message, amount, status) VALUES (?, ?, ?, ?)`, args: [username||'', message, amount||0, status||'played'] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO tts_history (username, message, amount, status) VALUES (?, ?, ?, ?)`).run(username||'', message, amount||0, status||'played').lastInsertRowid;
  }
}
async function clearTTSHistory() { await run(`DELETE FROM tts_history`); }

// ─── Bot Settings ─────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  'follow_alerts':      { label: 'Alertes nouveaux followers', desc: 'Le bot annonce les nouveaux followers dans le chat', category: 'Chat' },
  'points_enabled':     { label: 'Système de points', desc: 'Distribue des points aux viewers pendant le live', category: 'Points' },
  'duel_enabled':       { label: 'Duels entre viewers', desc: 'Permet aux viewers de se défier avec !duel', category: 'Jeux' },
  'giveaway_enabled':   { label: 'Giveaways', desc: 'Permet de lancer des giveaways avec !participer', category: 'Jeux' },
  'lobby_enabled':      { label: 'Lobby de jeu', desc: 'Permet aux viewers de rejoindre le lobby avec !lobby', category: 'Jeux' },
  'poll_enabled':       { label: 'Sondages', desc: 'Permet aux viewers de voter avec !vote', category: 'Chat' },
  'queue_enabled':      { label: 'File d attente', desc: 'Permet aux viewers de rejoindre la file avec !queue', category: 'Chat' },
  'quote_enabled':      { label: 'Citations', desc: 'Commandes !quote et !addquote', category: 'Chat' },
  'dice_enabled':       { label: 'Jeux de hasard', desc: 'Commandes !dice, !pfc, !rps', category: 'Jeux' },
  'shoutout_enabled':   { label: 'Shoutout automatique', desc: 'Commande !so pour faire un shoutout', category: 'Chat' },
  'announcements_enabled': { label: 'Annonces automatiques', desc: 'Messages automatiques pendant le live', category: 'Chat' },
  'moderation_enabled': { label: 'Modération automatique', desc: 'Ban/timeout sur mots bannis', category: 'Modération' },
  'uptime_enabled':     { label: 'Commande uptime', desc: 'Permet aux viewers de voir la duree du stream avec !uptime', category: 'Chat' },
  'tts_enabled':        { label: 'TTS Donations', desc: 'Lit les messages de dons à voix haute sur l overlay', category: 'TTS' },
};

async function getAllSettings() {
  const rows = await all(`SELECT * FROM bot_settings`);
  const result = {};
  // Valeurs par défaut
  for (const key of Object.keys(DEFAULT_SETTINGS)) result[key] = true;
  // Valeurs en base
  rows.forEach(r => { result[r.key] = r.value === '1'; });
  return result;
}

async function getSetting(key) {
  const r = await get(`SELECT value FROM bot_settings WHERE key = ?`, [key]);
  return r ? r.value === '1' : true; // true par défaut
}

async function setSetting(key, enabled) {
  await run(`INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [key, enabled ? '1' : '0', enabled ? '1' : '0']);
}

// ─── System Commands ──────────────────────────────────────────────────────────

async function initSystemCommandsState(commands) {
  for (const cmd of commands) {
    try {
      await run(`INSERT OR IGNORE INTO system_commands_state (trigger, enabled) VALUES (?, 1)`, [cmd]);
    } catch(e) {}
  }
}

async function isSystemCmdEnabled(trigger) {
  const r = await get(`SELECT enabled FROM system_commands_state WHERE trigger = ?`, [trigger]);
  return r ? r.enabled === 1 : true;
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

async function getQuotes() { return all(`SELECT * FROM quotes ORDER BY created_at DESC`); }
async function addQuote(text, author, addedBy) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO quotes (text, author, added_by) VALUES (?, ?, ?)`, args: [text, author || '', addedBy || ''] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO quotes (text, author, added_by) VALUES (?, ?, ?)`).run(text, author || '', addedBy || '').lastInsertRowid;
  }
}
async function getRandomQuote() {
  return get(`SELECT * FROM quotes ORDER BY RANDOM() LIMIT 1`);
}
async function deleteQuote(id) { await run(`DELETE FROM quotes WHERE id = ?`, [id]); }

// ─── Counters ─────────────────────────────────────────────────────────────────

async function getCounters() { return all(`SELECT * FROM counters ORDER BY name ASC`); }
async function getCounter(name) { return get(`SELECT * FROM counters WHERE name = ?`, [name.toLowerCase()]); }
async function setCounter(name, value) {
  await run(`INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = ?`, [name.toLowerCase(), value, value]);
}
async function incrementCounter(name, by = 1) {
  await run(`INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + ?`, [name.toLowerCase(), by, by]);
  return get(`SELECT * FROM counters WHERE name = ?`, [name.toLowerCase()]);
}
async function deleteCounter(name) { await run(`DELETE FROM counters WHERE name = ?`, [name.toLowerCase()]); }

// ─── Timers ───────────────────────────────────────────────────────────────────

async function getTimers() { return all(`SELECT * FROM timers ORDER BY name ASC`); }
async function setTimer(name, message, interval_ms) {
  await run(`INSERT INTO timers (name, message, interval_ms) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET message = ?, interval_ms = ?`,
    [name.toLowerCase(), message, interval_ms, message, interval_ms]);
}
async function toggleTimer(name, enabled) {
  await run(`UPDATE timers SET enabled = ? WHERE name = ?`, [enabled ? 1 : 0, name.toLowerCase()]);
}
async function deleteTimer(name) { await run(`DELETE FROM timers WHERE name = ?`, [name.toLowerCase()]); }

// ─── Queue ────────────────────────────────────────────────────────────────────

async function getQueue() { return all(`SELECT * FROM queue ORDER BY joined_at ASC`); }
async function joinQueue(username) {
  try {
    await run(`INSERT INTO queue (username) VALUES (?)`, [username.toLowerCase()]);
    return true;
  } catch(e) { return false; }
}
async function removeFromQueue(username) { await run(`DELETE FROM queue WHERE username = ?`, [username.toLowerCase()]); }
async function clearQueue() { await run(`DELETE FROM queue`); }
async function getQueuePosition(username) {
  const q = await getQueue();
  const idx = q.findIndex(v => v.username === username.toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

// ─── Polls ────────────────────────────────────────────────────────────────────

async function createPoll(question, options) {
  const db = getDB();
  const votes = {};
  options.forEach((_, i) => votes[i] = 0);
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO polls (question, options, votes) VALUES (?, ?, ?)`, args: [question, JSON.stringify(options), JSON.stringify(votes)] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO polls (question, options, votes) VALUES (?, ?, ?)`).run(question, JSON.stringify(options), JSON.stringify(votes)).lastInsertRowid;
  }
}
async function getActivePoll() { return get(`SELECT * FROM polls WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`); }
async function votePoll(id, username, optionIndex) {
  const p = await get(`SELECT * FROM polls WHERE id = ?`, [id]);
  if (!p) return false;
  const votes = JSON.parse(p.votes);
  const options = JSON.parse(p.options);
  if (optionIndex < 0 || optionIndex >= options.length) return false;
  votes[optionIndex] = (votes[optionIndex] || 0) + 1;
  await run(`UPDATE polls SET votes = ? WHERE id = ?`, [JSON.stringify(votes), id]);
  return votes;
}
async function closePoll(id) {
  await run(`UPDATE polls SET status = 'closed', ended_at = datetime('now') WHERE id = ?`, [id]);
  return get(`SELECT * FROM polls WHERE id = ?`, [id]);
}
async function getPolls(limit = 10) { return all(`SELECT * FROM polls ORDER BY created_at DESC LIMIT ?`, [limit]); }

// ─── Announcements ────────────────────────────────────────────────────────────

async function getAnnouncements() { return all(`SELECT * FROM announcements ORDER BY created_at DESC`); }
async function addAnnouncement(message, interval_ms) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO announcements (message, interval_ms) VALUES (?, ?)`, args: [message, interval_ms] });
    return Number(r.lastInsertRowid);
  } else {
    return db.prepare(`INSERT INTO announcements (message, interval_ms) VALUES (?, ?)`).run(message, interval_ms).lastInsertRowid;
  }
}
async function toggleAnnouncement(id, enabled) { await run(`UPDATE announcements SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]); }
async function deleteAnnouncement(id) { await run(`DELETE FROM announcements WHERE id = ?`, [id]); }
async function updateAnnouncementSent(id) { await run(`UPDATE announcements SET last_sent = datetime('now') WHERE id = ?`, [id]); }

// ─── Banned Words ─────────────────────────────────────────────────────────────

async function getBannedWords() {
  return all(`SELECT * FROM banned_words ORDER BY created_at DESC`);
}

async function addBannedWord(word, action, duration) {
  try {
    await run(`INSERT INTO banned_words (word, action, duration) VALUES (?, ?, ?)
      ON CONFLICT(word) DO UPDATE SET action=?, duration=?`,
      [word.toLowerCase(), action, duration, action, duration]);
    return true;
  } catch(e) { return false; }
}

async function deleteBannedWord(id) {
  await run(`DELETE FROM banned_words WHERE id = ?`, [id]);
}

async function toggleBannedWord(id, enabled) {
  await run(`UPDATE banned_words SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
}

async function checkBannedWords(message) {
  const words = await all(`SELECT * FROM banned_words WHERE enabled = 1`);
  const lower = message.toLowerCase();
  for (const w of words) {
    if (lower.includes(w.word.toLowerCase())) return w;
  }
  return null;
}

async function getAllSystemCommandsState() {
  return all(`SELECT * FROM system_commands_state ORDER BY trigger ASC`);
}

async function toggleSystemCommand(trigger, enabled) {
  await run(`INSERT OR REPLACE INTO system_commands_state (trigger, enabled) VALUES (?, ?)`, [trigger, enabled ? 1 : 0]);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    try {
      await initSchema();
    } catch(e) {
      console.error('[DB] Erreur init schema:', e.message);
    }
    initialized = true;
  }
}

module.exports = {
  ensureInit,
  getDB,
  upsertViewer, addPoints, getViewer, getLeaderboard, getViewerRank,
  getGlobalStats, getRecentLogs, getActiveViewers, clearAllPoints,
  getLevel, getNextLevel, getLevels, addLevel, updateLevel, deleteLevel,
  getCustomCommands, getCustomCommand, setCustomCommand, deleteCustomCommand, toggleCustomCommand,
  getObjectives, createObjective, deleteObjective, achieveObjective,
  startSession, endSession, getStreamHistory, recordViewerSample, getSessionsWithAvgViewers,
  logCommandUsage, getCommandUsageStats, logChatActivity, getChatActivityWeek,
  createDuel, getPendingDuel, resolveDuel, cancelDuel, getRecentDuels,
  createGiveaway, getActiveGiveaway, joinGiveaway, closeGiveaway, getGiveawayHistory,
  getLobby, joinLobby, removeFromLobby, clearLobby,
  initPanelAccess, requestAccess, getAccessStatus, getAllAccessRequests,
  approveAccess, revokeAccess, deleteAccessRequest,
  initSystemCommandsState, isSystemCmdEnabled, getAllSystemCommandsState, toggleSystemCommand,
  getAllSettings, getSetting, setSetting, DEFAULT_SETTINGS,
  getBannedWords, addBannedWord, deleteBannedWord, toggleBannedWord, checkBannedWords,
  getQuotes, addQuote, getRandomQuote, deleteQuote,
  getCounters, getCounter, setCounter, incrementCounter, deleteCounter,
  getTimers, setTimer, toggleTimer, deleteTimer,
  getQueue, joinQueue, removeFromQueue, clearQueue, getQueuePosition,
  createPoll, getActivePoll, votePoll, closePoll, getPolls,
  getAnnouncements, addAnnouncement, toggleAnnouncement, deleteAnnouncement, updateAnnouncementSent,
  getTTSBlacklist, addTTSBlacklistWord, deleteTTSBlacklistWord, isTTSBlacklisted,
  getTTSHistory, addTTSHistory, clearTTSHistory,
  getTTSConfig, setTTSConfigValue, setTTSConfigBulk,
  getPointsConfig, setPointsConfigValue, setPointsConfigBulk,
  setBotStatus, getBotStatus, getAllBotStatus,
  saveOAuthToken, getOAuthToken, deleteOAuthToken,
};
