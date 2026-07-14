function wantsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

module.exports = function requireAuth(req, res, next) {
  if (req.authSession?.streamerId) return next();
  if (wantsHtml(req)) {
    const returnTo = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?returnTo=${returnTo}`);
  }
  return res.status(401).json({ error: 'Connexion Kick requise', code: 'AUTH_REQUIRED' });
};
