const tenant = require('../../tenant');

function configuredAdminIds() {
  return new Set(
    String(process.env.PLATFORM_ADMIN_KICK_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function isPlatformAdmin(streamer) {
  const kickUserId = String(streamer?.kick_user_id || streamer?.kickUserId || '').trim();
  return Boolean(kickUserId && configuredAdminIds().has(kickUserId));
}

function normalizeTarget(target) {
  if (!target?.id || !target?.slug) return null;
  return {
    streamerId: Number(target.id),
    slug: tenant.normalizeSlug(target.slug)
  };
}

module.exports = {
  configuredAdminIds,
  isPlatformAdmin,
  normalizeTarget
};
