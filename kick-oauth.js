// kick-oauth.js — Gestion OAuth 2.1 officiel de Kick (PKCE) avec refresh automatique
// Les tokens sont stockés dans Turso (table oauth_tokens) pour survivre aux redéploiements Render.

const crypto = require('crypto');
const db = require('./database');

const KICK_AUTH_BASE = 'https://id.kick.com';
const PROVIDER = 'kick';

const CLIENT_ID     = process.env.KICK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.KICK_REDIRECT_URI || '';

// PKCE en mémoire — un seul flow de login à la fois (suffisant pour un panel admin solo)
let pendingPKCE = null; // { codeVerifier, state }

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

function getAuthorizationUrl(scopes) {
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  pendingPKCE = { codeVerifier, state, createdAt: Date.now() };

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
  if (!pendingPKCE || pendingPKCE.state !== state) {
    throw new Error('État OAuth invalide ou expiré — relance la connexion depuis le panel.');
  }
  const codeVerifier = pendingPKCE.codeVerifier;
  pendingPKCE = null;

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
  await db.saveOAuthToken(PROVIDER, data.access_token, data.refresh_token, expiresAt);
  return data.access_token;
}

// Retourne un access_token valide, en le rafraîchissant automatiquement si besoin
async function getValidAccessToken() {
  const stored = await db.getOAuthToken(PROVIDER);
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
    await db.saveOAuthToken(PROVIDER, data.access_token, newRefreshToken, expiresAt);
    console.log('[OAUTH] Token Kick rafraîchi automatiquement ✓');
    return data.access_token;
  } catch (err) {
    console.error('[OAUTH] Échec du refresh:', err.response?.data || err.message);
    return null;
  }
}

async function isConnected() {
  const stored = await db.getOAuthToken(PROVIDER);
  return !!stored;
}

async function disconnect() {
  await db.deleteOAuthToken(PROVIDER);
}

module.exports = {
  isConfigured,
  getAuthorizationUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  isConnected,
  disconnect,
};
