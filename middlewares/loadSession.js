const tenant = require('../tenant');
const { COOKIE_NAME, readSession } = require('../core/auth/session');

module.exports = function createLoadSession(db) {
  return async function loadSession(req, res, next) {
    try {
      const cookies = tenant.parseCookies(req);
      const session = readSession(cookies[COOKIE_NAME]);
      if (!session) return next();

      const streamer = await db.getStreamerById(session.streamerId).catch(() => null);
      if (!streamer || tenant.normalizeSlug(streamer.slug) !== tenant.normalizeSlug(session.slug)) {
        return next();
      }

      req.authSession = session;
      req.authStreamer = streamer;
      req.user = {
        streamerId: streamer.id,
        slug: streamer.slug,
        kickUserId: streamer.kick_user_id || null,
        role: streamer.role || 'streamer'
      };
      next();
    } catch (error) {
      console.error('[AUTH] Erreur chargement session:', error.message);
      next();
    }
  };
};
