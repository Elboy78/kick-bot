
(function(){
  const THEMES = ['control','dbd','obs','vision','neon','elite','steam','riot'];
  const KEY = 'elbot_ref_appearance_v1';
  const legacy = {classic:'control',liquid:'control',midnight:'elite',aurora:'vision'};
  let themeLink = null;

  function normalize(name){
    const value = legacy[name] || name;
    return THEMES.includes(value) ? value : 'control';
  }

  function read(){
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch(_) { return {}; }
  }

  function save(theme){
    const current = read();
    localStorage.setItem(KEY, JSON.stringify({...current, interface:theme}));
  }

  function ensureLink(){
    if (themeLink) return themeLink;
    themeLink = document.getElementById('elbot-active-theme');
    if (!themeLink) {
      themeLink = document.createElement('link');
      themeLink.rel = 'stylesheet';
      themeLink.id = 'elbot-active-theme';
      document.head.appendChild(themeLink);
    }
    return themeLink;
  }

  function refreshButtons(theme){
    document.querySelectorAll('[data-ref-interface]').forEach(button=>{
      const active = button.dataset.refInterface === theme;
      button.classList.toggle('active', active);
      const em = button.querySelector('em');
      if (em) em.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  window.applyReferenceInterface = function(name, shouldSave=true){
    const theme = normalize(name);
    document.body.dataset.refInterface = theme;
    ensureLink().href = `/themes/${theme}.css?v=19`;
    refreshButtons(theme);
    if (shouldSave) save(theme);
  };

  window.loadReferenceAppearance = function(){
    const saved = read();
    window.applyReferenceInterface(saved.interface || 'control', false);
    if (typeof toggleReferenceGlow === 'function') toggleReferenceGlow(saved.glow !== false, false);
    if (typeof toggleReferenceMotion === 'function') toggleReferenceMotion(saved.motion !== false, false);
    if (typeof toggleReferenceCompact === 'function') toggleReferenceCompact(saved.compact === true, false);
  };

  window.resetReferenceAppearance = function(){
    localStorage.removeItem(KEY);
    window.applyReferenceInterface('control', true);
  };

  document.addEventListener('DOMContentLoaded', window.loadReferenceAppearance);
  window.addEventListener('pageshow', window.loadReferenceAppearance);
})();
