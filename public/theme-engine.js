(() => {
  'use strict';

  const BASE_STORAGE_KEY = 'elbot_theme_v3';
  const LEGACY_KEYS = ['elbot_theme_v2','elbot_ref_appearance_v1','elbot_ref_appearance'];

  const THEMES = new Set([
    'control','dbd','obs','vision','neon','elite','steam','riot',
    'midnight','ocean','sunset','forest','minimal'
  ]);
  const SIDEBAR_MODES = new Set(['solid','theme','transparent','glass']);

  const LEGACY_NAMES = {classic:'control',liquid:'control',aurora:'vision'};

  const PRESETS = {
    kick:{primary:'#53fc18',secondary:'#168cff'},
    ocean:{primary:'#00d4ff',secondary:'#0066ff'},
    violet:{primary:'#a855f7',secondary:'#ec4899'},
    dbd:{primary:'#ef1b32',secondary:'#ff7a18'},
    sunset:{primary:'#ff7a18',secondary:'#ff2d95'},
    gold:{primary:'#f7c948',secondary:'#fff1a8'}
  };

  const DEFAULTS = {
    theme:'control',
    backgroundVisibility:100,
    panelOpacity:92,
    primaryColor:'#28ff66',
    secondaryColor:'#1874ff',
    sidebarMode:'glass',
    sidebarWallpaper:true,
    topbarTransparent:false,
    glassBlur:16,
    reflection:45,
    glow:true,
    motion:true,
    compact:false
  };

  function streamerSlug(){
    const pathSlug = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
    return String(window.CURRENT_STREAMER_SLUG || pathSlug || 'default').toLowerCase();
  }

  function storageKey(){ return `${BASE_STORAGE_KEY}:${streamerSlug()}`; }

  function clamp(value,min,max,fallback){
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max,Math.max(min,number)) : fallback;
  }

  function normalizeTheme(value){
    const mapped = LEGACY_NAMES[value] || value;
    return THEMES.has(mapped) ? mapped : DEFAULTS.theme;
  }

  function normalizeHex(value,fallback){
    const hex = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
  }

  function hexToRgb(hex){
    const clean = normalizeHex(hex,'#000000').slice(1);
    return [
      parseInt(clean.slice(0,2),16),
      parseInt(clean.slice(2,4),16),
      parseInt(clean.slice(4,6),16)
    ];
  }

  function readRaw(key){
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function readState(){
    const current = readRaw(storageKey());
    if (current) return {...DEFAULTS,...current};

    for (const key of LEGACY_KEYS){
      const old = readRaw(key);
      if (!old) continue;
      return {
        ...DEFAULTS,
        theme:normalizeTheme(old.theme || old.interface),
        backgroundVisibility:old.backgroundVisibility ?? old.backgroundIntensity ?? 100,
        panelOpacity:old.panelOpacity ?? 92,
        primaryColor:old.primaryColor || DEFAULTS.primaryColor,
        secondaryColor:old.secondaryColor || DEFAULTS.secondaryColor,
        glow:old.glow !== false,
        motion:old.motion !== false,
        compact:old.compact === true
      };
    }
    return {...DEFAULTS};
  }

  function saveState(patch){
    const next = {...readState(),...patch};
    localStorage.setItem(storageKey(),JSON.stringify(next));
    return next;
  }

  function setRootVariable(name,value){
    document.documentElement.style.setProperty(name,value);
  }

  function setOutput(inputId,outputId,value,label){
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (input) input.value = String(value);
    if (output) output.textContent = label;
  }

  function refreshThemeButtons(theme){
    document.querySelectorAll('[data-ref-interface]').forEach(button => {
      const active = button.dataset.refInterface === theme;
      button.classList.toggle('active',active);
      const action = button.querySelector('em');
      if (action) action.textContent = active ? 'Actif' : 'Appliquer';
    });
  }

  function refreshSidebarButtons(mode){
    document.querySelectorAll('[data-sidebar-mode]').forEach(button => {
      button.classList.toggle('active',button.dataset.sidebarMode === mode);
    });
  }

  function refreshColorPresetButtons(primary,secondary){
    document.querySelectorAll('[data-color-preset]').forEach(button => {
      const preset = PRESETS[button.dataset.colorPreset];
      const active = preset &&
        preset.primary.toLowerCase() === primary.toLowerCase() &&
        preset.secondary.toLowerCase() === secondary.toLowerCase();
      button.classList.toggle('active',active);
    });
  }

  function applyTheme(value,save=true){
    const theme = normalizeTheme(value);

    document.body.removeAttribute('data-ref-interface');
    document.body.removeAttribute('data-ref-wallpaper');
    document.body.removeAttribute('data-ref-bg');
    document.documentElement.dataset.panelTheme = theme;

    refreshThemeButtons(theme);
    if (save) saveState({theme});
  }

  function applyBackgroundVisibility(value,save=true){
    const visibility = clamp(value,35,100,100);
    const alpha = 0.08 + ((100 - visibility) / 65) * 0.54;
    setRootVariable('--panel-overlay-alpha',alpha.toFixed(3));
    setOutput('ref-bg-intensity-range','ref-bg-intensity-value',visibility,`${visibility}%`);
    if (save) saveState({backgroundVisibility:visibility});
  }

  function applyPanelOpacity(value,save=true){
    const opacity = clamp(value,65,100,92);
    setRootVariable('--panel-surface-opacity',`${opacity}%`);
    setRootVariable('--elbot-sidebar-opacity',`${opacity}%`);
    setOutput('ref-panel-opacity-range','ref-panel-opacity-value',opacity,`${opacity}%`);
    if (save) saveState({panelOpacity:opacity});
  }

  function applyColors(primary,secondary,save=true){
    const p = normalizeHex(primary,DEFAULTS.primaryColor);
    const s = normalizeHex(secondary,DEFAULTS.secondaryColor);
    const [pr,pg,pb] = hexToRgb(p);
    const [sr,sg,sb] = hexToRgb(s);

    setRootVariable('--elbot-primary',p);
    setRootVariable('--elbot-primary-rgb',`${pr} ${pg} ${pb}`);
    setRootVariable('--elbot-secondary',s);
    setRootVariable('--elbot-secondary-rgb',`${sr} ${sg} ${sb}`);

    const pInput = document.getElementById('ref-primary-color');
    const sInput = document.getElementById('ref-secondary-color');
    const pOutput = document.getElementById('ref-primary-color-value');
    const sOutput = document.getElementById('ref-secondary-color-value');
    if (pInput) pInput.value = p;
    if (sInput) sInput.value = s;
    if (pOutput) pOutput.textContent = p.toUpperCase();
    if (sOutput) sOutput.textContent = s.toUpperCase();

    refreshColorPresetButtons(p,s);
    if (save) saveState({primaryColor:p,secondaryColor:s});
  }

  function setPrimaryColor(value,save=true){
    const state = readState();
    applyColors(value,state.secondaryColor,save);
  }

  function setSecondaryColor(value,save=true){
    const state = readState();
    applyColors(state.primaryColor,value,save);
  }

  function applyColorPreset(name,save=true){
    const preset = PRESETS[name] || PRESETS.kick;
    applyColors(preset.primary,preset.secondary,save);
  }

  function setSidebarMode(value,save=true){
    const mode = SIDEBAR_MODES.has(value) ? value : DEFAULTS.sidebarMode;
    document.documentElement.dataset.sidebarMode = mode;
    refreshSidebarButtons(mode);
    if (save) saveState({sidebarMode:mode});
  }

  function setSidebarWallpaper(enabled,save=true){
    const active = !!enabled;
    document.documentElement.dataset.sidebarWallpaper = String(active);
    const input = document.getElementById('ref-sidebar-wallpaper-toggle');
    if (input) input.checked = active;
    if (save) saveState({sidebarWallpaper:active});
  }

  function setTopbarTransparent(enabled,save=true){
    const active = !!enabled;
    document.documentElement.dataset.topbarTransparent = String(active);
    const input = document.getElementById('ref-topbar-transparent-toggle');
    if (input) input.checked = active;
    if (save) saveState({topbarTransparent:active});
  }

  function setGlassBlur(value,save=true){
    const blur = clamp(value,0,36,16);
    setRootVariable('--elbot-glass-blur',`${blur}px`);
    setOutput('ref-glass-blur-range','ref-glass-blur-value',blur,`${blur}px`);
    if (save) saveState({glassBlur:blur});
  }

  function setReflection(value,save=true){
    const reflection = clamp(value,0,100,45);
    setRootVariable('--elbot-reflection-opacity',(reflection / 100).toFixed(2));
    setOutput('ref-reflection-range','ref-reflection-value',reflection,`${reflection}%`);
    if (save) saveState({reflection});
  }

  function setGlow(enabled,save=true){
    const active = !!enabled;
    document.documentElement.dataset.elbotGlow = String(active);
    document.body.classList.toggle('ref-no-glow',!active);
    const input = document.getElementById('ref-glow-toggle');
    if (input) input.checked = active;
    if (save) saveState({glow:active});
  }

  function setMotion(enabled,save=true){
    const active = !!enabled;
    document.body.classList.toggle('ref-no-motion',!active);
    const input = document.getElementById('ref-motion-toggle');
    if (input) input.checked = active;
    if (save) saveState({motion:active});
  }

  function setCompact(enabled,save=true){
    const active = !!enabled;
    document.body.classList.toggle('ref-compact',active);
    const input = document.getElementById('ref-compact-toggle');
    if (input) input.checked = active;
    if (save) saveState({compact:active});
  }

  function loadAppearance(){
    const state = readState();
    applyTheme(state.theme,false);
    applyBackgroundVisibility(state.backgroundVisibility,false);
    applyPanelOpacity(state.panelOpacity,false);
    applyColors(state.primaryColor,state.secondaryColor,false);
    setSidebarMode(state.sidebarMode,false);
    setSidebarWallpaper(state.sidebarWallpaper,false);
    setTopbarTransparent(state.topbarTransparent,false);
    setGlassBlur(state.glassBlur,false);
    setReflection(state.reflection,false);
    setGlow(state.glow,false);
    setMotion(state.motion,false);
    setCompact(state.compact,false);
  }

  window.applyReferenceInterface = applyTheme;
  window.setReferenceBackgroundIntensity = applyBackgroundVisibility;
  window.setReferencePanelOpacity = applyPanelOpacity;

  window.setReferencePrimaryColor = setPrimaryColor;
  window.setReferenceSecondaryColor = setSecondaryColor;
  window.applyReferenceColorPreset = applyColorPreset;

  /* Compatibilité avec les anciens boutons couleur. */
  window.applyReferenceTheme = name => {
    const map = {
      blue:['#168cff','#00d4ff'],
      violet:['#a855f7','#ec4899'],
      cyan:['#00d4ff','#14b8a6'],
      red:['#ef1b32','#ff7a18'],
      green:['#28ff66','#00d4ff'],
      orange:['#ff7a18','#ff2d95']
    };
    const colors = map[name] || map.green;
    applyColors(colors[0],colors[1],true);
  };

  window.setReferenceSidebarMode = setSidebarMode;
  window.toggleReferenceSidebarWallpaper = setSidebarWallpaper;
  window.toggleReferenceTopbarTransparent = setTopbarTransparent;
  window.setReferenceGlassBlur = setGlassBlur;
  window.setReferenceReflection = setReflection;

  window.toggleReferenceGlow = setGlow;
  window.toggleReferenceMotion = setMotion;
  window.toggleReferenceCompact = setCompact;

  window.applyReferenceWallpaper = () => {};
  window.applyReferenceBackground = () => {};
  window.loadReferenceAppearance = loadAppearance;

  window.resetReferenceAppearance = () => {
    localStorage.removeItem(storageKey());
    LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(storageKey(),JSON.stringify(DEFAULTS));
    loadAppearance();
  };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded',loadAppearance,{once:true});
  } else {
    loadAppearance();
  }
  window.addEventListener('pageshow',loadAppearance);
})();
