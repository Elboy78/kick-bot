const tenant = require('../tenant');
const { COOKIE_NAME, verifySession } = require('../core/auth/session');

module.exports = function loadSession(req, _res, next) {
  const cookies = tenant.parseCookies(req);
  const session = verifySession(cookies[COOKIE_NAME]);
  req.authSession = session;
  req.user = session ? {
    kickUserId: session.kickUserId,
    username: session.username,
    streamerId: session.streamerId,
    streamerSlug: session.streamerSlug,
  } : null;
  next();
};
