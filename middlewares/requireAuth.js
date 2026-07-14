module.exports = function requireAuth(req, res, next) {
  if (req.authStreamer) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Connexion Kick requise' });
  }
  const returnTo = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?returnTo=${returnTo}`);
};
