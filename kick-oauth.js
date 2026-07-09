// kick-oauth.js — OAuth Kick V2 multi-streamer
// Connexion streamer réelle : le compte Kick connecté crée/charge son tenant.

const crypto = require('crypto');
const axios = require('axios');
const db = require('./database');
const tenant = require('./tenant');

const KICK_AUTH_BASE = 'https://id.kick.com';
const PROVIDER = 'kick';
const BOT_PROVIDER = 'kick_bot';
function providerForBot() { return BOT_PROVIDER; }
function providerForStreamer(streamerId) { return streamerId ? `kick:${streamerId}` : PROVIDER; }

const CLIENT_ID     = process.env.KICK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.KICK_REDIRECT_URI || '';

let pendingPKCE = null;

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
}

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function normalizeScopes(scopes) {
  return scopes || process.env.KICK_OAUTH_SCOPES || 'user:read channel:read chat:write';
}

function getAuthorizationUrl(scopes, options = {}) {
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  const meta = {
    mode: options.mode || options.purpose || 'streamer_login',
    returnTo: options.returnTo || '',
    streamerId: options.streamerId || options.streamer_id || null,
    createdAt: Date.now()
  };
  pendingPKCE = { codeVerifier, state, meta, createdAt: Date.now() };

  db.setBotStatus(`pkce_code_verifier_${state}`, codeVerifier).catch(()=>{});
  db.setBotStatus(`pkce_meta_${state}`, JSON.stringify(meta)).catch(()=>{});
  db.setBotStatus('pkce_state', state).catch(()=>{}); // compat ancienne version
  db.setBotStatus('pkce_code_verifier', codeVerifier).catch(()=>{}); // compat ancienne version
  db.setBotStatus('pkce_created_at', String(Date.now())).catch(()=>{});

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: normalizeScopes(scopes),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${KICK_AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

async function readPkce(state) {
  if (pendingPKCE && pendingPKCE.state === state) return pendingPKCE;
  const verifier = await db.getBotStatus(`pkce_code_verifier_${state}`).then(r => r?.value).catch(() => null)
    || await db.getBotStatus('pkce_code_verifier').then(r => r?.value).catch(() => null);
  const metaRaw = await db.getBotStatus(`pkce_meta_${state}`).then(r => r?.value).catch(() => '{}');
  const storedState = await db.getBotStatus('pkce_state').then(r => r?.value).catch(() => null);
  const storedAt = await db.getBotStatus('pkce_created_at').then(r => parseInt(r?.value||'0')).catch(() => 0);
  if (!verifier || (storedState && storedState !== state)) throw new Error('État OAuth invalide — relance la connexion Kick.');
  if (storedAt && Date.now() - storedAt > 10 * 60 * 1000) throw new Error('Connexion OAuth expirée — relance la connexion Kick.');
  return { codeVerifier: verifier, state, meta: safeJson(metaRaw), createdAt: storedAt || Date.now() };
}

async function exchangeCodeForToken(code, state) {
  const pkce = await readPkce(state);
  pendingPKCE = null;

  const response = await axios.post(
    `${KICK_AUTH_BASE}/oauth/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.codeVerifier,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
  );

  const data = response.data || {};
  const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  if ((pkce.meta || {}).mode === 'bot_login') {
    await db.saveOAuthToken(BOT_PROVIDER, data.access_token, data.refresh_token, expiresAt);
  }

  db.setBotStatus(`pkce_code_verifier_${state}`, '').catch(()=>{});
  db.setBotStatus(`pkce_meta_${state}`, '').catch(()=>{});
  db.setBotStatus('pkce_state', '').catch(()=>{});
  db.setBotStatus('pkce_code_verifier', '').catch(()=>{});

  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, meta: pkce.meta || {} };
}

function pick(...values) {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
}
function normalizeUserPayload(payload = {}) {
  const root = payload || {};
  const data = Array.isArray(root.data) ? root.data[0] : (root.data || root.user || root);
  const id = data?.id || data?.user_id || data?.kick_id || data?.profile?.id || null;
  const username = pick(data?.username, data?.name, data?.slug, data?.login, data?.profile?.username, data?.profile?.slug);
  const displayName = pick(data?.display_name, data?.displayName, data?.username, data?.name, data?.profile?.display_name, username);
  const avatar = pick(data?.profile_picture, data?.profilepic, data?.avatar, data?.avatar_url, data?.profile?.avatar, data?.profile?.profile_picture);
  return { id: id ? String(id) : '', username, displayName: displayName || username, avatar };
}

async function fetchCurrentUser(accessToken) {
  if (!accessToken) throw new Error('Access token manquant');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'KickBot/2.0' };
  const endpoints = [
    'https://api.kick.com/public/v1/users',
    'https://api.kick.com/public/v1/user',
    'https://kick.com/api/v2/user'
  ];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { headers, timeout: 10000 });
      const user = normalizeUserPayload(data);
      if (user.username || user.id) return user;
    } catch (e) { lastError = e; }
  }
  throw new Error(`Impossible de récupérer le compte Kick connecté${lastError?.response?.status ? ' ('+lastError.response.status+')' : ''}`);
}


async function fetchChannelInfoForUser(accessToken, user = {}) {
  const slug = String(user.username || user.displayName || '').trim().toLowerCase();
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'KickBot/2.0' };
  const out = {};

  // API officielle : fournit souvent broadcaster_user_id / id, mais pas toujours chatroom_id.
  if (slug) {
    try {
      const { data } = await axios.get('https://api.kick.com/public/v1/channels', {
        params: { slug }, headers, timeout: 10000
      });
      const ch = Array.isArray(data?.data) ? data.data[0] : (data?.data || data);
      if (ch) {
        out.channelId = ch.id || ch.channel_id || ch.slug_id || out.channelId;
        out.broadcasterUserId = ch.broadcaster_user_id || ch.user_id || user.id || out.broadcasterUserId;
        out.chatroomId = ch.chatroom_id || ch.chatroom?.id || ch.chatroom?.chatroom_id || out.chatroomId;
      }
    } catch(e) {}
  }

  // Certains endpoints user/channel peuvent contenir chatroom_id selon le scope/format.
  try {
    const { data } = await axios.get('https://api.kick.com/public/v1/users', { headers, timeout: 10000 });
    const root = Array.isArray(data?.data) ? data.data[0] : (data?.data || data?.user || data);
    const ch = root?.channel || root?.channels?.[0] || root?.livestream?.channel || {};
    out.channelId = out.channelId || ch.id || ch.channel_id;
    out.broadcasterUserId = out.broadcasterUserId || ch.broadcaster_user_id || root?.id || user.id;
    out.chatroomId = out.chatroomId || ch.chatroom_id || ch.chatroom?.id || root?.chatroom_id || root?.chatroom?.id;
  } catch(e) {}

  return out;
}

async function getValidBotAccessToken() {
  let stored = await db.getOAuthToken(BOT_PROVIDER);
  if (!stored) return null;
  if (Date.now() < stored.expires_at - 60000) return stored.access_token;
  try {
    const response = await axios.post(
      `${KICK_AUTH_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
    );
    const data = response.data || {};
    const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
    await db.saveOAuthToken(BOT_PROVIDER, data.access_token, data.refresh_token || stored.refresh_token, expiresAt);
    return data.access_token;
  } catch (err) {
    console.error('[OAUTH BOT] Échec du refresh:', err.response?.data || err.message);
    return null;
  }
}

async function isBotConnected() {
  return !!(await db.getOAuthToken(BOT_PROVIDER));
}

async function getValidAccessToken(streamerId = null) {
  let stored = await db.getOAuthToken(providerForStreamer(streamerId));
  if (!stored && streamerId) stored = await db.getOAuthToken(PROVIDER);
  if (!stored) return null;
  if (Date.now() < stored.expires_at - 60000) return stored.access_token;
  try {
    const response = await axios.post(
      `${KICK_AUTH_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
    );
    const data = response.data || {};
    const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
    await db.saveOAuthToken(providerForStreamer(streamerId), data.access_token, data.refresh_token || stored.refresh_token, expiresAt);
    return data.access_token;
  } catch (err) {
    console.error('[OAUTH] Échec du refresh:', err.response?.data || err.message);
    return null;
  }
}

async function isConnected(streamerId = null) {
  let stored = await db.getOAuthToken(providerForStreamer(streamerId));
  if (!stored && streamerId) stored = await db.getOAuthToken(PROVIDER);
  return !!stored;
}

async function disconnect(streamerId = null) {
  await db.deleteOAuthToken(providerForStreamer(streamerId));
}

module.exports = {
  isConfigured,
  getAuthorizationUrl,
  exchangeCodeForToken,
  fetchCurrentUser,
  getValidAccessToken,
  isConnected,
  disconnect,
  providerForStreamer,
  providerForBot,
  fetchChannelInfoForUser,
  getValidBotAccessToken,
  isBotConnected,
};
