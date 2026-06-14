/**
 * refresh-token.js — Récupère le token Kick via playwright
 * Usage : node refresh-token.js
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const EMAIL    = process.env.BOT_EMAIL    || '';
const PASSWORD = process.env.BOT_PASSWORD || '';

if (!EMAIL || !PASSWORD) {
  console.error('❌ BOT_EMAIL et BOT_PASSWORD requis dans le .env');
  process.exit(1);
}

(async () => {
  const { chromium } = require('playwright');

  console.log('🚀 Lancement du navigateur...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let token = null;

  // Intercepter les réponses API pour choper le token
  page.on('response', async (res) => {
    try {
      if (res.status() !== 200) return;
      const url = res.url();
      if (!url.includes('kick.com')) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await res.json().catch(() => null);
      if (!json) return;
      const t = json?.token || json?.access_token || json?.data?.token;
      if (t && t.length > 20) { token = t; console.log('[AUTH] Token intercepté ✓'); }
    } catch(e) {}
  });

  console.log('🌐 Chargement de kick.com...');
  await page.goto('https://kick.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  console.log('🌐 Navigation vers la page login...');
  await page.goto('https://kick.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  console.log('📧 Saisie des identifiants...');
  try {
    await page.fill('input[type="email"]', EMAIL);
    await page.waitForTimeout(400);
    await page.fill('input[type="password"]', PASSWORD);
    await page.waitForTimeout(400);
    await page.click('button[type="submit"]');
    console.log('🖱 Formulaire soumis, attente de la réponse...');
    await page.waitForTimeout(6000);
  } catch(e) {
    console.error('❌ Erreur formulaire:', e.message);
  }

  // Chercher dans les cookies
  if (!token) {
    const cookies = await context.cookies();
    const c = cookies.find(c => ['kick_session','token','access_token','auth_token','xsrf-token'].includes(c.name.toLowerCase()));
    if (c) { token = c.value; console.log(`[AUTH] Token trouvé dans cookie: ${c.name}`); }
  }

  // Chercher dans localStorage/sessionStorage
  if (!token) {
    token = await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth')) {
          const v = localStorage.getItem(key);
          if (v && v.length > 20 && !v.startsWith('{')) return v;
        }
      }
      return null;
    }).catch(() => null);
  }

  await browser.close();

  if (!token) {
    console.error('\n❌ Token non trouvé — Kick utilise probablement un captcha.');
    console.log('\n💡 Solution manuelle (2 minutes) :');
    console.log('   1. Va sur kick.com et connecte-toi avec le compte bot');
    console.log('   2. F12 → Application → Cookies → https://kick.com');
    console.log('   3. Copie la valeur de "kick_session"');
    console.log('   4. Ouvre .env et mets : KICK_TOKEN=valeur_copiée');
    console.log('   5. Redémarre node bot.js\n');
    process.exit(1);
  }

  // Sauvegarder dans .env
  const envPath = path.join(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');
  if (envContent.match(/^KICK_TOKEN=.*/m)) {
    envContent = envContent.replace(/^KICK_TOKEN=.*/m, `KICK_TOKEN=${token}`);
  } else {
    envContent += `\nKICK_TOKEN=${token}`;
  }
  fs.writeFileSync(envPath, envContent);

  console.log('\n✅ Token sauvegardé dans .env !');
  console.log('🔄 Redémarre node bot.js\n');

})().catch(err => {
  console.error('❌ Erreur:', err.message);
  process.exit(1);
});
