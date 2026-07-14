const crypto = require('crypto');

const COOKIE_NAME = 'elbot_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function getSecret() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET doit contenir au moins 32 caractères.');
  }
  return secret;
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(payload) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    version: 1,
    streamerId: Number(payload.streamerId),
    streamerSlug: String(payload.streamerSlug || ''),
    kickUserId: String(payload.kickUserId || ''),
    username: String(payload.username || payload.streamerSlug || ''),
    issuedAt: now,
    expiresAt: now + MAX_AGE_SECONDS,
  };

  if (!Number.isInteger(body.streamerId) || body.streamerId <= 0 || !body.streamerSlug) {
    throw new Error('Session invalide: streamer manquant.');
  }

  const encoded = encode(JSON.stringify(body));
  return `${encoded}.${sign(encoded)}`;
}

function verifySession(token) {
  try {
    const [encoded, signature] = String(token || '').split('.');
    if (!encoded || !signature || !safeEqual(signature, sign(encoded))) return null;
    const payload = JSON.parse(decode(encoded));
    const now = Math.floor(Date.now() / 1000);
    if (payload.version !== 1 || !payload.streamerId || !payload.streamerSlug || payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER_EXTERNAL_URL);
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS * 1000,
  };
}

function setSessionCookie(res, payload) {
  res.cookie(COOKIE_NAME, createSession(payload), cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

module.exports = {
  COOKIE_NAME,
  createSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
};
