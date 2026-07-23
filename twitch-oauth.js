const crypto = require('crypto');
const axios = require('axios');
const db = require('./database');

const CLIENT_ID = String(process.env.TWITCH_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.TWITCH_CLIENT_SECRET || '').trim();
const REDIRECT_URI = String(
  process.env.TWITCH_REDIRECT_URI ||
  `${String(process.env.PANEL_PUBLIC_URL || '').replace(/\/+$/, '')}/auth/twitch/callback`
).trim();
const AUTH_BASE = 'https://id.twitch.tv/oauth2';
const API_BASE = 'https://api.twitch.tv/helix';
const STATE_TTL_MS = 10 * 60 * 1000;
// Phase 1 : demander uniquement l’identité. Les scopes chat, EventSub,
// abonnements et récompenses seront ajoutés quand leurs modules seront actifs.
// Twitch peut sanctionner une application qui réclame des droits inutilisés.
const SCOPES = [...new Set(
  String(process.env.TWITCH_OAUTH_SCOPES || 'user:read:email')
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean)
)];

function isConfigured() {
  try {
    const redirect = new URL(REDIRECT_URI);
    return Boolean(CLIENT_ID && CLIENT_SECRET && /^https?:$/.test(redirect.protocol));
  } catch {
    return false;
  }
}

async function getAuthorizationUrl() {
  if (!isConfigured()) throw new Error('OAuth Twitch non configuré');
  const state = crypto.randomBytes(24).toString('hex');
  await db.setBotStatus(`twitch_oauth_state_${state}`, JSON.stringify({ createdAt: Date.now() }));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function consumeState(state) {
  const key = `twitch_oauth_state_${String(state || '')}`;
  const row = await db.getBotStatus(key);
  await db.setBotStatus(key, '');
  let parsed;
  try { parsed = JSON.parse(row?.value || '{}'); } catch { parsed = {}; }
  if (!parsed.createdAt || Date.now() - Number(parsed.createdAt) > STATE_TTL_MS) {
    throw new Error('État OAuth Twitch invalide ou expiré');
  }
}

async function exchangeCode(code, state) {
  await consumeState(state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: String(code || ''),
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const { data } = await axios.post(`${AUTH_BASE}/token`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 14400) * 1000,
    scopes: data.scope || [],
  };
}

async function fetchCurrentUser(accessToken) {
  const { data } = await axios.get(`${API_BASE}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': CLIENT_ID,
    },
  });
  const user = data?.data?.[0];
  if (!user?.id || !user?.login) throw new Error('Twitch n’a renvoyé aucun utilisateur');
  return {
    id: String(user.id),
    username: String(user.login).toLowerCase(),
    displayName: user.display_name || user.login,
    avatarUrl: user.profile_image_url || '',
    email: user.email || '',
  };
}

function providerForStreamer(streamerId) {
  return `twitch:${Number(streamerId)}`;
}

module.exports = {
  isConfigured,
  getAuthorizationUrl,
  exchangeCode,
  fetchCurrentUser,
  providerForStreamer,
  scopes: SCOPES,
};
