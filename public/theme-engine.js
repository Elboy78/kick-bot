
(function(){
  const THEMES = [
    'control','dbd','obs','vision','neon','elite','steam','riot',
    'midnight','ocean','sunset','forest','minimal'
  ];

  const KEY = 'elbot_ref_appearance_v1';
  const legacy = {classic:'control',liquid:'control',aurora:'vision'};

  const overlays = {
    control:[2,8,20],
    dbd:[0,0,0],
    obs:[4,7,9],
    vision:[225,235,248],
    neon:[2,0,10],
    elite:[0,0,0],
    steam:[4,12,18],
    riot:[10,1,3],
    midnight:[0,5,18],
    ocean:[0,12,28],
    sunset:[38,8,12],
    forest:[0,16,13],
    minimal:[245,247,251]
  };

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

  function refreshButtons(theme){
    document.querySelectorAll('[data-ref-interface]').forEach(button => {
      const active = button.dataset.refInterface === theme;
      button.classList.toggle('active', active);
      const action = button.querySelector('em');
      if (action) action.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  function paintWallpaper(theme){
    const saved = read();
    const intensity = Math.max(
      35,
      Math.min(100, Number(saved.backgroundIntensity ?? 100))
    );

    const darkness = (100 - intensity) / 100 * 0.58;
    const [r,g,b] = overlays[theme] || overlays.control;
    const url = `/assets/themes/${theme}.webp?v=27`;

    const backgroundImage =
      `linear-gradient(rgba(${r},${g},${b},${darkness}),rgba(${r},${g},${b},${darkness})),url("${url}")`;

    document.body.style.setProperty('background-color', '#020817', 'important');
    document.body.style.setProperty('background-image', backgroundImage, 'important');
    document.body.style.setProperty('background-repeat', 'no-repeat', 'important');
    document.body.style.setProperty('background-size', 'cover', 'important');
    document.body.style.setProperty('background-position', 'center center', 'important');
    document.body.style.setProperty('background-attachment', 'fixed', 'important');
    document.body.style.setProperty('min-height', '100vh', 'important');
  }

  window.setReferenceBackgroundIntensity = function(value, shouldSave=true){
    const intensity = Math.max(35, Math.min(100, Number(value) || 100));

    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');
    if (range) range.value = String(intensity);
    if (output) output.textContent = intensity + '%';

    if (shouldSave) write({backgroundIntensity:intensity});

    paintWallpaper(
      normalize(document.body.dataset.refInterface || read().interface || 'control')
    );
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

    if (shouldSave) write({interface:theme});

    paintWallpaper(theme);
    refreshButtons(theme);
  };

  window.loadReferenceAppearance = function(){
    const saved = read();
    const theme = normalize(saved.interface || 'control');

    document.documentElement.dataset.refInterface = theme;
    document.body.dataset.refInterface = theme;

    window.setReferencePanelOpacity(
      saved.panelOpacity == null ? 92 : saved.panelOpacity,
      false
    );

    const intensity = saved.backgroundIntensity == null
      ? 100
      : saved.backgroundIntensity;

    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');
    if (range) range.value = String(intensity);
    if (output) output.textContent = intensity + '%';

    paintWallpaper(theme);
    refreshButtons(theme);
  };

  window.resetReferenceAppearance = function(){
    localStorage.removeItem(KEY);
    window.applyReferenceInterface('control', false);
    window.setReferencePanelOpacity(92, false);
    window.setReferenceBackgroundIntensity(100, false);
  };

  document.addEventListener('DOMContentLoaded', window.loadReferenceAppearance);
  window.addEventListener('pageshow', window.loadReferenceAppearance);

  /* Repeint une dernière fois après les anciens scripts du fichier. */
  window.setTimeout(window.loadReferenceAppearance, 120);
  window.setTimeout(window.loadReferenceAppearance, 500);
})();
