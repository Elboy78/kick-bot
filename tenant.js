// tenant.js — Socle V2 multi-streamer
// Centralise la résolution du streamer courant sans casser la V1.

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
  return normalizeSlug(
    req?.params?.streamer ||
    req?.params?.slug ||
    req?.query?.streamer ||
    req?.headers?.['x-streamer-slug'] ||
    req?.cookies?.streamer ||
    DEFAULT_STREAMER_SLUG
  );
}

async function attachTenant(db, req, res, next) {
  try {
    const slug = readRequestedSlug(req);
    let streamer = await db.getStreamerBySlug(slug);
    if (!streamer && slug === DEFAULT_STREAMER_SLUG) {
      streamer = await db.ensureDefaultStreamer(getDefaultStreamerSeed());
    }
    req.streamer = streamer || await db.ensureDefaultStreamer(getDefaultStreamerSeed());
    req.streamerSlug = req.streamer.slug;
  } catch (e) {
    req.streamer = null;
    req.streamerSlug = DEFAULT_STREAMER_SLUG;
  }
  next();
}

function scopedKey(streamer, key) {
  const slug = typeof streamer === 'string' ? streamer : (streamer?.slug || DEFAULT_STREAMER_SLUG);
  return `streamer:${normalizeSlug(slug)}:${key}`;
}

module.exports = {
  DEFAULT_STREAMER_SLUG,
  normalizeSlug,
  getDefaultStreamerSeed,
  readRequestedSlug,
  attachTenant,
  scopedKey
};
