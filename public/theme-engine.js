(() => {
  'use strict';

  const STORAGE_KEY = 'elbot_theme_v2';
  const LEGACY_STORAGE_KEY = 'elbot_ref_appearance_v1';

  const THEMES = new Set([
    'control','dbd','obs','vision','neon','elite','steam','riot',
    'midnight','ocean','sunset','forest','minimal'
  ]);

  const LEGACY_NAMES = {
    classic:'control',
    liquid:'control',
    aurora:'vision'
  };

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(max, Math.max(min, number))
      : fallback;
  };

  function normalizeTheme(value){
    const mapped = LEGACY_NAMES[value] || value;
    return THEMES.has(mapped) ? mapped : 'control';
  }

  function readState(){
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (current && typeof current === 'object') return current;
    } catch (_) {}

    /* Migration automatique des anciennes préférences. */
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
      return {
        theme:normalizeTheme(legacy.interface),
        backgroundVisibility:legacy.backgroundIntensity ?? 100,
        panelOpacity:legacy.panelOpacity ?? 92
      };
    } catch (_) {
      return {};
    }
  }

  function saveState(patch){
    const next = {...readState(), ...patch};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function refreshThemeButtons(theme){
    document.querySelectorAll('[data-ref-interface]').forEach(button => {
      const active = button.dataset.refInterface === theme;
      button.classList.toggle('active', active);

      const label = button.querySelector('em');
      if (label) label.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  function applyBackgroundVisibility(value, save = true){
    const visibility = clamp(value, 35, 100, 100);

    /* 100% = voile très léger ; 35% = fond plus discret. */
    const overlayAlpha = 0.08 + ((100 - visibility) / 65) * 0.54;
    document.documentElement.style.setProperty(
      '--panel-overlay-alpha',
      overlayAlpha.toFixed(3)
    );

    const range = document.getElementById('ref-bg-intensity-range');
    const output = document.getElementById('ref-bg-intensity-value');
    if (range) range.value = String(visibility);
    if (output) output.textContent = `${visibility}%`;

    if (save) saveState({backgroundVisibility:visibility});
  }

  function applyPanelOpacity(value, save = true){
    const opacity = clamp(value, 65, 100, 92);

    document.documentElement.style.setProperty(
      '--panel-surface-opacity',
      `${opacity}%`
    );

    const range = document.getElementById('ref-panel-opacity-range');
    const output = document.getElementById('ref-panel-opacity-value');
    if (range) range.value = String(opacity);
    if (output) output.textContent = `${opacity}%`;

    if (save) saveState({panelOpacity:opacity});
  }

  function applyTheme(value, save = true){
    const theme = normalizeTheme(value);

    /*
      Important : on retire les anciens attributs responsables des anciens
      gradients et des anciennes variantes complètes d'interface.
    */
    document.body.removeAttribute('data-ref-interface');
    document.body.removeAttribute('data-ref-wallpaper');
    document.body.removeAttribute('data-ref-bg');

    document.documentElement.dataset.panelTheme = theme;
    refreshThemeButtons(theme);

    if (save) saveState({theme});
  }

  function loadAppearance(){
    const state = readState();

    applyTheme(state.theme || state.interface || 'control', false);
    applyBackgroundVisibility(
      state.backgroundVisibility ?? state.backgroundIntensity ?? 100,
      false
    );
    applyPanelOpacity(state.panelOpacity ?? 92, false);
  }

  /* API publique utilisée par les boutons existants de l'interface. */
  window.applyReferenceInterface = applyTheme;
  window.setReferenceBackgroundIntensity = applyBackgroundVisibility;
  window.setReferencePanelOpacity = applyPanelOpacity;
  window.loadReferenceAppearance = loadAppearance;

  /* Les anciens moteurs de décor ne doivent plus rien repeindre. */
  window.applyReferenceWallpaper = () => {};
  window.applyReferenceBackground = () => {};

  window.resetReferenceAppearance = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);

    applyTheme('control', false);
    applyBackgroundVisibility(100, false);
    applyPanelOpacity(92, false);

    saveState({
      theme:'control',
      backgroundVisibility:100,
      panelOpacity:92
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAppearance, {once:true});
  } else {
    loadAppearance();
  }

  window.addEventListener('pageshow', loadAppearance);
})();
