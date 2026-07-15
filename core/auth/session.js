const crypto = require('crypto');

const COOKIE_NAME = 'elbot_session_final';
const OLD_COOKIE_NAMES = [
  'elbot_session',
  'elbot_session_v2',
  'elbot_session_v3'
];
const ADMIN_TARGET_COOKIE_NAME = 'elbot_admin_target';
const DEFAULT_SESSION_DAYS = 30;
const MIN_SESSION_DAYS = 1;
const MAX_SESSION_DAYS = 90;
const ADMIN_TARGET_MAX_AGE_MS = 1000 * 60 * 60 * 8;

function sessionMaxAgeMs() {
  const configured = Number.parseInt(process.env.SESSION_MAX_AGE_DAYS || '', 10);
  const days = Number.isFinite(configured)
    ? Math.min(MAX_SESSION_DAYS, Math.max(MIN_SESSION_DAYS, configured))
    : DEFAULT_SESSION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

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

function createSession(streamer, now = Date.now()) {
  if (!streamer?.id || !streamer?.slug) throw new Error('Streamer invalide pour la session');
  const maxAge = sessionMaxAgeMs();
  const payload = encode(JSON.stringify({
    streamerId: Number(streamer.id),
    slug: String(streamer.slug),
    issuedAt: now,
    expiresAt: now + maxAge
  }));
  return `${payload}.${sign(payload)}`;
}

function readSignedPayload(value) {
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

function readSession(value) {
  return readSignedPayload(value);
}

function shouldRefreshSession(session, now = Date.now()) {
  if (!session?.issuedAt || !session?.expiresAt) return true;
  const maxAge = sessionMaxAgeMs();
  const age = now - Number(session.issuedAt);
  const remaining = Number(session.expiresAt) - now;
  // Session glissante : renouvellement après 24 h d'utilisation ou lorsqu'il
  // reste moins d'un tiers de sa durée de vie.
  return age >= Math.min(24 * 60 * 60 * 1000, maxAge / 3) || remaining <= maxAge / 3;
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
  return readSignedPayload(value);
}

function cookieOptions(req, maxAge = sessionMaxAgeMs()) {
  const forwardedProto = String(
    req?.headers?.['x-forwarded-proto'] || ''
  )
    .split(',')[0]
    .trim();

  const secure =
    forwardedProto === 'https' ||
    req?.secure ||
    process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge
  };
}

function clearCookieVariants(req, res, name) {
  const host = String(
    req.hostname || req.headers.host || ''
  )
    .split(':')[0]
    .trim()
    .toLowerCase();

  const variants = [
    {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    },
    {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax'
    }
  ];

  if (host) {
    variants.push({
      path: '/',
      domain: host,
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    });
  }

  if (host === 'test.elbot.fr' || host === 'panel.elbot.fr') {
    variants.push({
      path: '/',
      domain: '.elbot.fr',
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    });
  }

  for (const options of variants) {
    res.clearCookie(name, options);
  }
}

function setSessionCookie(req, res, streamer) {
  for (const oldName of OLD_COOKIE_NAMES) {
    clearCookieVariants(req, res, oldName);
  }

  res.cookie(
    COOKIE_NAME,
    createSession(streamer),
    cookieOptions(req)
  );
}

function clearSessionCookie(req, res) {
  clearCookieVariants(req, res, COOKIE_NAME);

  for (const oldName of OLD_COOKIE_NAMES) {
    clearCookieVariants(req, res, oldName);
  }

  clearCookieVariants(req, res, ADMIN_TARGET_COOKIE_NAME);
  clearCookieVariants(req, res, 'kb_streamer');
}
}

function setAdminTargetCookie(req, res, target) {
  res.cookie(ADMIN_TARGET_COOKIE_NAME, createAdminTarget(target), cookieOptions(req, ADMIN_TARGET_MAX_AGE_MS));
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
  shouldRefreshSession,
  createAdminTarget,
  readAdminTarget,
  setSessionCookie,
  clearSessionCookie,
  setAdminTargetCookie,
  clearAdminTargetCookie,
  sessionMaxAgeMs
};
