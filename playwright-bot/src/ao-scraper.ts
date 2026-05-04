/**
 * ao-scraper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser automation (Playwright) mod AO / Ahlsell B2B portal.
 *
 * VIGTIGT – selectors:
 *   AO's portal kan ændre sig uden varsel.  Alle CSS-selectors / tekst-matches
 *   er markeret med kommentaren  ← TILPAS  og SKAL verificeres mod den rigtige
 *   side første gang du kører botten.  Åbn siden med HEADLESS=false i .env
 *   og brug Playwright Inspector (`npx playwright codegen <url>`) til at finde
 *   de korrekte selectors.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { config } from './config';
import { logger } from './logger';
import type { ScrapeResult, TrackingItem } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level browser singleton (reused across orders in one bot run)
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let isLoggedIn = false;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch the browser and log in to AO.
 * Call once at the start of a bot run.
 */
export async function launchAndLogin(): Promise<void> {
  logger.info('Starter browser…');

  browser = await chromium.launch({
    headless: config.bot.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    locale: 'da-DK',
    timezoneId: 'Europe/Copenhagen',
  });

  await login();
}

/**
 * Look up one AO order reference and extract the tracking number.
 */
export async function getTrackingForOrder(aoReference: string): Promise<ScrapeResult> {
  if (!context || !browser?.isConnected()) {
    return { success: false, reason: 'error', message: 'Browser ikke tilgængelig eller lukket uventet.' };
  }

  let page;
  try {
    page = await context.newPage();
  } catch {
    return { success: false, reason: 'error', message: 'Kunne ikke åbne ny side – browser lukket uventet.' };
  }
  page.setDefaultTimeout(config.bot.pageTimeoutMs);

  try {
    return await lookupTracking(page, aoReference);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Uventet fejl under opslag af ${aoReference}: ${message}`);
    return { success: false, reason: 'error', message };
  } finally {
    await page.close();
  }
}

/**
 * Close the browser. Call once at the end of a bot run.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    isLoggedIn = false;
    logger.info('Browser lukket.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

async function login(): Promise<void> {
  if (!context) throw new Error('Browser context ikke initialiseret.');

  const page = await context.newPage();
  page.setDefaultTimeout(config.bot.pageTimeoutMs);

  try {
    // Login-formularen er en del af ao.dk forsiden – loades som Vue-komponent
    logger.info(`Logger ind på AO: ${config.ao.loginUrl}`);
    await page.goto(config.ao.loginUrl, { waitUntil: 'networkidle' });

    // ── Accept cookie-banner (Cookie Information platform på ao.dk) ──────
    // Knappen hedder "Vælg alle" med klassen .coi-banner__accept
    try {
      await page.waitForSelector('.coi-banner__accept', { state: 'visible', timeout: 8_000 });
      await page.click('.coi-banner__accept');
      logger.debug('Cookie-banner accepteret (Vælg alle).');
      // Vent på at banneret forsvinder fra DOM
      await page.waitForSelector('.coi-banner__accept', { state: 'detached', timeout: 5_000 })
        .catch(() => {});
    } catch {
      logger.debug('Intet cookie-banner fundet – fortsætter.');
    }

    // ── Vent på at det SYNLIGE #username felt er klar (der er 2 på siden) ──
    // Det ene er i en skjult navbar-dropdown, det andet er i den synlige login-boks
    await page.waitForSelector('#username:visible', { timeout: config.bot.pageTimeoutMs });

    // ── Udfyld login-formular ─────────────────────────────────────────────
    await page.locator('#username:visible').fill(config.ao.username);
    await page.locator('#password:visible').fill(config.ao.password);
    await page.locator('button[type="submit"]:visible:has-text("Log ind")').click();

    // ── Vent på at vi er logget ind: "Mit overblik"-knappen dukker op ─────
    await page.waitForSelector('.mit-overblik, a[href*="/mit-overblik"]', {
      state: 'attached',
      timeout: config.bot.pageTimeoutMs,
    });

    isLoggedIn = true;
    logger.info('Login lykkedes.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Login fejlede: ${message}`);
    await page.screenshot({ path: 'logs/login-error.png' }).catch(() => {});
    throw new Error(`AO login fejlede: ${message}`);
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order lookup + tracking extraction
// ─────────────────────────────────────────────────────────────────────────────

// Statuser der betyder ordren endnu IKKE er afsendt (tracking ikke klar)
const NOT_READY_STATUSES = ['under plukning', 'afventer', 'annulleret', 'pakket', 'kommende'];

async function lookupTracking(page: Page, aoReference: string): Promise<ScrapeResult> {
  const baseUrl = new URL(config.ao.loginUrl).origin;
  const url = `${baseUrl}/mit-overblik/leveringsoversigt`;

  // ── Trin 1: Naviger direkte til leveringsoversigt ─────────────────────
  logger.debug('Navigerer til leveringsoversigt…');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Tjek at session stadig er aktiv
  const loginVisible = await page.locator('#username').isVisible().catch(() => false);
  if (loginVisible) {
    logger.warn('Session udløbet – logger ind igen…');
    isLoggedIn = false;
    await login();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  // ── Trin 2: Søg på reference ──────────────────────────────────────────
  logger.debug(`Søger efter reference: #${aoReference}`);
  await page.waitForSelector('input#searchTextInput', { timeout: config.bot.pageTimeoutMs });
  await page.fill('input#searchTextInput', `#${aoReference}`);
  await page.click('button[type="submit"]');

  // Vent på at Vue SPA er færdig med at opdatere DOM'en.
  // networkidle er upålidelig på SPAs med baggrundspoll – vi venter i stedet
  // på at submit-knappens loading-spinner forsvinder (display: none).
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (!btn) return false;
    const spinner = btn.querySelector('div[style]') as HTMLElement | null;
    return spinner ? spinner.style.display === 'none' : true;
  }, { timeout: 15_000 }).catch(() => {});

  // ── Trin 3: Scan alle tbody-rækker direkte i browseren ───────────────
  // Bruger page.evaluate() for at undgå Playwright-timeout og "stale element"
  // problemer med Vues virtuelle DOM.
  const scanResult = await page.evaluate((aoRef) => {
    const tbodies = Array.from(document.querySelectorAll('tbody'));
    for (const tbody of tbodies) {
      for (const row of Array.from(tbody.querySelectorAll('tr'))) {
        const tds = row.querySelectorAll('td');
        if (tds.length < 5) continue; // Spring "ingen data"-rækker over
        const refCell = (tds[2]?.textContent ?? '').trim();
        if (refCell === `#${aoRef}` || refCell.includes(`#${aoRef}`)) {
          const status = (tds[4]?.textContent ?? '').trim().toLowerCase();
          // Saml ALLE T&T-links i rækken i original rækkefølge (inkl. evt. dubletter)
          const allAnchors = Array.from(row.querySelectorAll(
            'a[href*="trace.fragt.dk"], a[href*="booking-glsexpress.dk"]'
          )) as HTMLAnchorElement[];
          const ttHrefs: string[] = [];
          for (const a of allAnchors) {
            if (a.href) ttHrefs.push(a.href);
          }
          return { found: true, status, ttHrefs };
        }
      }
    }
    return { found: false, status: '', ttHrefs: [] as string[] };
  }, aoReference);

  const { found, status: statusText, ttHrefs } = scanResult;
  logger.debug(`Scan-resultat: found=${found}, status="${statusText}", ttHrefs=${ttHrefs.length} link(s)`);

  if (!found) {
    logger.debug(`Reference #${aoReference} ikke fundet i leveringsoversigt.`);
    return {
      success: false,
      reason: 'not_found',
      message: `Ingen levering med reference #${aoReference} fundet`,
    };
  }

  // ── Trin 4: Tjek status ───────────────────────────────────────────────
  if (NOT_READY_STATUSES.some(s => statusText.includes(s))) {
    return {
      success: false,
      reason: 'not_ready',
      message: `Leveringsstatus er "${statusText}" – afventer afsendelse`,
    };
  }

  // ── Trin 5: Hent fragtbrevsnummer fra ALLE T&T-links ─────────────────
  if (ttHrefs.length === 0) {
    logger.debug(`Ingen T&T link endnu for #${aoReference} (status: "${statusText}").`);
    return {
      success: false,
      reason: 'not_ready',
      message: `Track & Trace link ikke tilgængeligt endnu (status: "${statusText}")`,
    };
  }

  const trackingItems: TrackingItem[] = [];

  for (const ttHref of ttHrefs) {
    // GLS Express: brug bookingRef som trackingnummer
    if (ttHref.includes('booking-glsexpress.dk')) {
      const match = ttHref.match(/bookingRef=([^&]+)/);
      const trackingNumber = match ? decodeURIComponent(match[1]) : ttHref;
      logger.debug(`GLS Express tracking: ${trackingNumber}`);
      trackingItems.push({ trackingNumber, carrier: 'GLS', trackingUrl: ttHref });
      continue;
    }

    // Danske Fragtmænd: åbn hvert link i en frisk side for stabil udlæsning
    logger.debug(`Følger trace.fragt.dk-link: ${ttHref}`);
    let fragtbrevsnummer: string | null = null;
    const detailPage = await context!.newPage();
    detailPage.setDefaultTimeout(config.bot.pageTimeoutMs);

    try {
      await detailPage.goto(ttHref, { waitUntil: 'domcontentloaded' });
      await detailPage.waitForFunction(() => {
        const txt = document.body?.innerText ?? '';
        return /Fragtbrevsnummer\s*:|Referencenummer\s*:/i.test(txt);
      }, { timeout: 15_000 }).catch(() => {});

      fragtbrevsnummer = await detailPage.evaluate(() => {
        const lines = (document.body?.innerText ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);

        const readValue = (line: string, label: string): string | null => {
          if (!line.toLowerCase().startsWith(label.toLowerCase())) return null;
          const value = line.slice(label.length).trim();
          if (!value) return null;
          if (/^(fragtbrevsnummer|referencenummer)$/i.test(value)) return null;
          return value;
        };

        for (const line of lines) {
          const val = readValue(line, 'Fragtbrevsnummer:');
          if (val) return val.toUpperCase();
        }

        for (const line of lines) {
          const val = readValue(line, 'Referencenummer:');
          if (val) return val.toUpperCase();
        }

        return null;
      });
    } finally {
      await detailPage.close().catch(() => {});
    }

    const trackingNumber = fragtbrevsnummer ?? ttHref;
    logger.debug(`Danske Fragtmænd fragtbrevsnummer: ${trackingNumber}`);
    trackingItems.push({ trackingNumber, carrier: 'Danske Fragtmænd', trackingUrl: ttHref });
  }

  logger.debug(`Fandt ${trackingItems.length} forsendelse(r) på ordre #${aoReference}: ${trackingItems.map(t => t.trackingNumber).join(', ')}`);

  const first = trackingItems[0];
  return {
    success: true,
    trackingNumber: first.trackingNumber,
    carrier: first.carrier,
    trackingUrl: first.trackingUrl,
    trackingItems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hjælpefunktioner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forsøg at gætte carrier ud fra trackingnummerets format.
 * Udvid listen efter behov.
 */
function detectCarrier(trackingNumber: string): string {
  // GLS DK: typisk 14-cifret, starter med 00370
  if (/^00370\d{9,}$/.test(trackingNumber)) return 'GLS';

  // PostNord DK: starter med RE / RR / PQ eller lignende
  if (/^[A-Z]{2}\d{9}DK$/.test(trackingNumber)) return 'PostNord';

  // DAO: 10-18 cifre
  if (/^\d{10,18}$/.test(trackingNumber)) return 'DAO';

  // Fallback
  return 'GLS';
}

function detectCarrierFromUrl(url: string): string {
  if (url.includes('gls-group.com'))   return 'GLS';
  if (url.includes('postnord.com'))    return 'PostNord';
  if (url.includes('dao.as'))          return 'DAO';
  if (url.includes('bring.com'))       return 'Bring';
  if (url.includes('dhl.com'))         return 'DHL';
  return 'Ukendt';
}

/** Træk trackingnummer ud af et tracking-URL. */
function extractTrackingFromUrl(url: string): string | null {
  // GLS: ?match=XXXX
  const glsMatch = url.match(/[?&]match=([^&]+)/);
  if (glsMatch) return decodeURIComponent(glsMatch[1]);

  // PostNord: ?id=XXXX eller /tracking/XXXX
  const pnMatch = url.match(/[?&]id=([^&]+)|\/tracking\/([^/?]+)/);
  if (pnMatch) return decodeURIComponent(pnMatch[1] ?? pnMatch[2]);

  // DAO: ?searchfield=XXXX
  const daoMatch = url.match(/[?&]searchfield=([^&]+)/);
  if (daoMatch) return decodeURIComponent(daoMatch[1]);

  // Bring: /tracking/XXXX
  const bringMatch = url.match(/\/tracking\/([^/?]+)/);
  if (bringMatch) return decodeURIComponent(bringMatch[1]);

  return null;
}
