const tenant = require('../tenant');

module.exports = function requireTenant(req, res, next) {
  if (!req.authStreamer) return res.status(401).json({ error: 'Connexion Kick requise' });

  const effectiveStreamer = req.platformAdmin && req.adminTargetStreamer
    ? req.adminTargetStreamer
    : req.authStreamer;

  const requested = tenant.normalizeSlug(req.params?.streamer || effectiveStreamer.slug);
  const effectiveSlug = tenant.normalizeSlug(effectiveStreamer.slug);
  if (requested !== effectiveSlug) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ error: 'Accès interdit à ce panel' });
    }
    return res.redirect(`/s/${effectiveSlug}/dashboard`);
  }

  req.streamer = effectiveStreamer;
  req.streamerSlug = effectiveStreamer.slug;
  req.isAdminImpersonation = Boolean(req.platformAdmin && req.adminTargetStreamer);
  next();
};
