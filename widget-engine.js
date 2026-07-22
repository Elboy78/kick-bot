'use strict';

const WIDGETS = Object.freeze([
  {
    id: 'subgoal',
    name: 'Sub Goal',
    icon: '🎯',
    color: '#28ff66',
    description: 'Objectif de subs, compteur total/session et progression en direct.',
    settingsSection: 'subgoal',
    enabledSetting: null
  },
  {
    id: 'songrequest',
    name: 'Song Request',
    icon: '🎵',
    color: '#60a5fa',
    description: 'Lecteur musical OBS, file d’attente et contrôles synchronisés.',
    settingsSection: 'songrequest',
    enabledSetting: 'songrequest_enabled'
  },
  {
    id: 'chat',
    name: 'Chat Overlay',
    icon: '💬',
    color: '#86efac',
    description: 'Messages, badges et émotes Kick affichés dans OBS.',
    settingsSection: 'chat',
    enabledSetting: 'chat_overlay_enabled'
  },
  {
    id: 'alerts',
    name: 'Alertes',
    icon: '🚨',
    color: '#fb7185',
    description: 'Follow, sub, gift et raid avec profils, sons et animations.',
    settingsSection: 'alerts',
    enabledSetting: null
  },
  {
    id: 'kickrewards',
    name: 'Interactions points Kick',
    icon: '🎟️',
    color: '#a78bfa',
    description: 'Crée des récompenses interactives : TO, Counter TO et message du viewer.',
    settingsSection: 'kickrewards',
    enabledSetting: null
  },
  {
    id: 'memes', name: 'Memes interactifs', icon: '😂', color: '#f59e0b',
    description: 'Images et GIF envoyés par les viewers avec leur texte personnalisé.',
    settingsSection: 'memes', enabledSetting: null
  }
]);

function getWidget(id) {
  const key = String(id || '').trim().toLowerCase().replace(/\.html$/, '');
  return WIDGETS.find(widget => widget.id === key) || null;
}

function listWidgets() {
  return WIDGETS.map(widget => ({ ...widget }));
}

module.exports = { WIDGETS, getWidget, listWidgets };
