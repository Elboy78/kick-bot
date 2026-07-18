
(function(){
  const THEMES = [
    'control','dbd','obs','vision','neon','elite','steam','riot',
    'midnight','ocean','sunset','forest','minimal'
  ];
  const KEY = 'elbot_ref_appearance_v1';
  const legacy = {classic:'control',liquid:'control',aurora:'vision'};

  function normalize(name){
    const value = legacy[name] || name;
    return THEMES.includes(value) ? value : 'control';
  }

  function read(){
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function write(patch){
    localStorage.setItem(KEY, JSON.stringify({...read(),...patch}));
  }

  function wallpaperUrl(theme){
    return `/assets/themes/${theme}.webp?v=26`;
  }

  function applyWallpaperFile(theme){
    const url = wallpaperUrl(theme);
    const probe = new Image();

    probe.onload = function(){
      const cssValue = `url("${url}")`;
      document.documentElement.style.setProperty('--elbot-final-wallpaper', cssValue);
      document.body.style.setProperty('--elbot-final-wallpaper', cssValue);
    };

    probe.onerror = function(){
      console.error('[ElBot Theme] Fond introuvable :', url);
    };

    probe.src = url;
  }

  function refreshButtons(theme){
    document.querySelectorAll('[data-ref-interface]').forEach(button => {
      const active = button.dataset.refInterface === theme;
      button.classList.toggle('active', active);
      const action = button.querySelector('em');
      if (action) action.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  window.setReferenceBackgroundIntensity = function(value, shouldSave=true){
    const intensity = Math.max(35, Math.min(100, Number(value) || 100));
    document.documentElement.style.setProperty('--elbot-background-percent', String(intensity));

    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');
    if (range) range.value = String(intensity);
    if (output) output.textContent = intensity + '%';

    if (shouldSave) write({backgroundIntensity:intensity});
  };

  window.setReferencePanelOpacity = function(value, shouldSave=true){
    const opacity = Math.max(65, Math.min(100, Number(value) || 92));
    document.documentElement.style.setProperty('--elbot-panel-opacity', opacity + '%');

    const range = document.getElementById('ref-panel-opacity-range');
    const output = document.getElementById('ref-panel-opacity-value');
    if (range) range.value = String(opacity);
    if (output) output.textContent = opacity + '%';

    if (shouldSave) write({panelOpacity:opacity});
  };

  window.applyReferenceInterface = function(name, shouldSave=true){
    const theme = normalize(name);

    document.documentElement.dataset.refInterface = theme;
    document.body.dataset.refInterface = theme;
    applyWallpaperFile(theme);
    refreshButtons(theme);

    if (shouldSave) write({interface:theme});
  };

  window.loadReferenceAppearance = function(){
    const saved = read();

    window.applyReferenceInterface(saved.interface || 'control', false);
    window.setReferenceBackgroundIntensity(
      saved.backgroundIntensity == null ? 100 : saved.backgroundIntensity,
      false
    );
    window.setReferencePanelOpacity(
      saved.panelOpacity == null ? 92 : saved.panelOpacity,
      false
    );
  };

  window.resetReferenceAppearance = function(){
    localStorage.removeItem(KEY);
    window.applyReferenceInterface('control', false);
    window.setReferenceBackgroundIntensity(100, false);
    window.setReferencePanelOpacity(92, false);
  };

  document.addEventListener('DOMContentLoaded', window.loadReferenceAppearance);
  window.addEventListener('pageshow', window.loadReferenceAppearance);
})();
