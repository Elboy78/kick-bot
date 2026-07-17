(function(){
  const THEMES = ['control','dbd','obs','vision','neon','elite','steam','riot','midnight','ocean','sunset','forest','minimal'];
  const KEY = 'elbot_ref_appearance_v1';
  const legacy = {classic:'control',liquid:'control',aurora:'vision'};
  let themeLink = null;

  function normalize(name){
    const value = legacy[name] || name;
    return THEMES.includes(value) ? value : 'control';
  }

  function read(){
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch(_) { return {}; }
  }

  function write(patch){
    const current = read();
    localStorage.setItem(KEY, JSON.stringify({...current,...patch}));
  }


  function ensureWallpaperLayer(){
    let layer = document.getElementById('elbot-theme-wallpaper');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'elbot-theme-wallpaper';
      layer.setAttribute('aria-hidden','true');
      document.body.prepend(layer);
    }
    return layer;
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
      const action = button.querySelector('em');
      if (action) action.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  window.setReferenceBackgroundIntensity = function(value, shouldSave=true){
    const intensity = Math.max(20, Math.min(100, Number(value) || 100));
    document.documentElement.style.setProperty('--wallpaper-opacity', intensity / 100);
    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');
    if (range) range.value = String(intensity);
    if (output) output.textContent = intensity + '%';
    if (shouldSave) write({backgroundIntensity:intensity});
  };

  window.applyReferenceInterface = function(name, shouldSave=true){
    const theme = normalize(name);
    ensureWallpaperLayer();
    document.body.dataset.refInterface = theme;
    ensureLink().href = `/themes/${theme}.css?v=22`;
    refreshButtons(theme);
    if (shouldSave) write({interface:theme});
  };

  window.loadReferenceAppearance = function(){
    const saved = read();
    window.applyReferenceInterface(saved.interface || 'control', false);
    window.setReferenceBackgroundIntensity(saved.backgroundIntensity || 100, false);
    if (typeof toggleReferenceGlow === 'function') toggleReferenceGlow(saved.glow !== false, false);
    if (typeof toggleReferenceMotion === 'function') toggleReferenceMotion(saved.motion !== false, false);
    if (typeof toggleReferenceCompact === 'function') toggleReferenceCompact(saved.compact === true, false);
  };

  window.resetReferenceAppearance = function(){
    localStorage.removeItem(KEY);
    window.applyReferenceInterface('control', false);
    window.setReferenceBackgroundIntensity(100, false);
  };

  document.addEventListener('DOMContentLoaded', window.loadReferenceAppearance);
  window.addEventListener('pageshow', window.loadReferenceAppearance);
})();
