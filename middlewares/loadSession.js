const tenant = require('../tenant');
const {
  COOKIE_NAME,
  ADMIN_TARGET_COOKIE_NAME,
  readSession,
  readAdminTarget,
  shouldRefreshSession,
  setSessionCookie
} = require('../core/auth/session');
const { isPlatformAdmin } = require('../core/auth/platform-admin');

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

      const platformAdmin = isPlatformAdmin(streamer);
      let adminTargetStreamer = null;
      if (platformAdmin) {
        const target = readAdminTarget(cookies[ADMIN_TARGET_COOKIE_NAME]);
        if (target?.streamerId && target?.slug) {
          const candidate = await db.getStreamerById(target.streamerId).catch(() => null);
          if (candidate && tenant.normalizeSlug(candidate.slug) === tenant.normalizeSlug(target.slug)) {
            adminTargetStreamer = candidate;
          }
        }
      }

      req.authSession = session;
      req.authStreamer = streamer;
      req.platformAdmin = platformAdmin;
      req.adminTargetStreamer = adminTargetStreamer;
      req.user = {
        streamerId: streamer.id,
        slug: streamer.slug,
        kickUserId: streamer.kick_user_id || null,
        role: streamer.role || 'streamer',
        platformAdmin
      };

      // Prolonge la session lors d'une utilisation réelle, sans rappeler OAuth.
      if (shouldRefreshSession(session)) {
        setSessionCookie(req, res, { id: streamer.id, slug: streamer.slug });
        req.authSessionRefreshed = true;
      }

      next();
    } catch (error) {
      console.error('[AUTH] Erreur chargement session:', error.message);
      next();
    }
  };
};
