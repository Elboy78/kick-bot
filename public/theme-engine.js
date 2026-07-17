
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
    const current = read();
    localStorage.setItem(KEY, JSON.stringify({...current,...patch}));
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

    document.documentElement.style.setProperty(
      '--elbot-background-percent',
      String(intensity)
    );

    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');

    if (range) range.value = String(intensity);
    if (output) output.textContent = intensity + '%';
    if (shouldSave) write({backgroundIntensity:intensity});
  };

  window.applyReferenceInterface = function(name, shouldSave=true){
    const theme = normalize(name);

    document.documentElement.dataset.refInterface = theme;
    document.body.dataset.refInterface = theme;

    refreshButtons(theme);

    if (shouldSave) {
      write({interface:theme});
    }
  };

  window.loadReferenceAppearance = function(){
    const saved = read();

    window.applyReferenceInterface(saved.interface || 'control', false);
    window.setReferenceBackgroundIntensity(
      saved.backgroundIntensity == null ? 100 : saved.backgroundIntensity,
      false
    );

    if (typeof toggleReferenceGlow === 'function') {
      toggleReferenceGlow(saved.glow !== false, false);
    }
    if (typeof toggleReferenceMotion === 'function') {
      toggleReferenceMotion(saved.motion !== false, false);
    }
    if (typeof toggleReferenceCompact === 'function') {
      toggleReferenceCompact(saved.compact === true, false);
    }
  };

  window.resetReferenceAppearance = function(){
    localStorage.removeItem(KEY);
    window.applyReferenceInterface('control', false);
    window.setReferenceBackgroundIntensity(100, false);
  };

  document.addEventListener('DOMContentLoaded', window.loadReferenceAppearance);
  window.addEventListener('pageshow', window.loadReferenceAppearance);
})();
