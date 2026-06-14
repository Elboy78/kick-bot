/**
 * database.js — Base de données SQLite complète
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'viewers.db');
let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDB();
  d.exec(`
    CREATE TABLE IF NOT EXISTS viewers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      kick_user_id  TEXT,
      points        INTEGER NOT NULL DEFAULT 0,
      total_minutes INTEGER NOT NULL DEFAULT 0,
      sessions      INTEGER NOT NULL DEFAULT 0,
      level         TEXT    NOT NULL DEFAULT 'Bronze',
      last_seen     TEXT,
      first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS points_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL,
      points     INTEGER NOT NULL,
      reason     TEXT    NOT NULL DEFAULT 'watch_time',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stream_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      peak_viewers INTEGER DEFAULT 0,
      duration_min INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS custom_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      response   TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS objectives (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT,
      target      INTEGER NOT NULL,
      reward      TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      achieved    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS duels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger  TEXT NOT NULL,
      opponent    TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      winner      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS giveaways (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      prize      TEXT NOT NULL,
      cost       INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'open',
      winner     TEXT,
      entries    TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_viewers_points   ON viewers(points DESC);
    CREATE INDEX IF NOT EXISTS idx_viewers_username ON viewers(username);
    CREATE INDEX IF NOT EXISTS idx_log_username     ON points_log(username);
    CREATE INDEX IF NOT EXISTS idx_log_created      ON points_log(created_at);
  `);

  // Ajouter les colonnes manquantes si upgrade depuis ancienne version
  try { d.prepare(`ALTER TABLE viewers ADD COLUMN level TEXT NOT NULL DEFAULT 'Bronze'`).run(); } catch(e) {}
  try { d.prepare(`ALTER TABLE custom_commands ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`).run(); } catch(e) {}

  console.log('[DB] Base de données initialisée ✓');
}

// ─── Niveaux ─────────────────────────────────────────────────────────────────

const LEVELS = [
  { name: 'Bronze',   min: 0,     emoji: '🥉' },
  { name: 'Argent',   min: 500,   emoji: '🥈' },
  { name: 'Or',       min: 1500,  emoji: '🥇' },
  { name: 'Platine',  min: 3000,  emoji: '💎' },
  { name: 'Diamant',  min: 6000,  emoji: '💠' },
  { name: 'Légende',  min: 12000, emoji: '👑' },
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

// ─── Viewers ─────────────────────────────────────────────────────────────────

function upsertViewer(username, kickUserId = null) {
  const d = getDB();
  d.prepare(`
    INSERT INTO viewers (username, kick_user_id, last_seen)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      last_seen    = datetime('now'),
      kick_user_id = COALESCE(excluded.kick_user_id, kick_user_id)
  `).run(username.toLowerCase(), kickUserId);
}

function addPoints(username, points, reason = 'watch_time') {
  const d = getDB();
  const tx = d.transaction(() => {
    d.prepare(`
      UPDATE viewers
      SET points        = MAX(0, points + ?),
          total_minutes = total_minutes + ?,
          last_seen     = datetime('now')
      WHERE username = ? COLLATE NOCASE
    `).run(points, reason === 'watch_time' ? 5 : 0, username.toLowerCase());

    // Mettre à jour le niveau
    const viewer = d.prepare(`SELECT points FROM viewers WHERE username = ? COLLATE NOCASE`).get(username.toLowerCase());
    if (viewer) {
      const level = getLevel(viewer.points);
      d.prepare(`UPDATE viewers SET level = ? WHERE username = ? COLLATE NOCASE`).run(level.name, username.toLowerCase());
    }

    d.prepare(`INSERT INTO points_log (username, points, reason) VALUES (?, ?, ?)`).run(username.toLowerCase(), points, reason);
  });
  tx();
}

function getViewer(username) {
  return getDB().prepare(`SELECT * FROM viewers WHERE username = ? COLLATE NOCASE`).get(username.toLowerCase());
}

function getLeaderboard(limit = 10) {
  return getDB().prepare(`
    SELECT username, points, total_minutes, sessions, last_seen, level,
      ROW_NUMBER() OVER (ORDER BY points DESC, username ASC) as rank
    FROM viewers WHERE points > 0
    ORDER BY points DESC, username ASC
    LIMIT ?
  `).all(limit);
}

function getViewerRank(username) {
  const r = getDB().prepare(`
    SELECT rank FROM (
      SELECT username, ROW_NUMBER() OVER (ORDER BY points DESC, username ASC) as rank
      FROM viewers WHERE points > 0
    ) WHERE username = ? COLLATE NOCASE
  `).get(username.toLowerCase());
  return r ? r.rank : null;
}

function getGlobalStats() {
  return getDB().prepare(`
    SELECT
      COUNT(*)         as total_viewers,
      SUM(points)      as total_points_distributed,
      SUM(total_minutes) as total_minutes_watched,
      AVG(points)      as avg_points,
      MAX(points)      as max_points,
      (SELECT username FROM viewers ORDER BY points DESC LIMIT 1) as top_viewer
    FROM viewers WHERE points > 0
  `).get();
}

function getRecentLogs(limit = 50) {
  return getDB().prepare(`
    SELECT username, points, reason, created_at FROM points_log
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function getActiveViewers(minutes = 120) {
  return getDB().prepare(`
    SELECT username FROM viewers
    WHERE last_seen >= datetime('now', ?)
    ORDER BY last_seen DESC
  `).all(`-${minutes} minutes`);
}

function clearAllPoints() {
  const d = getDB();
  d.prepare(`UPDATE viewers SET points = 0, total_minutes = 0, level = 'Bronze'`).run();
  d.prepare(`DELETE FROM points_log`).run();
}

// ─── Commandes personnalisées ─────────────────────────────────────────────────

function getCustomCommands() {
  return getDB().prepare(`SELECT * FROM custom_commands ORDER BY trigger ASC`).all();
}

function getCustomCommand(trigger) {
  return getDB().prepare(`SELECT * FROM custom_commands WHERE trigger = ? COLLATE NOCASE AND enabled = 1`).get(trigger.toLowerCase());
}

function setCustomCommand(trigger, response) {
  getDB().prepare(`
    INSERT INTO custom_commands (trigger, response) VALUES (?, ?)
    ON CONFLICT(trigger) DO UPDATE SET response = excluded.response
  `).run(trigger.toLowerCase(), response);
}

function deleteCustomCommand(trigger) {
  getDB().prepare(`DELETE FROM custom_commands WHERE trigger = ? COLLATE NOCASE`).run(trigger.toLowerCase());
}

function toggleCustomCommand(trigger, enabled) {
  getDB().prepare(`UPDATE custom_commands SET enabled = ? WHERE trigger = ? COLLATE NOCASE`).run(enabled ? 1 : 0, trigger.toLowerCase());
}

// ─── Objectifs ────────────────────────────────────────────────────────────────

function getObjectives() {
  return getDB().prepare(`SELECT * FROM objectives ORDER BY active DESC, created_at DESC`).all();
}

function createObjective(title, description, target, reward) {
  return getDB().prepare(`
    INSERT INTO objectives (title, description, target, reward) VALUES (?, ?, ?, ?)
  `).run(title, description, target, reward).lastInsertRowid;
}

function updateObjective(id, data) {
  getDB().prepare(`
    UPDATE objectives SET title=?, description=?, target=?, reward=?, active=? WHERE id=?
  `).run(data.title, data.description, data.target, data.reward, data.active, id);
}

function deleteObjective(id) {
  getDB().prepare(`DELETE FROM objectives WHERE id=?`).run(id);
}

function achieveObjective(id) {
  getDB().prepare(`UPDATE objectives SET achieved=1, active=0 WHERE id=?`).run(id);
}

// ─── Sessions de stream ───────────────────────────────────────────────────────

function startSession() {
  return getDB().prepare(`INSERT INTO stream_sessions (started_at) VALUES (datetime('now'))`).run().lastInsertRowid;
}

function endSession(id, peakViewers, durationMin) {
  getDB().prepare(`
    UPDATE stream_sessions SET ended_at=datetime('now'), peak_viewers=?, duration_min=? WHERE id=?
  `).run(peakViewers, durationMin, id);
}

function getStreamHistory(limit = 10) {
  return getDB().prepare(`
    SELECT * FROM stream_sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?
  `).all(limit);
}

// ─── Duels ───────────────────────────────────────────────────────────────────

function createDuel(challenger, opponent, amount) {
  return getDB().prepare(`
    INSERT INTO duels (challenger, opponent, amount) VALUES (?, ?, ?)
  `).run(challenger.toLowerCase(), opponent.toLowerCase(), amount).lastInsertRowid;
}

function getPendingDuel(opponent) {
  return getDB().prepare(`
    SELECT * FROM duels WHERE opponent = ? COLLATE NOCASE AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(opponent.toLowerCase());
}

function resolveDuel(id, winner) {
  getDB().prepare(`UPDATE duels SET status='resolved', winner=? WHERE id=?`).run(winner, id);
}

function cancelDuel(id) {
  getDB().prepare(`UPDATE duels SET status='cancelled' WHERE id=?`).run(id);
}

function getRecentDuels(limit = 10) {
  return getDB().prepare(`SELECT * FROM duels ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// ─── Giveaways ────────────────────────────────────────────────────────────────

function createGiveaway(title, prize, cost = 0) {
  return getDB().prepare(`
    INSERT INTO giveaways (title, prize, cost) VALUES (?, ?, ?)
  `).run(title, prize, cost).lastInsertRowid;
}

function getActiveGiveaway() {
  return getDB().prepare(`SELECT * FROM giveaways WHERE status='open' ORDER BY created_at DESC LIMIT 1`).get();
}

function joinGiveaway(id, username) {
  const g = getDB().prepare(`SELECT entries FROM giveaways WHERE id=?`).get(id);
  if (!g) return false;
  const entries = JSON.parse(g.entries);
  if (entries.includes(username.toLowerCase())) return false;
  entries.push(username.toLowerCase());
  getDB().prepare(`UPDATE giveaways SET entries=? WHERE id=?`).run(JSON.stringify(entries), id);
  return true;
}

function closeGiveaway(id) {
  const g = getDB().prepare(`SELECT * FROM giveaways WHERE id=?`).get(id);
  if (!g) return null;
  const entries = JSON.parse(g.entries);
  if (!entries.length) return null;
  const winner = entries[Math.floor(Math.random() * entries.length)];
  getDB().prepare(`UPDATE giveaways SET status='closed', winner=?, ended_at=datetime('now') WHERE id=?`).run(winner, id);
  return winner;
}

function getGiveawayHistory(limit = 10) {
  return getDB().prepare(`SELECT * FROM giveaways WHERE status='closed' ORDER BY ended_at DESC LIMIT ?`).all(limit);
}

module.exports = {
  getDB, upsertViewer, addPoints, getViewer, getLeaderboard, getViewerRank,
  getGlobalStats, getRecentLogs, getActiveViewers, clearAllPoints,
  getLevel, getNextLevel, LEVELS,
  getCustomCommands, getCustomCommand, setCustomCommand, deleteCustomCommand, toggleCustomCommand,
  getObjectives, createObjective, updateObjective, deleteObjective, achieveObjective,
  startSession, endSession, getStreamHistory,
  createDuel, getPendingDuel, resolveDuel, cancelDuel, getRecentDuels,
  createGiveaway, getActiveGiveaway, joinGiveaway, closeGiveaway, getGiveawayHistory,
};

// ─── Lobby ────────────────────────────────────────────────────────────────────

function getLobby() {
  try {
    getDB().prepare(`CREATE TABLE IF NOT EXISTS lobby (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      joined_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  } catch(e) {}
  return getDB().prepare(`SELECT * FROM lobby ORDER BY joined_at ASC`).all();
}

function joinLobby(username) {
  try {
    getDB().prepare(`CREATE TABLE IF NOT EXISTS lobby (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  } catch(e) {}
  try {
    getDB().prepare(`INSERT INTO lobby (username) VALUES (?)`).run(username.toLowerCase());
    return true;
  } catch(e) { return false; } // déjà inscrit
}

function removeFromLobby(username) {
  try {
    getDB().prepare(`DELETE FROM lobby WHERE username = ? COLLATE NOCASE`).run(username.toLowerCase());
  } catch(e) {}
}

function clearLobby() {
  try { getDB().prepare(`DELETE FROM lobby`).run(); } catch(e) {}
}

module.exports = Object.assign(module.exports, {
  getLobby, joinLobby, removeFromLobby, clearLobby
});
