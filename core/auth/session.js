const crypto = require('crypto');

const COOKIE_NAME = 'elbot_session';
const ADMIN_TARGET_COOKIE_NAME = 'elbot_admin_target';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_TARGET_MAX_AGE_MS = 1000 * 60 * 60 * 8;

function getSecret() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET manquant');
  return secret;
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSession(streamer) {
  if (!streamer?.id || !streamer?.slug) throw new Error('Streamer invalide pour la session');
  const now = Date.now();
  const payload = encode(JSON.stringify({
    streamerId: Number(streamer.id),
    slug: String(streamer.slug),
    issuedAt: now,
    expiresAt: now + MAX_AGE_MS
  }));
  return `${payload}.${sign(payload)}`;
}

function readSession(value) {
  if (!value || typeof value !== 'string') return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;
  let expected;
  try { expected = sign(payload); } catch { return null; }
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(decode(payload));
    if (!data.streamerId || !data.slug || !data.expiresAt || Date.now() >= Number(data.expiresAt)) return null;
    return data;
  } catch {
    return null;
  }
}


function createAdminTarget(target) {
  if (!target?.streamerId || !target?.slug) throw new Error('Tenant admin invalide');
  const now = Date.now();
  const payload = encode(JSON.stringify({
    streamerId: Number(target.streamerId),
    slug: String(target.slug),
    issuedAt: now,
    expiresAt: now + ADMIN_TARGET_MAX_AGE_MS
  }));
  return `${payload}.${sign(payload)}`;
}

function readAdminTarget(value) {
  return readSession(value);
}

function cookieOptions(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || req?.secure || process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_MS
  };
}

function setSessionCookie(req, res, streamer) {
  res.cookie(COOKIE_NAME, createSession(streamer), cookieOptions(req));
}

function clearSessionCookie(req, res) {
  const options = cookieOptions(req);
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
  res.clearCookie(ADMIN_TARGET_COOKIE_NAME, options);
}

function setAdminTargetCookie(req, res, target) {
  res.cookie(ADMIN_TARGET_COOKIE_NAME, createAdminTarget(target), {
    ...cookieOptions(req),
    maxAge: ADMIN_TARGET_MAX_AGE_MS
  });
}

function clearAdminTargetCookie(req, res) {
  const options = cookieOptions(req);
  delete options.maxAge;
  res.clearCookie(ADMIN_TARGET_COOKIE_NAME, options);
}

module.exports = {
  COOKIE_NAME,
  ADMIN_TARGET_COOKIE_NAME,
  createSession,
  readSession,
  createAdminTarget,
  readAdminTarget,
  setSessionCookie,
  clearSessionCookie,
  setAdminTargetCookie,
  clearAdminTargetCookie
};
