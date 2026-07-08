// ═══════════════════════════════════════════════════════════════════════════
// 🩸 LES 30 COFFRES DE L'ENTITÉ — logique du jeu
// ═══════════════════════════════════════════════════════════════════════════
// - 30 coffres par saison, contenu mélangé aléatoirement
// - Tiers : legendary / epic / positive / challenge / cursed / fake
// - Coffre sécurisé : 1 choix + 1 déplacement max par saison
// - Twists cachés sur certains coffres (jackpot déplacé, malédiction, etc.)
// - "Valeur du Brouillard" : plus le streamer gagne, plus les coffres restants
//   risquent de se dégrader — et inversement.
// ═══════════════════════════════════════════════════════════════════════════

const db = require('./database');

// ─── Pools de contenu ─────────────────────────────────────────────────────────

const POOLS = {
  legendary: [
    { label: '💶 100€ CASH !', money: 100 },
    { label: '🎮 Un jeu à 60€ au choix', money: 60 },
    { label: '✨ Skin DBD rare offert', money: 15 },
    { label: '🎁 DOUBLE GIVEAWAY pour le chat', money: 0 },
  ],
  epic: [
    { label: '💶 20€ CASH', money: 20 },
    { label: '📀 DLC DBD au choix', money: 10 },
    { label: '🎮 Jeu Steam offert', money: 20 },
    { label: '🪙 50 000 points pour le chat (giveaway)', money: 0 },
  ],
  positive: [
    { label: '💶 5€', money: 5 },
    { label: '💶 10€', money: 10 },
    { label: '🗺️ Tu choisis la map', money: 0 },
    { label: '👹 Tu choisis le tueur', money: 0 },
    { label: '🧰 Objet Ultra Rare gratuit', money: 0 },
    { label: '✖️2 Double récompense sur la prochaine game', money: 0 },
    { label: '🪙 10 000 points pour le chat (giveaway)', money: 0 },
    { label: '🛡️ Immunité : annule ton prochain malus', money: 0 },
  ],
  challenge: [
    { label: '🎯 DÉFI : Fais 2 Head On cette game (+10€ si réussi)', money: 10 },
    { label: '🎯 DÉFI : Flash Save (+10€ si réussi)', money: 10 },
    { label: '🎯 DÉFI : Finis un générateur seul (+5€ si réussi)', money: 5 },
    { label: '🎯 DÉFI : Escape cette game (+10€ si réussi)', money: 10 },
    { label: '🎯 DÉFI : Fais tomber 4 palettes (+5€ si réussi)', money: 5 },
    { label: '🎯 DÉFI : Sauve 2 survivants du crochet (+5€ si réussi)', money: 5 },
    { label: '🎯 DÉFI : Aveugle le tueur 2 fois (+10€ si réussi)', money: 10 },
    { label: '🎯 DÉFI : Répare 3 générateurs différents (+5€ si réussi)', money: 5 },
  ],
  cursed: [
    { label: '💀 Build 100% aléatoire la prochaine game', money: 0 },
    { label: '💀 Sans objet la prochaine game', money: 0 },
    { label: '💀 Sans perk la prochaine game', money: 0 },
    { label: '💀 Sensibilité caméra inversée 1 game', money: 0 },
    { label: '💀 Interdit de courir pendant 60 secondes', money: 0 },
    { label: '💀 Tu ne répares QUE le même générateur', money: 0 },
    { label: '💀 Le chat choisit ton build', money: 0 },
    { label: '💀 Sans offrande pendant 2 games', money: 0 },
  ],
  fake: [
    { label: '🕳️ Le coffre était VIDE… Le Brouillard se moque de toi.', money: 0 },
    { label: '☠️ CATASTROPHE : double malus — le chat choisit ton build ET sans objet', money: 0 },
  ],
};

// Répartition d'une saison de 30 coffres
const DISTRIBUTION = [
  { tier: 'legendary', count: 1,  fog: 80 },
  { tier: 'epic',      count: 3,  fog: 50 },
  { tier: 'positive',  count: 8,  fog: 25 },
  { tier: 'challenge', count: 8,  fog: 0  },
  { tier: 'cursed',    count: 8,  fog: -30 },
  { tier: 'fake',      count: 2,  fog: -60 },
];

// Twists cachés attachés à ~4 coffres (en plus de leur contenu)
const TWISTS = [
  'move_jackpot',   // L'Entité déplace le Jackpot vers un autre coffre fermé
  'upgrade_3',      // 3 coffres fermés s'améliorent d'un tier
  'curse_next_3',   // Les 3 prochains coffres ouverts ont 30% de chance de se dégrader
  'bless_next',     // Le prochain coffre ouvert est garanti positif ou mieux
];

const TIER_ORDER = ['fake', 'cursed', 'challenge', 'positive', 'epic', 'legendary'];
const TIER_META = {
  legendary: { emoji: '🟣', name: 'LÉGENDAIRE' },
  epic:      { emoji: '🟡', name: 'ÉPIQUE' },
  positive:  { emoji: '🔵', name: 'BONUS' },
  challenge: { emoji: '🟠', name: 'DÉFI' },
  cursed:    { emoji: '🔴', name: 'MAUDIT' },
  fake:      { emoji: '⚫', name: 'PIÈGE' },
};

// État runtime des malédictions/bénédictions actives (par saison)
const runtimeEffects = { curseCharges: 0, blessCharge: false };

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Génération d'une saison ──────────────────────────────────────────────────

async function newSeason() {
  const contents = [];
  for (const d of DISTRIBUTION) {
    const poolShuffled = shuffle(POOLS[d.tier]);
    for (let i = 0; i < d.count; i++) {
      const item = poolShuffled[i % poolShuffled.length];
      contents.push({ tier: d.tier, label: item.label, money: item.money, fogValue: d.fog });
    }
  }
  // Mélanger et assigner les numéros 1-30
  const shuffled = shuffle(contents).map((c, i) => ({ ...c, number: i + 1 }));

  // Attacher 4 twists à des coffres au hasard (jamais sur le légendaire pour move_jackpot)
  const twistTargets = shuffle(shuffled.filter(c => c.tier !== 'legendary')).slice(0, 4);
  const twistsShuffled = shuffle(TWISTS);
  twistTargets.forEach((c, i) => { c.twist = twistsShuffled[i]; });

  runtimeEffects.curseCharges = 0;
  runtimeEffects.blessCharge = false;

  return db.createChestSeason(shuffled);
}

// ─── Mutations de coffres (fog + twists) ─────────────────────────────────────

async function mutateChest(chest, direction) {
  // direction: +1 améliore d'un tier, -1 dégrade
  const idx = TIER_ORDER.indexOf(chest.tier);
  const newIdx = Math.min(TIER_ORDER.length - 1, Math.max(0, idx + direction));
  if (newIdx === idx) return false;
  const newTier = TIER_ORDER[newIdx];
  const item = pick(POOLS[newTier]);
  const fog = DISTRIBUTION.find(d => d.tier === newTier)?.fog || 0;
  await db.updateChestContent(chest.id, newTier, item.label, item.money, fog);
  return true;
}

// ─── Ouverture d'un coffre ────────────────────────────────────────────────────

async function openChest(number, via) {
  const season = await db.getActiveChestSeason();
  if (!season) return { error: 'Aucune saison active — lance une nouvelle saison depuis le panel.' };

  const chest = await db.getChest(season.id, number);
  if (!chest) return { error: `Le coffre ${number} n'existe pas (1-30).` };
  if (chest.opened) return { error: `Le coffre ${number} a déjà été ouvert !` };
  if (chest.secured) return { error: `Le coffre ${number} est SÉCURISÉ 🔒 — retire la sécurité d'abord (panel).` };

  const preOpenChests = await db.getChests(season.id);
  const isLastChest = preOpenChests.filter(c => !c.opened).length === 1;

  let finalChest = { ...chest };
  const events = [];
  let victoryDoubled = false;

  // Bénédiction active : garantit positif ou mieux
  if (runtimeEffects.blessCharge) {
    runtimeEffects.blessCharge = false;
    if (TIER_ORDER.indexOf(finalChest.tier) < TIER_ORDER.indexOf('positive')) {
      const item = pick(POOLS.positive);
      await db.updateChestContent(chest.id, 'positive', item.label, item.money, 25);
      finalChest = { ...finalChest, tier: 'positive', label: item.label, money: item.money };
      events.push('🕯️ La Bénédiction du Brouillard a purifié ce coffre !');
    }
  }
  // Malédiction active : 30% de dégradation
  else if (runtimeEffects.curseCharges > 0) {
    runtimeEffects.curseCharges--;
    if (Math.random() < 0.3) {
      const idx = TIER_ORDER.indexOf(finalChest.tier);
      if (idx > 0) {
        const newTier = TIER_ORDER[Math.max(0, idx - 1)];
        const item = pick(POOLS[newTier]);
        await db.updateChestContent(chest.id, newTier, item.label, item.money, DISTRIBUTION.find(d=>d.tier===newTier)?.fog||0);
        finalChest = { ...finalChest, tier: newTier, label: item.label, money: item.money };
        events.push('☠️ La Malédiction a corrompu ce coffre au moment de l\u2019ouvrir…');
      }
    }
  }

  // Bonus de victoire : doublé si une victoire a été marquée manuellement, OU
  // automatiquement si ce coffre protégé se trouve être le tout dernier de la saison
  // (mécaniquement, ça ne peut être que lui à ce stade).
  const autoVictory = isLastChest && season.protected_number === number;
  if (season.protected_number === number && (season.victory_pending || autoVictory)) {
    finalChest = { ...finalChest, money: (finalChest.money || 0) * 2 };
    victoryDoubled = true;
    events.push(autoVictory && !season.victory_pending
      ? '🏆 SAISON TERMINÉE ! Le coffre protégé, ouvert en dernier, voit son contenu DOUBLÉ automatiquement !'
      : '🏆 VICTOIRE ! Le contenu de ce coffre protégé est DOUBLÉ !');
    await db.setVictoryPending(season.id, false);
    await db.updateChestContent(chest.id, finalChest.tier, finalChest.label, finalChest.money, finalChest.fog_value);
  }

  // Marquer ouvert
  await db.markChestOpened(chest.id, via, '');
  await db.updateFogMeter(season.id, finalChest.fog_value);

  // Appliquer le twist caché du coffre
  const allChests = await db.getChests(season.id);
  const closedUnsecured = allChests.filter(c => !c.opened && !c.secured && c.id !== chest.id);

  // S'il ne reste plus qu'un seul coffre fermé et qu'il est sécurisé, c'est forcément
  // le coffre protégé — sa sécurité est levée automatiquement pour permettre son ouverture finale.
  const stillUnopened = allChests.filter(c => !c.opened);
  if (stillUnopened.length === 1 && stillUnopened[0].secured) {
    await db.clearAllSecured(season.id);
    events.push(`🔓 Il ne reste que le coffre ${stillUnopened[0].number} — sa sécurité est levée automatiquement pour l'ouverture finale !`);
  }

  if (chest.twist === 'move_jackpot') {
    const jackpot = allChests.find(c => c.tier === 'legendary' && !c.opened);
    if (jackpot && closedUnsecured.length > 1) {
      const target = pick(closedUnsecured.filter(c => c.id !== jackpot.id));
      if (target) {
        // Échanger les contenus
        await db.updateChestContent(target.id, jackpot.tier, jackpot.label, jackpot.money, jackpot.fog_value);
        await db.updateChestContent(jackpot.id, target.tier, target.label, target.money, target.fog_value);
        events.push('🩸 L\u2019ENTITÉ A DÉPLACÉ LE JACKPOT… mais où ?');
      }
    }
  } else if (chest.twist === 'upgrade_3') {
    const targets = shuffle(closedUnsecured).slice(0, 3);
    for (const t of targets) await mutateChest(t, +1);
    if (targets.length) events.push(`🎁 ${targets.length} coffres mystères viennent de s\u2019AMÉLIORER !`);
  } else if (chest.twist === 'curse_next_3') {
    runtimeEffects.curseCharges = 3;
    events.push('☠️ MALÉDICTION : les 3 prochains coffres risquent de se corrompre (30%)…');
  } else if (chest.twist === 'bless_next') {
    runtimeEffects.blessCharge = true;
    events.push('🕯️ BÉNÉDICTION : le prochain coffre sera forcément positif ou mieux !');
  }

  // Valeur du Brouillard : le destin s'équilibre
  const updatedSeason = await db.getActiveChestSeason();
  const fog = updatedSeason?.fog_meter || 0;
  if (fog > 60 && closedUnsecured.length && Math.random() < 0.25) {
    const t = pick(closedUnsecured);
    if (await mutateChest(t, -1)) events.push('🌫️ Le Brouillard s\u2019épaissit… un coffre s\u2019est DÉGRADÉ quelque part.');
  } else if (fog < -60 && closedUnsecured.length && Math.random() < 0.25) {
    const t = pick(closedUnsecured);
    if (await mutateChest(t, +1)) events.push('✨ Le Brouillard a pitié… un coffre s\u2019est AMÉLIORÉ quelque part.');
  }

  // Fin de saison ?
  const remaining = allChests.filter(c => !c.opened && c.id !== chest.id).length;
  let seasonEnd = null;
  if (remaining === 0) {
    await db.endChestSeason(season.id);
    seasonEnd = await getSeasonStats(season.id);
  }

  const meta = TIER_META[finalChest.tier];
  return {
    success: true,
    number,
    tier: finalChest.tier,
    tierEmoji: meta.emoji,
    tierName: meta.name,
    label: finalChest.label,
    money: finalChest.money,
    moneyDoubled: victoryDoubled,
    events,
    remaining,
    seasonEnd,
    chestId: chest.id,
  };
}

// ─── Coffre sécurisé ──────────────────────────────────────────────────────────

async function secureChest(number) {
  const season = await db.getActiveChestSeason();
  if (!season) return { error: 'Aucune saison active.' };

  const chest = await db.getChest(season.id, number);
  if (!chest) return { error: 'Coffre inexistant.' };
  if (chest.opened) return { error: 'Ce coffre est déjà ouvert.' };

  const chests = await db.getChests(season.id);
  const currentSecured = chests.find(c => c.secured);

  // Toute première sécurisation de la saison : gratuite, ne consomme rien.
  // (clearAllSecured en sécurité, au cas où une saison en cours aurait déjà un coffre
  // sécurisé avant cette mise à jour, sans que ever_secured soit encore à 1)
  if (!season.ever_secured) {
    if (currentSecured) await db.clearAllSecured(season.id);
    await db.setChestSecured(season.id, number, true);
    await db.markEverSecured(season.id);
    await db.setProtectedNumber(season.id, number);
    return { success: true, moved: false, to: number, firstTime: true };
  }

  if (currentSecured && currentSecured.number === number) {
    return { error: 'Ce coffre est déjà le coffre sécurisé.' };
  }

  // Après la première sécurisation (même si elle a été retirée depuis), il ne reste
  // qu'UN SEUL changement possible pour le reste de la saison — que ce soit un
  // déplacement direct ou un retrait suivi d'une nouvelle sécurisation.
  if (season.secure_moves_used >= 1) {
    return { error: 'Tu as déjà utilisé ton unique changement de sécurité — plus aucune modification possible jusqu\u2019à la prochaine saison !' };
  }

  if (currentSecured) await db.clearAllSecured(season.id);
  await db.setChestSecured(season.id, number, true);
  await db.incrementSecureMoves(season.id);
  await db.setProtectedNumber(season.id, number);
  return { success: true, moved: true, from: currentSecured ? currentSecured.number : null, to: number, lastChange: true };
}

async function unsecureChest() {
  const season = await db.getActiveChestSeason();
  if (!season) return { error: 'Aucune saison active.' };
  await db.clearAllSecured(season.id);
  return { success: true };
}

// ─── Bonus de victoire (x2 sur le coffre sécurisé) ────────────────────────────

async function markVictory() {
  const season = await db.getActiveChestSeason();
  if (!season) return { error: 'Aucune saison active.' };
  if (!season.protected_number) return { error: 'Aucun coffre sécurisé cette saison — rien à doubler.' };
  await db.setVictoryPending(season.id, true);
  return { success: true, protectedNumber: season.protected_number };
}

async function clearVictory() {
  const season = await db.getActiveChestSeason();
  if (!season) return { error: 'Aucune saison active.' };
  await db.setVictoryPending(season.id, false);
  return { success: true };
}

// ─── État public (sans révéler le contenu des coffres fermés) ────────────────

async function getPublicState() {
  const season = await db.getActiveChestSeason();
  if (!season) return { season: null, chests: [] };
  const chests = await db.getChests(season.id);
  return {
    season: {
      num: season.season_num,
      fogMeter: season.fog_meter,
      secureMoves: season.secure_moves_used,
      everSecured: !!season.ever_secured,
      protectedNumber: season.protected_number || null,
      victoryPending: !!season.victory_pending,
      startedAt: season.started_at,
    },
    chests: chests.map(c => c.opened ? {
      number: c.number, opened: true, secured: false,
      tier: c.tier, emoji: TIER_META[c.tier]?.emoji, label: c.label, money: c.money,
      openedAt: c.opened_at, challengeDone: c.challenge_done,
    } : {
      number: c.number, opened: false, secured: !!c.secured,
    }),
  };
}

// ─── Stats de saison ──────────────────────────────────────────────────────────

async function getSeasonStats(seasonId) {
  const chests = await db.getChests(seasonId);
  const opened = chests.filter(c => c.opened);
  const bonuses = opened.filter(c => ['positive','epic','legendary'].includes(c.tier)).length;
  const maluses = opened.filter(c => ['cursed','fake'].includes(c.tier)).length;
  const jackpots = opened.filter(c => c.tier === 'legendary').length;
  const challenges = opened.filter(c => c.tier === 'challenge');
  const challengesDone = challenges.filter(c => c.challenge_done === 1).length;
  // L'argent : bonus directs + défis réussis
  const money = opened.reduce((sum, c) => {
    if (['positive','epic','legendary'].includes(c.tier)) return sum + (c.money || 0);
    if (c.tier === 'challenge' && c.challenge_done === 1) return sum + (c.money || 0);
    return sum;
  }, 0);

  return { bonuses, maluses, jackpots, challengesTotal: challenges.length, challengesDone, money, totalOpened: opened.length };
}

module.exports = { newSeason, openChest, secureChest, unsecureChest, markVictory, clearVictory, getPublicState, getSeasonStats, TIER_META };
