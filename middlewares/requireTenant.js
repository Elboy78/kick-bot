module.exports = function requireTenant(req, res, next) {
  const session = req.authSession;
  if (!session?.streamerId) {
    return res.status(401).json({ error: 'Connexion Kick requise', code: 'AUTH_REQUIRED' });
  }
  if (!req.streamer || Number(req.streamer.id) !== Number(session.streamerId)) {
    return res.status(403).json({ error: 'Accès interdit à ce panel', code: 'TENANT_FORBIDDEN' });
  }
  next();
};
