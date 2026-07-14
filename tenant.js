// tenant.js — Socle V2 multi-streamer
// Centralise la résolution du streamer courant sans casser la V1.

const { AsyncLocalStorage } = require('async_hooks');
const tenantStorage = new AsyncLocalStorage();

const DEFAULT_STREAMER_SLUG = (process.env.DEFAULT_STREAMER_SLUG || process.env.KICK_CHANNEL || 'main')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-') || 'main';

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || DEFAULT_STREAMER_SLUG;
}


function parseCookies(req) {
  const header = req?.headers?.cookie || '';
  return Object.fromEntries(String(header).split(';').map(v => {
    const i = v.indexOf('=');
    if (i < 0) return null;
    const key = v.slice(0, i).trim();
    const val = decodeURIComponent(v.slice(i + 1).trim());
    return key ? [key, val] : null;
  }).filter(Boolean));
}

function getDefaultStreamerSeed() {
  const slug = normalizeSlug(DEFAULT_STREAMER_SLUG);
  return {
    slug,
    kickUsername: process.env.KICK_CHANNEL || slug,
    displayName: process.env.PANEL_OWNER || process.env.KICK_CHANNEL || slug,
    role: 'owner'
  };
}

function readRequestedSlug(req) {
  const directPath = `${req?.originalUrl || ''} ${req?.path || ''} ${req?.url || ''}`;
  const pathSlug = String(directPath).match(/\/s\/([^\/?#\s]+)/)?.[1];
  let refererSlug = '';
  try {
    const ref = String(req?.headers?.referer || req?.headers?.referrer || '');
    refererSlug = ref.match(/\/s\/([^\/?#]+)/)?.[1] || '';
  } catch(e) {}
  const cookies = { ...parseCookies(req), ...(req?.cookies || {}) };
  return normalizeSlug(
    req?.params?.streamer ||
    req?.params?.slug ||
    pathSlug ||
    req?.query?.streamer ||
    req?.headers?.['x-streamer-slug'] ||
    refererSlug ||
    cookies.kb_streamer ||
    cookies.streamer ||
    DEFAULT_STREAMER_SLUG
  );
}

async function ensureRequestedStreamer(db, slug) {
  const cleanSlug = normalizeSlug(slug || DEFAULT_STREAMER_SLUG);
  let streamer = await db.getStreamerBySlug(cleanSlug).catch(() => null);

  // V2 réelle : un slug demandé par /s/:streamer ou ?streamer= doit avoir
  // son propre tenant. Avant, un slug inconnu retombait sur le streamer par
  // défaut, donc tous les widgets affichaient la même file Song Request.
  if (!streamer) {
    if (cleanSlug === DEFAULT_STREAMER_SLUG) {
      streamer = await db.ensureDefaultStreamer(getDefaultStreamerSeed());
    } else if (typeof db.upsertStreamer === 'function') {
      streamer = await db.upsertStreamer({
        slug: cleanSlug,
        kickUsername: cleanSlug,
        displayName: cleanSlug,
        role: 'streamer',
        status: 'active'
      });
    }
  }

  return streamer || await db.ensureDefaultStreamer(getDefaultStreamerSeed());
}

async function attachTenant(db, req, res, next) {
  try {
    let streamer = null;
    if (req.authSession?.streamerId && typeof db.getStreamerById === 'function') {
      streamer = await db.getStreamerById(req.authSession.streamerId).catch(() => null);
    }
    if (!streamer) {
      const slug = readRequestedSlug(req);
      streamer = await ensureRequestedStreamer(db, slug);
    }
    req.streamer = streamer;
    req.streamerSlug = streamer.slug;
  } catch (e) {
    try {
      const fallback = await db.ensureDefaultStreamer(getDefaultStreamerSeed());
      req.streamer = fallback;
      req.streamerSlug = fallback.slug;
    } catch (_) {
      req.streamer = null;
      req.streamerSlug = DEFAULT_STREAMER_SLUG;
    }
  }
  const context = {
    streamerId: req.streamer?.id || null,
    streamerSlug: req.streamer?.slug || DEFAULT_STREAMER_SLUG,
    streamer: req.streamer || null
  };
  tenantStorage.run(context, () => next());
}

function runWithStreamer(streamer, fn) {
  const context = {
    streamerId: streamer?.id || streamer || null,
    streamerSlug: streamer?.slug || DEFAULT_STREAMER_SLUG,
    streamer: typeof streamer === 'object' ? streamer : null
  };
  return tenantStorage.run(context, fn);
}

function getCurrentTenant() {
  return tenantStorage.getStore() || null;
}

function getCurrentStreamerId() {
  return tenantStorage.getStore()?.streamerId || null;
}

function getCurrentStreamerSlug() {
  return tenantStorage.getStore()?.streamerSlug || DEFAULT_STREAMER_SLUG;
}


function roomName(streamer) {
  return `streamer:${normalizeSlug(typeof streamer === 'string' ? streamer : (streamer?.slug || streamer?.streamerSlug || DEFAULT_STREAMER_SLUG))}`;
}

function scopedKey(streamer, key) {
  const slug = typeof streamer === 'string' ? streamer : (streamer?.slug || DEFAULT_STREAMER_SLUG);
  return `streamer:${normalizeSlug(slug)}:${key}`;
}

module.exports = {
  DEFAULT_STREAMER_SLUG,
  normalizeSlug,
  parseCookies,
  getDefaultStreamerSeed,
  readRequestedSlug,
  ensureRequestedStreamer,
  attachTenant,
  runWithStreamer,
  getCurrentTenant,
  getCurrentStreamerId,
  getCurrentStreamerSlug,
  scopedKey,
  roomName
};
