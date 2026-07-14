const tenant = require('../tenant');

module.exports = function requireTenant(req, res, next) {
  if (!req.authStreamer) return res.status(401).json({ error: 'Connexion Kick requise' });

  const requested = tenant.normalizeSlug(req.params?.streamer || req.authStreamer.slug);
  const ownSlug = tenant.normalizeSlug(req.authStreamer.slug);
  if (requested !== ownSlug) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ error: 'Accès interdit à ce panel' });
    }
    return res.redirect(`/s/${ownSlug}/dashboard`);
  }

  req.streamer = req.authStreamer;
  req.streamerSlug = req.authStreamer.slug;
  next();
};
