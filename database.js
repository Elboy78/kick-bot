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
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      peak_viewers INTEGER DEFAULT 0,
      duration_min INTEGER DEFAULT 0
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
    `CREATE TABLE IF NOT EXISTS banned_words (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT NOT NULL UNIQUE,
      action     TEXT NOT NULL DEFAULT 'timeout',
      duration   INTEGER NOT NULL DEFAULT 300,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const LEVELS = [
  { name: 'Bronze',  min: 0,     emoji: '🥉' },
  { name: 'Argent',  min: 500,   emoji: '🥈' },
  { name: 'Or',      min: 1500,  emoji: '🥇' },
  { name: 'Platine', min: 3000,  emoji: '💎' },
  { name: 'Diamant', min: 6000,  emoji: '💠' },
  { name: 'Légende', min: 12000, emoji: '👑' },
];

function getLevel(points) {
  let level = LEVELS[0];
  for (const l of LEVELS) { if (points >= l.min) level = l; }
  return level;
}

function getNextLevel(points) {
  for (const l of LEVELS) { if (points < l.min) return l; }
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

async function addPoints(username, points, reason = 'watch_time') {
  await run(`
    UPDATE viewers
    SET points        = MAX(0, points + ?),
        total_minutes = total_minutes + ?,
        last_seen     = datetime('now')
    WHERE username = ?
  `, [points, reason === 'watch_time' ? 5 : 0, username.toLowerCase()]);

  const viewer = await get(`SELECT points FROM viewers WHERE username = ?`, [username.toLowerCase()]);
  if (viewer) {
    const level = getLevel(viewer.points);
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
    FROM viewers WHERE points > 0
    ORDER BY points DESC, username ASC
    LIMIT ?
  `, [limit]);
  return rows.map((v, i) => ({ ...v, rank: i + 1 }));
}

async function getViewerRank(username) {
  const all_viewers = await all(`SELECT username FROM viewers WHERE points > 0 ORDER BY points DESC, username ASC`);
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
    FROM viewers WHERE points > 0
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

async function endSession(id, peakViewers, durationMin) {
  await run(`UPDATE stream_sessions SET ended_at = datetime('now'), peak_viewers = ?, duration_min = ? WHERE id = ?`, [peakViewers, durationMin, id]);
}

async function getStreamHistory(limit = 10) {
  return all(`SELECT * FROM stream_sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`, [limit]);
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
  } catch(e) { return false; }
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
  getLevel, getNextLevel, LEVELS,
  getCustomCommands, getCustomCommand, setCustomCommand, deleteCustomCommand, toggleCustomCommand,
  getObjectives, createObjective, deleteObjective, achieveObjective,
  startSession, endSession, getStreamHistory,
  createDuel, getPendingDuel, resolveDuel, cancelDuel, getRecentDuels,
  createGiveaway, getActiveGiveaway, joinGiveaway, closeGiveaway, getGiveawayHistory,
  getLobby, joinLobby, removeFromLobby, clearLobby,
  initPanelAccess, requestAccess, getAccessStatus, getAllAccessRequests,
  approveAccess, revokeAccess, deleteAccessRequest,
  initSystemCommandsState, isSystemCmdEnabled, getAllSystemCommandsState, toggleSystemCommand,
  getBannedWords, addBannedWord, deleteBannedWord, toggleBannedWord, checkBannedWords,
};
