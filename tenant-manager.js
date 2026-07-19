// tenant-manager.js — V2 Phase 3
// Couche centrale pour accéder aux données/rooms/URLs d'un streamer sans retomber sur le global.

const tenant = require('./tenant');

function boolToStr(value) { return value ? '1' : '0'; }
function strToBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return !!fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).toLowerCase());
}

class TenantManager {
  constructor({ db, io = null, streamer = null, req = null } = {}) {
    if (!db) throw new Error('TenantManager nécessite db');
    this.db = db;
    this.io = io;
    this.req = req;
    this.streamer = streamer || req?.streamer || null;
    this.streamerId = this.streamer?.id || this.streamer?.streamerId || this.streamer?.streamer_id || req?.streamerId || tenant.getCurrentStreamerId() || null;
    this.slug = tenant.normalizeSlug(this.streamer?.slug || req?.streamerSlug || tenant.getCurrentStreamerSlug());
    this.room = tenant.roomName(this.slug);
  }

  info() {
    return {
      streamerId: this.streamerId,
      slug: this.slug,
      displayName: this.streamer?.display_name || this.streamer?.displayName || this.slug,
      room: this.room
    };
  }

  baseUrl() {
    const req = this.req;
    if (!req) return '';
    const protocol = req.headers?.['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get ? req.get('host') : req.headers?.host;
    return `${protocol}://${host}`;
  }

  overlayUrl(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    const base = this.baseUrl();
    return base ? `${base}/s/${this.slug}/${clean}` : `/s/${this.slug}/${clean}`;
  }

  overlayLinks() {
    return {
      streamer: this.slug,
      classement: this.overlayUrl('classement'),
      alerts: this.overlayUrl('widgets/alerts.html'),
      chat: this.overlayUrl('widgets/chat.html'),
      songrequest: this.overlayUrl('widgets/songrequest.html'),
      subgoal: this.overlayUrl('widgets/subgoal.html'),
      memes: this.overlayUrl('widgets/memes.html')
    };
  }

  emit(event, payload) {
    if (!this.io) return false;
    this.io.to(this.room).emit(event, payload);
    return true;
  }

  emitGlobal(event, payload) {
    if (!this.io) return false;
    this.io.emit(event, payload);
    return true;
  }

  async getSetting(key, defaultValue = '') {
    if (this.streamerId && typeof this.db.getStreamerSetting === 'function') {
      return await this.db.getStreamerSetting(this.streamerId, key, defaultValue);
    }
    return await this.db.getSettingStr(key, defaultValue);
  }

  async setSetting(key, value) {
    if (this.streamerId && typeof this.db.setStreamerSetting === 'function') {
      return await this.db.setStreamerSetting(this.streamerId, key, String(value ?? ''));
    }
    return await this.db.setSettingStr(key, String(value ?? ''));
  }

  async getBool(key, defaultValue = false) {
    return strToBool(await this.getSetting(key, boolToStr(defaultValue)), defaultValue);
  }

  async setBool(key, value) {
    return await this.setSetting(key, boolToStr(!!value));
  }

  async getJson(key, defaultValue = null) {
    const raw = await this.getSetting(key, JSON.stringify(defaultValue));
    try { return JSON.parse(raw); } catch { return defaultValue; }
  }

  async setJson(key, value) {
    return await this.setSetting(key, JSON.stringify(value));
  }

  scopedKey(key) {
    return tenant.scopedKey(this.slug, key);
  }
}

function createTenantManager(opts) {
  return new TenantManager(opts);
}

module.exports = { TenantManager, createTenantManager, strToBool, boolToStr };
