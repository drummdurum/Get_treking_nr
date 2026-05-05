/**
 * test-login.ts – tester KUN AO/Ahlsell login med de kendte selectors.
 *
 * Kørsel:
 *   npx ts-node src/test-login.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import { config } from '../config';

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log(' AO Login test (HEADLESS=false)');
  console.log('══════════════════════════════════════════');
  console.log(` URL:      ${config.ao.loginUrl}`);
  console.log(` Brugernavn: ${config.ao.username}`);
  console.log('══════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false });
  const page    = await browser.newPage();
  page.setDefaultTimeout(30_000);

  await page.goto(config.ao.loginUrl, { waitUntil: 'domcontentloaded' });
  console.log('✓ Siden loadet');

  // Cookie-banner (ao.dk bruger Cookie Information – knappen hedder "Vælg alle", klasse .coi-banner__accept)
  try {
    await page.waitForSelector('.coi-banner__accept', { state: 'visible', timeout: 8_000 });
    await page.click('.coi-banner__accept');
    await page.waitForSelector('.coi-banner__accept', { state: 'detached', timeout: 5_000 }).catch(() => {});
    console.log('✓ Cookie-banner accepteret');
  } catch {
    console.log('  (Ingen cookie-banner)');
  }

  // Udfyld formular – der er 2 x #username på siden (navbar-dropdown er skjult), brug :visible
  await page.fill('#username:visible', config.ao.username);
  await page.fill('#password:visible', config.ao.password);
  console.log('✓ Brugernavn og kodeord udfyldt');

  await page.click('button[type="submit"]:visible:has-text("Log ind")');
  console.log('✓ Log ind klikket – venter på viderevisning…');

  // Vent på at vi forlader login-siden
  try {
    await Promise.race([
      page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 }),
      page.waitForSelector('#username', { state: 'detached', timeout: 15_000 }),
    ]);
    const finalUrl = page.url();
    console.log(`\n✓ LOGIN LYKKEDES! Nuværende URL: ${finalUrl}`);
    console.log('\nBrowseren forbliver åben i 30 sekunder så du kan se siden.');
    console.log('Kig efter et "Mine ordrer" / "Ordrehistorik" link og noter URL\'en.');
    console.log('Den skal ind i ao-scraper.ts under "Naviger til ordresøgning".\n');
    await page.waitForTimeout(30_000);
  } catch {
    await page.screenshot({ path: 'logs/login-test-fejl.png', fullPage: true });
    console.error('\n✗ LOGIN FEJLEDE – screenshot gemt i logs/login-test-fejl.png');
    console.error('  Tjek AO_USERNAME og AO_PASSWORD i .env\n');
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
