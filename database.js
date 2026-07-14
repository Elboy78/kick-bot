/**
 * database.js — Base de données Turso (libSQL)
 * Persiste entre les redéploiements Render
 */

let createClient = null;
let client = null;

function getTenantStreamerId() {
  try {
    const tenant = require('./tenant');
    const id = tenant.getCurrentStreamerId && tenant.getCurrentStreamerId();
    return id ? Number(id) : null;
  } catch(e) { return null; }
}
function scopedStreamerId() { return getTenantStreamerId() || 1; }


function getDB() {
  if (!client) {
    if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
      if (!createClient) ({ createClient } = require('@libsql/client'));
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
     // console.log('[DB] SQLite local (fallback) ✓');
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
    return await db.execute({ sql, args: params });
  } else {
    // SQLite
    return db.prepare(sql).run(...params);
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
    `CREATE TABLE IF NOT EXISTS streamers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT NOT NULL UNIQUE,
      kick_user_id  TEXT,
      kick_username TEXT,
      display_name  TEXT,
      avatar_url    TEXT,
      role          TEXT NOT NULL DEFAULT 'streamer',
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS streamer_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      username    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'admin',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(streamer_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS streamer_settings (
      streamer_id INTEGER NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(streamer_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS overlay_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      widget      TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      UNIQUE(streamer_id, widget)
    )`,
    `CREATE TABLE IF NOT EXISTS viewers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id   INTEGER NOT NULL DEFAULT 1,
      username      TEXT    NOT NULL,
      kick_user_id  TEXT,
      following_since TEXT,
      subscribed_for INTEGER,
      points        INTEGER NOT NULL DEFAULT 0,
      total_minutes INTEGER NOT NULL DEFAULT 0,
      sessions      INTEGER NOT NULL DEFAULT 0,
      level         TEXT    NOT NULL DEFAULT 'Bronze',
      last_seen     TEXT,
      first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(streamer_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS points_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL DEFAULT 1,
      username    TEXT    NOT NULL,
      points      INTEGER NOT NULL,
      reason      TEXT    NOT NULL DEFAULT 'watch_time',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
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
      streamer_id INTEGER NOT NULL DEFAULT 1,
      trigger    TEXT NOT NULL UNIQUE,
      display_trigger TEXT,
      response   TEXT NOT NULL,
      mention_user INTEGER NOT NULL DEFAULT 0,
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
    `CREATE TABLE IF NOT EXISTS allowed_words (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT NOT NULL UNIQUE,
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS vod_moments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      vod_id      TEXT NOT NULL,
      vod_title   TEXT NOT NULL DEFAULT '',
      vod_url     TEXT NOT NULL DEFAULT '',
      timestamp_s INTEGER NOT NULL DEFAULT 0,
      label       TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT 'moment',
      created_by  TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS chest_seasons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      season_num  INTEGER NOT NULL DEFAULT 1,
      fog_meter   INTEGER NOT NULL DEFAULT 0,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT,
      secure_moves_used INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS chests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id   INTEGER NOT NULL,
      number      INTEGER NOT NULL,
      tier        TEXT NOT NULL,
      label       TEXT NOT NULL,
      money       REAL NOT NULL DEFAULT 0,
      fog_value   INTEGER NOT NULL DEFAULT 0,
      twist       TEXT DEFAULT NULL,
      secured     INTEGER NOT NULL DEFAULT 0,
      opened      INTEGER NOT NULL DEFAULT 0,
      opened_at   TEXT,
      opened_via  TEXT,
      result_note TEXT DEFAULT '',
      challenge_done INTEGER DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moderation_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL DEFAULT 'ban',
      username     TEXT NOT NULL DEFAULT '',
      duration     INTEGER DEFAULT NULL,
      reason       TEXT DEFAULT '',
      message      TEXT DEFAULT '',
      done_by      TEXT DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS command_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL DEFAULT 1,
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
      display_trigger TEXT,
      streamer_id INTEGER NOT NULL DEFAULT 1,
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

  // Migrations : ajout de colonnes sur des tables déjà existantes avant leur introduction.
  // ALTER TABLE ADD COLUMN échoue si la colonne existe déjà — on ignore silencieusement cette erreur précise.
  const migrations = [
    `ALTER TABLE stream_sessions ADD COLUMN avg_viewers INTEGER DEFAULT 0`,
    `ALTER TABLE stream_sessions ADD COLUMN viewer_sum INTEGER DEFAULT 0`,
    `ALTER TABLE stream_sessions ADD COLUMN viewer_samples INTEGER DEFAULT 0`,
    `ALTER TABLE vod_moments ADD COLUMN created_by TEXT DEFAULT ''`,
    `ALTER TABLE viewers ADD COLUMN following_since TEXT`,
    `ALTER TABLE viewers ADD COLUMN subscribed_for INTEGER`,
    `ALTER TABLE chest_seasons ADD COLUMN ever_secured INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE chest_seasons ADD COLUMN victory_pending INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE chest_seasons ADD COLUMN protected_number INTEGER DEFAULT NULL`,
    `ALTER TABLE custom_commands ADD COLUMN mention_user INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE viewers ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE points_log ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE stream_sessions ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE command_usage ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE chat_activity_daily ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE custom_commands ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE custom_commands ADD COLUMN display_trigger TEXT`,
    `ALTER TABLE system_commands_state ADD COLUMN streamer_id INTEGER`,
    `ALTER TABLE system_commands_state ADD COLUMN display_trigger TEXT`,
    `ALTER TABLE streamers ADD COLUMN channel_id TEXT`,
    `ALTER TABLE streamers ADD COLUMN chatroom_id TEXT`,
    `ALTER TABLE streamers ADD COLUMN broadcaster_user_id TEXT`,
    `ALTER TABLE streamers ADD COLUMN bot_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE streamers ADD COLUMN last_bot_sync_at TEXT`,
  ];
  for (const sql of migrations) {
    try {
      await run(sql);
      console.log('[DB] Migration appliquée:', sql.slice(0, 60));
    } catch(e) {
      // "duplicate column name" = déjà migré, c'est le cas normal après la 1ère fois
      if (!e.message?.includes('duplicate column')) {
        console.error('[DB] Erreur migration:', e.message);
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
  const rows = await all(`SELECT * FROM level_config ORDER BY min_points ASC, sort_order ASC`);
  return rows.map(r => ({ id: r.id, name: r.name, min: parseInt(r.min_points) || 0, emoji: r.emoji }));
}

function normalizePointsValue(points) {
  const n = parseInt(points || 0, 10);
  return Number.isFinite(n) ? n : 0;
}

async function getRankingEngine() {
  const levels = await getLevels();
  const sortedAsc = [...levels].sort((a, b) => (a.min - b.min) || String(a.name).localeCompare(String(b.name)));
  function calculate(points) {
    const value = normalizePointsValue(points);
    let current = sortedAsc[0] || { name: 'Bronze', min: 0, emoji: '🥉' };
    let next = null;
    for (const level of sortedAsc) {
      if (value >= normalizePointsValue(level.min)) current = level;
      else { next = level; break; }
    }
    const currentMin = normalizePointsValue(current.min);
    const nextMin = next ? normalizePointsValue(next.min) : currentMin;
    const span = Math.max(1, nextMin - currentMin);
    const progress = next ? Math.max(0, Math.min(100, Math.round(((value - currentMin) / span) * 100))) : 100;
    return { ...current, nextLevel: next, progress };
  }
  function apply(viewer) {
    if (!viewer) return viewer;
    const calculated = calculate(viewer.points);
    return {
      ...viewer,
      level: calculated.name,
      level_emoji: calculated.emoji,
      level_min: calculated.min,
      next_level: calculated.nextLevel?.name || null,
      next_level_min: calculated.nextLevel?.min ?? null,
      level_progress: calculated.progress
    };
  }
  return { levels: sortedAsc, calculate, apply };
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
  const engine = await getRankingEngine();
  return engine.calculate(points);
}

async function getNextLevel(points) {
  const engine = await getRankingEngine();
  return engine.calculate(points).nextLevel || null;
}

// ─── Viewers ──────────────────────────────────────────────────────────────────

async function upsertViewer(username, kickUserId = null) {
  const sid = scopedStreamerId();
  const lower = String(username || '').toLowerCase();
  if (!lower) return;
  const existing = await get(`SELECT id FROM viewers WHERE username = ? AND COALESCE(streamer_id, 1) = ?`, [lower, sid]);
  if (existing) {
    await run(`UPDATE viewers SET last_seen = datetime('now'), kick_user_id = COALESCE(?, kick_user_id), streamer_id = ? WHERE id = ?`, [kickUserId, sid, existing.id]);
  } else {
    await run(`INSERT INTO viewers (username, kick_user_id, last_seen, streamer_id) VALUES (?, ?, datetime('now'), ?)`, [lower, kickUserId, sid]);
  }
}

async function addPoints(username, points, reason = 'watch_time', minutesWatched = 0) {
  const sid = scopedStreamerId();
  const lower = String(username || '').toLowerCase();
  if (!lower) return;
  await upsertViewer(lower);
  await run(`
    UPDATE viewers
    SET points        = MAX(0, points + ?),
        total_minutes = total_minutes + ?,
        last_seen     = datetime('now')
    WHERE username = ? AND COALESCE(streamer_id, 1) = ?
  `, [points, minutesWatched, lower, sid]);

  const viewer = await get(`SELECT points FROM viewers WHERE username = ? AND COALESCE(streamer_id, 1) = ?`, [lower, sid]);
  if (viewer) {
    const level = await getLevel(viewer.points);
    await run(`UPDATE viewers SET level = ? WHERE username = ? AND COALESCE(streamer_id, 1) = ?`, [level.name, lower, sid]);
  }

  await run(`INSERT INTO points_log (username, points, reason, streamer_id) VALUES (?, ?, ?, ?)`,
    [lower, points, reason, sid]);
}

async function getViewer(username) {
  const viewer = await get(`SELECT * FROM viewers WHERE username = ? AND COALESCE(streamer_id, 1) = ?`, [String(username || '').toLowerCase(), scopedStreamerId()]);
  const engine = await getRankingEngine();
  return engine.apply(viewer);
}

async function getLeaderboard(limit = 10) {
  const rows = await all(`
    SELECT username, points, total_minutes, sessions, last_seen, level
    FROM viewers
    WHERE COALESCE(streamer_id, 1) = ?
    ORDER BY points DESC, last_seen DESC
    LIMIT ?
  `, [scopedStreamerId(), limit]);
  const engine = await getRankingEngine();
  return rows.map((v, i) => ({ ...engine.apply(v), rank: i + 1 }));
}

async function getViewerRank(username) {
  const all_viewers = await all(`SELECT username FROM viewers WHERE COALESCE(streamer_id, 1) = ? ORDER BY points DESC, last_seen DESC`, [scopedStreamerId()]);
  const idx = all_viewers.findIndex(v => v.username === String(username || '').toLowerCase());
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
      (SELECT username FROM viewers WHERE COALESCE(streamer_id, 1) = scoped.sid ORDER BY points DESC LIMIT 1) as top_viewer
    FROM viewers, (SELECT ? AS sid) scoped
    WHERE COALESCE(streamer_id, 1) = scoped.sid
  `, [scopedStreamerId()]);
}

async function getRecentLogs(limit = 50) {
  return all(`SELECT username, points, reason, created_at FROM points_log WHERE COALESCE(streamer_id, 1) = ? ORDER BY created_at DESC LIMIT ?`, [scopedStreamerId(), limit]);
}

async function getActiveViewers(minutes = 120) {
  return all(`SELECT username FROM viewers WHERE COALESCE(streamer_id, 1) = ? AND last_seen >= datetime('now', ?) ORDER BY last_seen DESC`, [scopedStreamerId(), `-${minutes} minutes`]);
}

async function clearAllPoints() {
  await run(`UPDATE viewers SET points = 0, total_minutes = 0, level = 'Bronze' WHERE COALESCE(streamer_id, 1) = ?`, [scopedStreamerId()]);
  await run(`DELETE FROM points_log WHERE COALESCE(streamer_id, 1) = ?`, [scopedStreamerId()]);
}

// ─── Commandes ────────────────────────────────────────────────────────────────


async function getCustomCommand(trigger) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').trim().toLowerCase();
  const storageTrigger = `${sid}:${raw}`;

  return get(
    `SELECT *
     FROM custom_commands
     WHERE COALESCE(streamer_id, 1) = ?
       AND enabled = 1
       AND (
         trigger = ?
         OR trigger = ?
         OR display_trigger = ?
       )
     ORDER BY
       CASE WHEN trigger = ? THEN 0 ELSE 1 END,
       id DESC
     LIMIT 1`,
    [sid, raw, storageTrigger, raw, storageTrigger]
  );
}
async function getCustomCommand(trigger) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').toLowerCase();
  return get(`SELECT * FROM custom_commands WHERE COALESCE(streamer_id, 1) = ? AND (trigger = ? OR display_trigger = ?) AND enabled = 1`, [sid, raw, raw]);
}

async function setCustomCommand(trigger, response, mentionUser = 0) {
  const sid = scopedStreamerId();
  const displayTrigger = String(trigger || '').trim().toLowerCase();
  const storageTrigger = `${sid}:${displayTrigger}`;

  if (!displayTrigger) {
    throw new Error('Commande vide');
  }

  // Recherche aussi bien les anciennes commandes (!topw)
  // que le nouveau format multi-streamer (1:!topw).
  const existing = await get(
    `SELECT id
     FROM custom_commands
     WHERE COALESCE(streamer_id, 1) = ?
       AND (
         trigger = ?
         OR trigger = ?
         OR display_trigger = ?
       )
     ORDER BY
       CASE WHEN display_trigger = ? THEN 0 ELSE 1 END,
       id ASC
     LIMIT 1`,
    [sid, displayTrigger, storageTrigger, displayTrigger, displayTrigger]
  );

  if (existing?.id) {
    await run(
      `UPDATE custom_commands
       SET trigger = ?,
           display_trigger = ?,
           response = ?,
           mention_user = ?,
           streamer_id = ?
       WHERE id = ?`,
      [
        storageTrigger,
        displayTrigger,
        response,
        mentionUser ? 1 : 0,
        sid,
        existing.id,
      ]
    );

    // Supprime d’éventuels doublons historiques pour cette commande.
    await run(
      `DELETE FROM custom_commands
       WHERE COALESCE(streamer_id, 1) = ?
         AND id <> ?
         AND (
           trigger = ?
           OR trigger = ?
           OR display_trigger = ?
         )`,
      [sid, existing.id, displayTrigger, storageTrigger, displayTrigger]
    );

    return;
  }

  await run(
    `INSERT INTO custom_commands
      (trigger, display_trigger, response, mention_user, streamer_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      storageTrigger,
      displayTrigger,
      response,
      mentionUser ? 1 : 0,
      sid,
    ]
  );
}

async function deleteCustomCommand(trigger) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').toLowerCase();
  await run(`DELETE FROM custom_commands WHERE COALESCE(streamer_id, 1) = ? AND (trigger = ? OR display_trigger = ?)`, [sid, `${sid}:${raw}`, raw]);
}

async function toggleCustomCommand(trigger, enabled) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').toLowerCase();
  await run(`UPDATE custom_commands SET enabled = ? WHERE COALESCE(streamer_id, 1) = ? AND (trigger = ? OR display_trigger = ?)`, [enabled ? 1 : 0, sid, `${sid}:${raw}`, raw]);
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
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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

// ─── VOD Moments (moments marqués sur les replays Kick) ───────────────────────

async function getVodMoments(vodId) {
  if (vodId) return all(`SELECT * FROM vod_moments WHERE vod_id = ? ORDER BY timestamp_s ASC`, [vodId]);
  return all(`SELECT * FROM vod_moments ORDER BY created_at DESC`);
}
async function addVodMoment(vodId, vodTitle, vodUrl, timestampS, label, category, createdBy) {
  const r = await run(`INSERT INTO vod_moments (vod_id, vod_title, vod_url, timestamp_s, label, category, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [vodId, vodTitle || '', vodUrl || '', timestampS || 0, label || '', category || 'moment', createdBy || '']);
  return r;
}
async function deleteVodMoment(id) { await run(`DELETE FROM vod_moments WHERE id = ?`, [id]); }
async function updateVodMomentLabel(id, label, category) {
  await run(`UPDATE vod_moments SET label = ?, category = ? WHERE id = ?`, [label, category, id]);
}

// Lie rétroactivement les clips créés pendant un live (vod_id='live', sans URL)
// au vrai VOD une fois le replay disponible sur Kick après la fin du stream.
async function getPendingLiveMoments() {
  return all(`SELECT * FROM vod_moments WHERE vod_id = 'live'`);
}
async function linkMomentToVod(id, vodId, vodUrl) {
  await run(`UPDATE vod_moments SET vod_id = ?, vod_url = ? WHERE id = ?`, [vodId, vodUrl, id]);
}

// ─── Analytics : usage des commandes & activité du chat ────────────────────────

// ─── Les 30 Coffres de l'Entité ──────────────────────────────────────────────

async function getActiveChestSeason() {
  return get(`SELECT * FROM chest_seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`);
}
async function createChestSeason(chestList) {
  const last = await get(`SELECT MAX(season_num) as n FROM chest_seasons`);
  const num = (last?.n || 0) + 1;
  // Clore toute saison encore ouverte
  await run(`UPDATE chest_seasons SET ended_at = datetime('now') WHERE ended_at IS NULL`);
  const r = await run(`INSERT INTO chest_seasons (season_num) VALUES (?)`, [num]);
  const seasonId = Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
  for (const c of chestList) {
    await run(`INSERT INTO chests (season_id, number, tier, label, money, fog_value, twist) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [seasonId, c.number, c.tier, c.label, c.money || 0, c.fogValue || 0, c.twist || null]);
  }
  return { seasonId, seasonNum: num };
}
async function getChests(seasonId) {
  return all(`SELECT * FROM chests WHERE season_id = ? ORDER BY number ASC`, [seasonId]);
}
async function getChest(seasonId, number) {
  return get(`SELECT * FROM chests WHERE season_id = ? AND number = ?`, [seasonId, number]);
}
async function markChestOpened(id, via, resultNote) {
  await run(`UPDATE chests SET opened = 1, opened_at = datetime('now'), opened_via = ?, result_note = ? WHERE id = ?`, [via, resultNote || '', id]);
}
async function updateChestContent(id, tier, label, money, fogValue) {
  await run(`UPDATE chests SET tier = ?, label = ?, money = ?, fog_value = ? WHERE id = ?`, [tier, label, money, fogValue, id]);
}
async function setChestTwist(id, twist) {
  await run(`UPDATE chests SET twist = ? WHERE id = ?`, [twist, id]);
}
async function setChestSecured(seasonId, number, secured) {
  await run(`UPDATE chests SET secured = ? WHERE season_id = ? AND number = ?`, [secured ? 1 : 0, seasonId, number]);
}
async function clearAllSecured(seasonId) {
  await run(`UPDATE chests SET secured = 0 WHERE season_id = ?`, [seasonId]);
}
async function incrementSecureMoves(seasonId) {
  await run(`UPDATE chest_seasons SET secure_moves_used = secure_moves_used + 1 WHERE id = ?`, [seasonId]);
}
async function markEverSecured(seasonId) {
  await run(`UPDATE chest_seasons SET ever_secured = 1 WHERE id = ?`, [seasonId]);
}
async function setProtectedNumber(seasonId, number) {
  await run(`UPDATE chest_seasons SET protected_number = ? WHERE id = ?`, [number, seasonId]);
}
async function setVictoryPending(seasonId, val) {
  await run(`UPDATE chest_seasons SET victory_pending = ? WHERE id = ?`, [val ? 1 : 0, seasonId]);
}
async function updateFogMeter(seasonId, delta) {
  await run(`UPDATE chest_seasons SET fog_meter = fog_meter + ? WHERE id = ?`, [delta, seasonId]);
}
async function setChestChallengeDone(id, done) {
  await run(`UPDATE chests SET challenge_done = ? WHERE id = ?`, [done ? 1 : 0, id]);
}
async function endChestSeason(seasonId) {
  await run(`UPDATE chest_seasons SET ended_at = datetime('now') WHERE id = ?`, [seasonId]);
}

// ─── Logs de modération ───────────────────────────────────────────────────────

async function addModerationLog(type, username, duration, reason, message, doneBy) {
  await run(`INSERT INTO moderation_logs (type, username, duration, reason, message, done_by)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [type, (username||'').toLowerCase(), duration||null, reason||'', message||'', doneBy||'']);
}

async function getModerationLogs(limit = 100) {
  return all(`SELECT * FROM moderation_logs ORDER BY created_at DESC LIMIT ?`, [limit]);
}

async function clearModerationLogs() {
  await run(`DELETE FROM moderation_logs`);
}

async function logCommandUsage(trigger, username) {
  const sid = scopedStreamerId();
  await run(
    `INSERT INTO command_usage (trigger, username, streamer_id) VALUES (?, ?, ?)`,
    [String(trigger || '').toLowerCase(), (username || '').toLowerCase(), sid]
  );
}

async function getCommandUsageStats(days = 7) {
  const sid = scopedStreamerId();
  const rows = await all(
    `SELECT trigger, COUNT(*) as count FROM command_usage
     WHERE COALESCE(streamer_id, 1) = ? AND created_at >= datetime('now', ?)
     GROUP BY trigger ORDER BY count DESC LIMIT 10`,
    [sid, `-${days} days`]
  );
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map(r => ({ trigger: r.trigger, count: r.count, pct: total > 0 ? Math.round((r.count / total) * 100) : 0 }));
}

async function logChatActivity(username) {
  const today = todayParis();
  const lower = username.toLowerCase();

  try {
    // Upsert atomique : élimine la race condition entre deux messages simultanés
    // qui tentaient chacun un SELECT puis un INSERT séparé (cause du crash UNIQUE constraint).
    await run(`
      INSERT INTO chat_activity_daily (date, message_count, unique_chatters)
      VALUES (?, 1, ?)
      ON CONFLICT(date) DO UPDATE SET message_count = message_count + 1
    `, [today, JSON.stringify([lower])]);

    // La liste des chatteurs uniques nécessite de lire puis fusionner — pas atomique
    // par nature (JSON), donc on accepte un risque résiduel minime ici, mais sans
    // jamais pouvoir provoquer un crash : on entoure de try/catch.
    const row = await get(`SELECT unique_chatters FROM chat_activity_daily WHERE date = ?`, [today]);
    if (row) {
      let chatters = [];
      try { chatters = JSON.parse(row.unique_chatters); } catch(e) {}
      if (!chatters.includes(lower)) {
        chatters.push(lower);
        await run(`UPDATE chat_activity_daily SET unique_chatters = ? WHERE date = ?`,
          [JSON.stringify(chatters), today]);
      }
    }
  } catch(e) {
    // Ne jamais laisser une erreur de logging d'activité chat faire planter le bot
    console.error('[CHAT ACTIVITY] Erreur non bloquante:', e.message);
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

// Classement fidélité (temps regardé cumulé, pas points)
async function getFidelityLeaderboard(limit = 50) {
  const rows = await all(`
    SELECT username, total_minutes, sessions, points, level, first_seen, last_seen
    FROM viewers
    WHERE COALESCE(streamer_id, 1) = ? AND total_minutes > 0
    ORDER BY total_minutes DESC, sessions DESC
    LIMIT ?
  `, [scopedStreamerId(), limit]);
  const engine = await getRankingEngine();
  return rows.map((v, i) => ({ ...engine.apply(v), rank: i + 1 }));
}

// Heatmap : activité par heure et jour de la semaine (7 derniers jours)
async function getChatHeatmap() {
  // Reconstruit depuis chat_activity_daily — on agrège par jour de semaine
  const rows = await all(`SELECT date, message_count FROM chat_activity_daily WHERE date >= date('now', '-28 days') ORDER BY date ASC`);
  const heatmap = {};
  rows.forEach(r => {
    const d = new Date(r.date + 'T12:00:00Z'); // midi UTC évite les décalages de jour
    const dow = d.getUTCDay(); // 0=dim, 1=lun...
    if (!heatmap[dow]) heatmap[dow] = { total: 0, count: 0 };
    heatmap[dow].total += r.message_count;
    heatmap[dow].count += 1;
  });
  return heatmap; // { 0: { total, count }, 1: ... }
}

// Followage : date du premier message (proxy pour depuis quand il est là)
async function getViewerFirstSeen(username) {
  const row = await get(`SELECT first_seen, total_minutes, sessions, following_since, subscribed_for FROM viewers WHERE username = ? AND COALESCE(streamer_id, 1) = ?`, [String(username || '').toLowerCase(), scopedStreamerId()]);
  return row || null;
}

async function setViewerFollowingSince(username, followingSince, subscribedFor) {
  if (subscribedFor !== undefined) {
    await run(`UPDATE viewers SET following_since = ?, subscribed_for = ? WHERE username = ?`,
      [followingSince, subscribedFor, username.toLowerCase()]);
  } else {
    await run(`UPDATE viewers SET following_since = ? WHERE username = ?`, [followingSince, username.toLowerCase()]);
  }
}



async function createDuel(challenger, opponent, amount) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO duels (challenger, opponent, amount) VALUES (?, ?, ?)`, args: [challenger.toLowerCase(), opponent.toLowerCase(), amount] });
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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
  'clip_enabled':       { label: 'Commande !clip', desc: 'Permet aux viewers de marquer un moment avec !clip [description]', category: 'Chat' },
  'tts_enabled':        { label: 'TTS Donations', desc: 'Lit les messages de dons à voix haute sur l overlay', category: 'TTS' },
  'chest_chat_enabled': { label: 'Messages coffres dans le chat', desc: 'Annonce les ouvertures de coffres dans le chat Kick', category: 'Coffres' },
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

async function getSettingStr(key, defaultVal = '') {
  const r = await get(`SELECT value FROM bot_settings WHERE key = ?`, [key]);
  return r ? r.value : defaultVal;
}

async function setSettingStr(key, value) {
  await run(`INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [key, value, value]);
}

// ─── System Commands ──────────────────────────────────────────────────────────

async function initSystemCommandsState(commands) {
  const sid = scopedStreamerId();
  for (const cmd of commands) {
    const display = String(cmd || '').toLowerCase();
    const storage = `${sid}:${display}`;
    try {
      await run(
        `INSERT OR IGNORE INTO system_commands_state (trigger, display_trigger, streamer_id, enabled) VALUES (?, ?, ?, 1)`,
        [storage, display, sid]
      );
    } catch(e) {
      // Ancienne base sans colonnes V2 : fallback non bloquant.
      try { await run(`INSERT OR IGNORE INTO system_commands_state (trigger, enabled) VALUES (?, 1)`, [storage]); } catch(_) {}
    }
  }
}

async function isSystemCmdEnabled(trigger) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').toLowerCase();
  const storage = `${sid}:${raw}`;
  let r = null;
  try {
    r = await get(
      `SELECT enabled FROM system_commands_state WHERE COALESCE(streamer_id, 1) = ? AND (trigger = ? OR display_trigger = ?)`,
      [sid, storage, raw]
    );
  } catch(e) {
    r = await get(`SELECT enabled FROM system_commands_state WHERE trigger = ?`, [storage]).catch(() => null);
  }
  return r ? r.enabled === 1 : true;
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

async function getQuotes() { return all(`SELECT * FROM quotes ORDER BY created_at DESC`); }
async function addQuote(text, author, addedBy) {
  const db = getDB();
  if (db.execute) {
    const r = await db.execute({ sql: `INSERT INTO quotes (text, author, added_by) VALUES (?, ?, ?)`, args: [text, author || '', addedBy || ''] });
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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
    return Number(r?.lastInsertRowid ?? r?.lastInsertRowID ?? r?.lastInsertId);
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

async function deleteBannedWordByText(word) {
  const result = await run(`DELETE FROM banned_words WHERE word = ?`, [word.toLowerCase()]);
  return result; // utile pour vérifier si une ligne a bien été supprimée
}

async function getBannedWordByText(word) {
  return get(`SELECT * FROM banned_words WHERE word = ?`, [word.toLowerCase()]);
}

async function toggleBannedWord(id, enabled) {
  await run(`UPDATE banned_words SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
}

async function checkBannedWords(message) {
  const words = await all(`SELECT * FROM banned_words WHERE enabled = 1`);
  const lower = message.toLowerCase();

  // Liste blanche — protégé contre l'absence de la table (migration pas encore appliquée)
  try {
    const allowed = await all(`SELECT word FROM allowed_words`);
    if (allowed.some(a => lower.includes(a.word.toLowerCase()))) return null;
  } catch(e) { /* table pas encore créée — on ignore */ }

  for (const w of words) {
    if (lower.includes(w.word.toLowerCase())) return w;
  }
  return null;
}

async function getAllowedWords() {
  return all(`SELECT * FROM allowed_words ORDER BY created_at DESC`);
}
async function addAllowedWord(word, note) {
  try {
    await run(`INSERT INTO allowed_words (word, note) VALUES (?, ?) ON CONFLICT(word) DO UPDATE SET note = ?`,
      [word.toLowerCase(), note || '', note || '']);
    return true;
  } catch(e) { return false; }
}
async function deleteAllowedWord(id) {
  await run(`DELETE FROM allowed_words WHERE id = ?`, [id]);
}
async function deleteAllowedWordByText(word) {
  await run(`DELETE FROM allowed_words WHERE word = ?`, [word.toLowerCase()]);
}
async function getAllowedWordByText(word) {
  return get(`SELECT * FROM allowed_words WHERE word = ?`, [word.toLowerCase()]);
}

async function getAllSystemCommandsState() {
  const sid = scopedStreamerId();
  try {
    const rows = await all(
      `SELECT *, COALESCE(display_trigger, trigger) as trigger FROM system_commands_state
       WHERE COALESCE(streamer_id, 1) = ?
       ORDER BY COALESCE(display_trigger, trigger) ASC`,
      [sid]
    );
    return rows.map(r => ({ ...r, trigger: String(r.display_trigger || r.trigger || '').replace(new RegExp(`^${sid}:`), '') }));
  } catch(e) {
    const rows = await all(`SELECT * FROM system_commands_state ORDER BY trigger ASC`);
    return rows.map(r => ({ ...r, trigger: String(r.trigger || '').replace(new RegExp(`^${sid}:`), '') }));
  }
}

async function toggleSystemCommand(trigger, enabled) {
  const sid = scopedStreamerId();
  const raw = String(trigger || '').toLowerCase();
  const storage = `${sid}:${raw}`;
  try {
    await run(
      `INSERT INTO system_commands_state (trigger, display_trigger, streamer_id, enabled) VALUES (?, ?, ?, ?)
       ON CONFLICT(trigger) DO UPDATE SET enabled = ?, display_trigger = ?, streamer_id = ?`,
      [storage, raw, sid, enabled ? 1 : 0, enabled ? 1 : 0, raw, sid]
    );
  } catch(e) {
    await run(`INSERT OR REPLACE INTO system_commands_state (trigger, enabled) VALUES (?, ?)`, [storage, enabled ? 1 : 0]);
  }
}


// ─── V2 Multi-streamer ───────────────────────────────────────────────────────

function normalizeStreamerSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'main';
}

async function ensureDefaultStreamer(seed = {}) {
  const slug = normalizeStreamerSlug(seed.slug || process.env.DEFAULT_STREAMER_SLUG || process.env.KICK_CHANNEL || 'main');
  const existing = await get(`SELECT * FROM streamers WHERE slug = ?`, [slug]);
  if (existing) return existing;
  await run(
    `INSERT INTO streamers (slug, kick_username, display_name, role, status) VALUES (?, ?, ?, ?, 'active')`,
    [slug, seed.kickUsername || process.env.KICK_CHANNEL || slug, seed.displayName || process.env.PANEL_OWNER || slug, seed.role || 'owner']
  );
  return get(`SELECT * FROM streamers WHERE slug = ?`, [slug]);
}

async function getStreamerBySlug(slug) {
  return get(`SELECT * FROM streamers WHERE slug = ?`, [normalizeStreamerSlug(slug)]);
}

async function getStreamerById(id) {
  return get(`SELECT * FROM streamers WHERE id = ?`, [id]);
}

async function listStreamers() {
  return all(`SELECT * FROM streamers ORDER BY created_at ASC`);
}

async function upsertStreamer(data = {}) {
  const slug = normalizeStreamerSlug(data.slug || data.kick_username || data.kickUsername || data.display_name || data.displayName);
  const kickUsername = data.kick_username || data.kickUsername || slug;
  const displayName = data.display_name || data.displayName || kickUsername;
  await run(
    `INSERT INTO streamers (slug, kick_user_id, kick_username, display_name, avatar_url, role, status, channel_id, chatroom_id, broadcaster_user_id, bot_enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET
       kick_user_id = COALESCE(?, kick_user_id),
       kick_username = COALESCE(?, kick_username),
       display_name = COALESCE(?, display_name),
       avatar_url = COALESCE(?, avatar_url),
       role = COALESCE(?, role),
       status = COALESCE(?, status),
       channel_id = COALESCE(?, channel_id),
       chatroom_id = COALESCE(?, chatroom_id),
       broadcaster_user_id = COALESCE(?, broadcaster_user_id),
       bot_enabled = COALESCE(?, bot_enabled),
       updated_at = datetime('now')`,
    [slug, data.kick_user_id || data.kickUserId || null, kickUsername, displayName, data.avatar_url || data.avatarUrl || null, data.role || 'streamer', data.status || 'active',
     data.channel_id || data.channelId || null, data.chatroom_id || data.chatroomId || null, data.broadcaster_user_id || data.broadcasterUserId || null, data.bot_enabled ?? data.botEnabled ?? 1,
     data.kick_user_id || data.kickUserId || null, kickUsername, displayName, data.avatar_url || data.avatarUrl || null, data.role || null, data.status || null,
     data.channel_id || data.channelId || null, data.chatroom_id || data.chatroomId || null, data.broadcaster_user_id || data.broadcasterUserId || null, data.bot_enabled ?? data.botEnabled ?? null]
  );
  return getStreamerBySlug(slug);
}

async function updateStreamerKickMeta(streamerId, meta = {}) {
  const fields = [];
  const params = [];
  const map = {
    channel_id: meta.channel_id ?? meta.channelId,
    chatroom_id: meta.chatroom_id ?? meta.chatroomId,
    broadcaster_user_id: meta.broadcaster_user_id ?? meta.broadcasterUserId,
    kick_user_id: meta.kick_user_id ?? meta.kickUserId,
    kick_username: meta.kick_username ?? meta.kickUsername,
    display_name: meta.display_name ?? meta.displayName,
    avatar_url: meta.avatar_url ?? meta.avatarUrl,
    bot_enabled: meta.bot_enabled ?? meta.botEnabled,
  };
  for (const [k,v] of Object.entries(map)) {
    if (v !== undefined && v !== null && String(v) !== '') { fields.push(`${k} = ?`); params.push(String(v)); }
  }
  if (!fields.length) return getStreamerById(streamerId);
  fields.push(`updated_at = datetime('now')`);
  params.push(streamerId);
  await run(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`, params);
  return getStreamerById(streamerId);
}

async function getActiveStreamersForBot() {
  return all(`SELECT * FROM streamers WHERE status = 'active' AND COALESCE(bot_enabled, 1) = 1 ORDER BY id ASC`);
}

async function getStreamerSetting(streamerId, key, defaultVal = '') {
  const r = await get(`SELECT value FROM streamer_settings WHERE streamer_id = ? AND key = ?`, [streamerId, key]);
  return r ? r.value : defaultVal;
}

async function setStreamerSetting(streamerId, key, value) {
  await run(
    `INSERT INTO streamer_settings (streamer_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(streamer_id, key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    [streamerId, key, String(value ?? ''), String(value ?? '')]
  );
}

function normalizeOverlayWidget(widget) {
  const w = String(widget || '').toLowerCase().replace(/\.html$/,'').replace(/[^a-z0-9_-]/g, '');
  const allowed = new Set(['songrequest','chat','subgoal','alerts']);
  return allowed.has(w) ? w : '';
}
function createOverlayTokenValue() {
  return require('crypto').randomBytes(32).toString('hex');
}
async function getOrCreateOverlayToken(streamerId, widget) {
  const sid = Number(streamerId || scopedStreamerId() || 1);
  const w = normalizeOverlayWidget(widget);
  if (!w) throw new Error('widget overlay invalide');
  let row = await get(`SELECT * FROM overlay_tokens WHERE streamer_id = ? AND widget = ?`, [sid, w]);
  if (row) return row;
  for (let i = 0; i < 5; i++) {
    const token = createOverlayTokenValue();
    try {
      await run(`INSERT INTO overlay_tokens (streamer_id, widget, token, enabled, updated_at) VALUES (?, ?, ?, 1, datetime('now'))`, [sid, w, token]);
      return await get(`SELECT * FROM overlay_tokens WHERE streamer_id = ? AND widget = ?`, [sid, w]);
    } catch(e) {
      if (!String(e.message || '').includes('UNIQUE')) throw e;
    }
  }
  throw new Error('impossible de générer un token overlay unique');
}
async function regenerateOverlayToken(streamerId, widget) {
  const sid = Number(streamerId || scopedStreamerId() || 1);
  const w = normalizeOverlayWidget(widget);
  if (!w) throw new Error('widget overlay invalide');
  const token = createOverlayTokenValue();
  await run(
    `INSERT INTO overlay_tokens (streamer_id, widget, token, enabled, updated_at) VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(streamer_id, widget) DO UPDATE SET token = ?, enabled = 1, updated_at = datetime('now')`,
    [sid, w, token, token]
  );
  return getOrCreateOverlayToken(sid, w);
}
async function getOverlayTokenByValue(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const row = await get(`SELECT ot.*, s.slug, s.display_name FROM overlay_tokens ot JOIN streamers s ON s.id = ot.streamer_id WHERE ot.token = ? AND ot.enabled = 1`, [t]);
  if (row) run(`UPDATE overlay_tokens SET last_used_at = datetime('now') WHERE id = ?`, [row.id]).catch(()=>{});
  return row || null;
}
async function getOverlayTokensForStreamer(streamerId) {
  const sid = Number(streamerId || scopedStreamerId() || 1);
  const widgets = ['songrequest','chat','subgoal','alerts'];
  const out = {};
  for (const w of widgets) out[w] = await getOrCreateOverlayToken(sid, w);
  return out;
}

function oauthProviderForStreamer(streamerId) {
  return streamerId ? `kick:${streamerId}` : 'kick';
}

async function saveOAuthTokenForStreamer(streamerId, accessToken, refreshToken, expiresAt) {
  return saveOAuthToken(oauthProviderForStreamer(streamerId), accessToken, refreshToken, expiresAt);
}

async function getOAuthTokenForStreamer(streamerId) {
  return getOAuthToken(oauthProviderForStreamer(streamerId));
}

async function deleteOAuthTokenForStreamer(streamerId) {
  return deleteOAuthToken(oauthProviderForStreamer(streamerId));
}

// ─── Init ─────────────────────────────────────────────────────────────────────


async function tableCreateSql(table) {
  try {
    const row = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    return String(row?.sql || '');
  } catch(e) { return ''; }
}

async function tableColumns(table) {
  try {
    const rows = await all(`PRAGMA table_info(${table})`);
    return rows.map(r => String(r.name || '').toLowerCase()).filter(Boolean);
  } catch(e) { return []; }
}

async function migrateViewersToScopedUnique(defaultStreamerId = 1) {
  const sql = await tableCreateSql('viewers');
  if (!sql) return;
  const alreadyScoped = /UNIQUE\s*\(\s*streamer_id\s*,\s*username\s*\)/i.test(sql) && !/username\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql);
  if (alreadyScoped) return;

  console.log('[DB V2] Migration viewers: UNIQUE(username) → UNIQUE(streamer_id, username)');
  await run(`DROP TABLE IF EXISTS viewers_v2_migration`);
  await run(`CREATE TABLE viewers_v2_migration (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id     INTEGER NOT NULL DEFAULT 1,
    username        TEXT    NOT NULL,
    kick_user_id    TEXT,
    following_since TEXT,
    subscribed_for  INTEGER,
    points          INTEGER NOT NULL DEFAULT 0,
    total_minutes   INTEGER NOT NULL DEFAULT 0,
    sessions        INTEGER NOT NULL DEFAULT 0,
    level           TEXT    NOT NULL DEFAULT 'Bronze',
    last_seen       TEXT,
    first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(streamer_id, username)
  )`);

  // Copie sécurisée : si une ancienne ligne n'a pas encore streamer_id, on la rattache au streamer par défaut.
  // GROUP BY évite qu'une ancienne migration partielle bloque la recréation sur une paire déjà existante.
  const cols = await tableColumns('viewers');
  const hasStreamerId = cols.includes('streamer_id');
  const sidExpr = hasStreamerId ? 'COALESCE(streamer_id, ?)' : '?';
  await run(`INSERT OR IGNORE INTO viewers_v2_migration
    (id, streamer_id, username, kick_user_id, following_since, subscribed_for, points, total_minutes, sessions, level, last_seen, first_seen, created_at)
    SELECT
      MIN(id) AS id,
      ${sidExpr} AS streamer_id,
      LOWER(username) AS username,
      MAX(kick_user_id) AS kick_user_id,
      MAX(following_since) AS following_since,
      MAX(subscribed_for) AS subscribed_for,
      MAX(points) AS points,
      MAX(total_minutes) AS total_minutes,
      MAX(sessions) AS sessions,
      COALESCE(MAX(level), 'Bronze') AS level,
      MAX(last_seen) AS last_seen,
      COALESCE(MIN(first_seen), datetime('now')) AS first_seen,
      COALESCE(MIN(created_at), datetime('now')) AS created_at
    FROM viewers
    GROUP BY ${sidExpr}, LOWER(username)`, [defaultStreamerId, defaultStreamerId]);

  await run(`DROP TABLE viewers`);
  await run(`ALTER TABLE viewers_v2_migration RENAME TO viewers`);
  await run(`CREATE INDEX IF NOT EXISTS idx_viewers_streamer_points ON viewers(streamer_id, points DESC, last_seen DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_viewers_streamer_last_seen ON viewers(streamer_id, last_seen DESC)`);
}

async function migratePointsLogToScoped(defaultStreamerId = 1) {
  try { await run(`ALTER TABLE points_log ADD COLUMN streamer_id INTEGER`); } catch(e) {}
  try { await run(`UPDATE points_log SET streamer_id = ? WHERE streamer_id IS NULL`, [defaultStreamerId]); } catch(e) {}
  try { await run(`CREATE INDEX IF NOT EXISTS idx_points_log_streamer_created ON points_log(streamer_id, created_at DESC)`); } catch(e) {}
}

async function migrateCoreScopedTables(defaultStreamerId = 1) {
  await migrateViewersToScopedUnique(defaultStreamerId);
  await migratePointsLogToScoped(defaultStreamerId);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_custom_commands_streamer_trigger ON custom_commands(streamer_id, trigger)`); } catch(e) {}
  try { await run(`CREATE INDEX IF NOT EXISTS idx_stream_sessions_streamer_started ON stream_sessions(streamer_id, started_at DESC)`); } catch(e) {}
  try { await run(`CREATE INDEX IF NOT EXISTS idx_command_usage_streamer_created ON command_usage(streamer_id, created_at DESC)`); } catch(e) {}
  try { await run(`CREATE INDEX IF NOT EXISTS idx_system_commands_streamer_trigger ON system_commands_state(streamer_id, trigger)`); } catch(e) {}
  try { await run(`CREATE INDEX IF NOT EXISTS idx_chat_activity_streamer_day ON chat_activity_daily(streamer_id, day)`); } catch(e) {}
}

async function migrateLegacyRowsToDefaultStreamer(defaultStreamerId = 1) {
  const tables = ['viewers','points_log','stream_sessions','command_usage','chat_activity_daily','custom_commands','system_commands_state'];
  for (const table of tables) {
    try { await run(`UPDATE ${table} SET streamer_id = ? WHERE streamer_id IS NULL`, [defaultStreamerId]); } catch(e) {}
  }
}

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    try {
      await initSchema();
      const defaultStreamer = await ensureDefaultStreamer();
      await migrateCoreScopedTables(defaultStreamer?.id || 1);
      await migrateLegacyRowsToDefaultStreamer(defaultStreamer?.id || 1);
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
  getLevel, getNextLevel, getLevels, getRankingEngine, addLevel, updateLevel, deleteLevel,
  getCustomCommands, getCustomCommand, setCustomCommand, deleteCustomCommand, toggleCustomCommand,
  getObjectives, createObjective, deleteObjective, achieveObjective,
  startSession, endSession, getStreamHistory, recordViewerSample, getSessionsWithAvgViewers,
  getFidelityLeaderboard, getChatHeatmap, getViewerFirstSeen, setViewerFollowingSince,
  addModerationLog, getModerationLogs, clearModerationLogs,
  getActiveChestSeason, createChestSeason, getChests, getChest, markChestOpened, updateChestContent,
  setChestTwist, setChestSecured, clearAllSecured, incrementSecureMoves, updateFogMeter,
  markEverSecured, setProtectedNumber, setVictoryPending,
  setChestChallengeDone, endChestSeason,
  logCommandUsage, getCommandUsageStats, logChatActivity, getChatActivityWeek,
  getVodMoments, addVodMoment, deleteVodMoment, updateVodMomentLabel, getPendingLiveMoments, linkMomentToVod,
  createDuel, getPendingDuel, resolveDuel, cancelDuel, getRecentDuels,
  createGiveaway, getActiveGiveaway, joinGiveaway, closeGiveaway, getGiveawayHistory,
  getLobby, joinLobby, removeFromLobby, clearLobby,
  initPanelAccess, requestAccess, getAccessStatus, getAllAccessRequests,
  approveAccess, revokeAccess, deleteAccessRequest,
  initSystemCommandsState, isSystemCmdEnabled, getAllSystemCommandsState, toggleSystemCommand,
  getAllSettings, getSetting, setSetting, getSettingStr, setSettingStr, DEFAULT_SETTINGS,
  getBannedWords, addBannedWord, deleteBannedWord, deleteBannedWordByText, getBannedWordByText, toggleBannedWord, checkBannedWords,
  getAllowedWords, addAllowedWord, deleteAllowedWord, deleteAllowedWordByText, getAllowedWordByText,
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
  ensureDefaultStreamer, getStreamerBySlug, getStreamerById, listStreamers, upsertStreamer, updateStreamerKickMeta, getActiveStreamersForBot,
  getStreamerSetting, setStreamerSetting, getOrCreateOverlayToken, regenerateOverlayToken, getOverlayTokenByValue, getOverlayTokensForStreamer, saveOAuthTokenForStreamer, getOAuthTokenForStreamer, deleteOAuthTokenForStreamer,
};
