// kick-oauth.js — Gestion OAuth 2.1 officiel de Kick (PKCE) avec refresh automatique
// Les tokens sont stockés dans Turso (table oauth_tokens) pour survivre aux redéploiements Render.

const crypto = require('crypto');
const db = require('./database');

const KICK_AUTH_BASE = 'https://id.kick.com';
const PROVIDER = 'kick';
function providerForStreamer(streamerId) { return streamerId ? `kick:${streamerId}` : PROVIDER; }

const CLIENT_ID     = process.env.KICK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.KICK_REDIRECT_URI || '';

// PKCE persisté en DB — survit aux redémarrages Render
// (bot_status réutilisé car c'est une table clé-valeur générique)
let pendingPKCE = null; // cache mémoire + DB

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

function getAuthorizationUrl(scopes, options = {}) {
  const streamerId = options.streamerId || options.streamer_id || null;
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  pendingPKCE = { codeVerifier, state, createdAt: Date.now() };
  // Persister en DB pour survivre aux redémarrages
  db.setBotStatus('pkce_code_verifier', codeVerifier).catch(()=>{});
  db.setBotStatus('pkce_state', state).catch(()=>{});
  db.setBotStatus('pkce_created_at', String(Date.now())).catch(()=>{});
  db.setBotStatus(`pkce_streamer_id_${state}`, streamerId ? String(streamerId) : '').catch(()=>{});

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: scopes || 'user:read channel:read chat:write moderation:ban',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return `${KICK_AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, state) {
  // Essayer d'abord le cache mémoire, puis la DB (si Render a redémarré entre login et callback)
  let pkce = pendingPKCE;
  if (!pkce || pkce.state !== state) {
    // Render a peut-être redémarré — on relit depuis la DB
    const storedState   = await db.getBotStatus('pkce_state').then(r => r?.value).catch(() => null);
    const storedVerifier = await db.getBotStatus('pkce_code_verifier').then(r => r?.value).catch(() => null);
    const storedAt       = await db.getBotStatus('pkce_created_at').then(r => parseInt(r?.value||'0')).catch(() => 0);

    if (storedState && storedState === state && storedVerifier) {
      // Valide si moins de 10 minutes (sécurité)
      if (Date.now() - storedAt < 600000) {
        pkce = { codeVerifier: storedVerifier, state: storedState };
        console.log('[OAUTH] PKCE récupéré depuis la DB après redémarrage Render ✓');
      } else {
        throw new Error('PKCE expiré (> 10 min) — relance la connexion depuis le panel.');
      }
    } else {
      throw new Error(`État OAuth invalide — state reçu: ${state}, state DB: ${storedState}. Relance la connexion.`);
    }
  }

  const codeVerifier = pkce.codeVerifier;
  const streamerId = await db.getBotStatus(`pkce_streamer_id_${state}`).then(r => r?.value || '').catch(() => '');
  pendingPKCE = null;
  // Nettoyer la DB
  db.setBotStatus('pkce_code_verifier', '').catch(()=>{});
  db.setBotStatus('pkce_state', '').catch(()=>{});
  db.setBotStatus(`pkce_streamer_id_${state}`, '').catch(()=>{});

  const axios = require('axios');
  const response = await axios.post(
    `${KICK_AUTH_BASE}/oauth/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const data = response.data;
  const expiresAt = Date.now() + (data.expires_in * 1000);
  await db.saveOAuthToken(providerForStreamer(streamerId), data.access_token, data.refresh_token, expiresAt);
  if (!streamerId) await db.saveOAuthToken(PROVIDER, data.access_token, data.refresh_token, expiresAt);
  console.log(`[OAUTH] Token Kick sauvegardé en DB ✓${streamerId ? ' streamer_id=' + streamerId : ''}`);
  return { accessToken: data.access_token, streamerId: streamerId || null };
}

// Retourne un access_token valide, en le rafraîchissant automatiquement si besoin
async function getValidAccessToken(streamerId = null) {
  let stored = await db.getOAuthToken(providerForStreamer(streamerId));
  if (!stored && streamerId) stored = await db.getOAuthToken(PROVIDER);
  if (!stored) return null;

  // Marge de sécurité de 60s avant l'expiration réelle
  if (Date.now() < stored.expires_at - 60000) {
    return stored.access_token;
  }

  // Token expiré (ou presque) — on le rafraîchit
  try {
    const axios = require('axios');
    const response = await axios.post(
      `${KICK_AUTH_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = response.data;
    const expiresAt = Date.now() + (data.expires_in * 1000);
    const newRefreshToken = data.refresh_token || stored.refresh_token;
    await db.saveOAuthToken(providerForStreamer(streamerId), data.access_token, newRefreshToken, expiresAt);
    console.log('[OAUTH] Token Kick rafraîchi automatiquement ✓');
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
  getValidAccessToken,
  isConnected,
  disconnect,
  providerForStreamer,
};
