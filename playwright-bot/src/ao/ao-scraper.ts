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
import { config } from '../config';
import { logger } from '../logger';
import { dedupeTrackingItems, detectCarrierFromTrackingNumber, normalizeCarrier } from '../tracking-utils';
import type { ScrapeResult, TrackingItem } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level browser singleton (reused across orders in one bot run)
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let aoPage: Page | null = null;
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

  aoPage = await context.newPage();
  setupAoPage(aoPage);
  await login(aoPage);
}

/**
 * Look up one AO order reference and extract the tracking number.
 */
export async function getTrackingForOrder(aoReference: string): Promise<ScrapeResult> {
  if (!context || !browser?.isConnected()) {
    return { success: false, reason: 'error', message: 'Browser ikke tilgaengelig eller lukket uventet.' };
  }

  let page: Page;
  try {
    if (!aoPage || aoPage.isClosed()) {
      aoPage = await context.newPage();
      setupAoPage(aoPage);
      await login(aoPage);
    }
    page = aoPage;
  } catch {
    return { success: false, reason: 'error', message: 'Kunne ikke aabne AO-side - browser lukket uventet.' };
  }

  try {
    return await lookupTracking(page, aoReference);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Uventet fejl under opslag af ${aoReference}: ${message}`);
    return { success: false, reason: 'error', message };
  }
}

function setupAoPage(page: Page): void {
  page.setDefaultTimeout(config.bot.pageTimeoutMs);
  page.on('requestfailed', (request) => {
    if (!['document', 'xhr', 'fetch'].includes(request.resourceType())) return;
    const failure = request.failure();
    logger.warn(`[AO] Request failed: ${request.method()} ${request.url()} - ${failure?.errorText ?? 'unknown error'}`);
  });
  page.on('response', (response) => {
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    if (response.status() < 400) return;
    logger.warn(`[AO] API response ${response.status()}: ${request.method()} ${response.url()}`);
  });
}
/**
 * Close the browser. Call once at the end of a bot run.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    aoPage = null;
    isLoggedIn = false;
    logger.info('Browser lukket.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

async function login(existingPage?: Page): Promise<void> {
  if (!context) throw new Error('Browser context ikke initialiseret.');

  const page = existingPage ?? await context.newPage();
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

    // "Mit overblik" kan findes i DOMen foer sessionen er aktiv. Vent paa
    // kontoteksten, saa vi ikke gaar videre mens AO stadig svarer 401.
    await page.waitForFunction((username) => {
      const accountText = (document.querySelector('a[href="/mit-overblik"] .account-name')?.textContent ?? '').trim().toLowerCase();
      return accountText.length > 0 && accountText.includes(String(username).toLowerCase());
    }, config.ao.username, { timeout: config.bot.pageTimeoutMs });

    isLoggedIn = true;
    logger.info('Login lykkedes.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Login fejlede: ${message}`);
    await page.screenshot({ path: 'logs/login-error.png' }).catch(() => {});
    throw new Error(`AO login fejlede: ${message}`);
  } finally {
    if (!existingPage) {
      await page.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order lookup + tracking extraction
// ─────────────────────────────────────────────────────────────────────────────

// Statuser der betyder ordren endnu IKKE er afsendt (tracking ikke klar)
const NOT_READY_STATUSES = ['under plukning', 'afventer', 'annulleret', 'pakket', 'kommende'];

async function searchReferenceAndWait(page: Page, aoReference: string): Promise<void> {
  const startedAt = Date.now();
  const searchInput = page.locator('input#searchTextInput').first();
  await searchInput.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });
  await searchInput.fill(`#${aoReference}`);
  const clickedSearchButton = await page.evaluate(() => {
    const input = document.querySelector('input#searchTextInput') as HTMLInputElement | null;
    if (!input) return false;

    const inputRect = input.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const candidates = buttons
      .map((button) => ({ button, rect: button.getBoundingClientRect(), text: (button.textContent ?? '').trim() }))
      .filter(({ button, rect, text }) =>
        text.toLowerCase() === 'søg' &&
        !button.disabled &&
        rect.width > 0 &&
        rect.height > 0 &&
        Math.abs(rect.top - inputRect.top) < 80 &&
        rect.left > inputRect.left
      )
      .sort((a, b) => Math.abs(a.rect.left - inputRect.right) - Math.abs(b.rect.left - inputRect.right));

    if (candidates[0]) {
      candidates[0].button.click();
      return true;
    }

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return false;
  });
  logger.info(`[AO] Sogeknap ved leveringsfelt klikket for #${aoReference}: ${clickedSearchButton ? 'ja' : 'nej, brugte Enter fallback'}.`);

  const waitResult = await page.waitForFunction((aoRef) => {
    const normalize = (v: string): string => v.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const target = normalize(aoRef);

    const rows = Array.from(document.querySelectorAll('tbody tr'));
    for (const row of rows) {
      const tds = Array.from(row.querySelectorAll('td'));
      if (tds.length < 5) continue;
      const rowText = normalize(tds.map((td) => td.textContent ?? '').join(' '));
      if (rowText.includes(target)) return 'found';
    }

    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    if (
      bodyText.includes('ingen resultater') ||
      bodyText.includes('ingen leveringer') ||
      bodyText.includes('ingen data') ||
      bodyText.includes('no results')
    ) {
      return 'empty';
    }

    return false;
  }, aoReference, { timeout: 30_000 })
    .then((handle) => handle.jsonValue())
    .catch(() => 'timeout');

  logger.info(
    `[AO] Soegning efter #${aoReference} ventede ${((Date.now() - startedAt) / 1000).toFixed(1)}s; resultat=${waitResult}.`
  );

  if (waitResult === 'timeout') {
    const safeReference = aoReference.replace(/[^a-zA-Z0-9_-]/g, '_');
    await page.screenshot({ path: `logs/ao-search-timeout-${safeReference}.png`, fullPage: true }).catch(() => {});
    const diagnostics = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((input) => ({
        id: input.id,
        name: input.getAttribute('name'),
        type: input.getAttribute('type'),
        placeholder: input.getAttribute('placeholder'),
        value: input.value,
        visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
      }));
      const rows = Array.from(document.querySelectorAll('tbody tr')).slice(0, 5).map((row) =>
        (row.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
      return {
        url: window.location.href,
        title: document.title,
        inputs,
        rowCount: document.querySelectorAll('tbody tr').length,
        rows,
        bodySnippet: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 800),
      };
    }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
    logger.warn(`[AO] Timeout-diagnose for #${aoReference}: ${JSON.stringify(diagnostics)}`);
  }
}

async function navigateToDeliveryOverview(page: Page): Promise<void> {
  const baseUrl = new URL(config.ao.loginUrl).origin;

  try {
    logger.info('[AO] Navigerer via Mit overblik -> Leveringsoversigt.');
    if (!/ao\.dk/i.test(page.url())) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    }

    const overviewLink = page.locator('a[href="/mit-overblik"], a[href*="/mit-overblik"].mit-overblik, .header-menu.mit-overblik').first();
    await overviewLink.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });
    await overviewLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const deliveryOverviewLink = page.locator('a[href="/mit-overblik/leveringsoversigt"]').first();
    await deliveryOverviewLink.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });
    await deliveryOverviewLink.click();
    logger.info('[AO] Leveringsoversigt-link klikket.');

    await page.waitForSelector('input#searchTextInput', {
      state: 'visible',
      timeout: config.bot.pageTimeoutMs,
    });
    logger.info('[AO] Leveringsoversigt er klar.');
  } catch (err) {
    await page.screenshot({ path: 'logs/ao-navigation-error.png', fullPage: true }).catch(() => {});
    const diagnostics = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodySnippet: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    })).catch((diagErr) => ({ error: diagErr instanceof Error ? diagErr.message : String(diagErr) }));
    logger.warn(`[AO] Navigation til leveringsoversigt fejlede: ${JSON.stringify(diagnostics)}`);
    throw err;
  }
}

async function lookupTracking(page: Page, aoReference: string): Promise<ScrapeResult> {
  const scanOrderRows = async () => {
    return await page.evaluate((aoRef) => {
      const normalize = (v: string): string => v.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const target = normalize(aoRef);

      const tbodies = Array.from(document.querySelectorAll('tbody'));
      for (const tbody of tbodies) {
        for (const row of Array.from(tbody.querySelectorAll('tr'))) {
          const tds = row.querySelectorAll('td');
          if (tds.length < 5) continue; // Spring "ingen data"-rækker over

          const cellTexts = Array.from(tds).map((td) => (td.textContent ?? '').trim());
          const rowHasReference = cellTexts.some((txt) => normalize(txt).includes(target));
          if (rowHasReference) {
            const status = (tds[4]?.textContent ?? '').trim().toLowerCase();
            const allAnchors = Array.from(row.querySelectorAll(
              'a[href*="trace.fragt.dk"], a[href*="booking-glsexpress.dk"], a[href*="postnord"], a[href*="nsp.postnord.com"], a[href*="portal.postnord.com"]'
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
  };

  // Trin 1: Naviger via AO-menuen til leveringsoversigt.
  await navigateToDeliveryOverview(page);

  // Vent kort på at søgefeltet bliver synligt før vi vurderer login-status.
  const hasSearchInput = await page
    .waitForSelector('input#searchTextInput', { state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const hasLoginForm = await page
    .locator('#username:visible, #password:visible, button[type="submit"]:has-text("Log ind")')
    .first()
    .isVisible()
    .catch(() => false);
  const onLoginPage = /\/login/i.test(page.url());

  if (!hasSearchInput || hasLoginForm || onLoginPage) {
    logger.warn('Session mangler/udløbet – logger ind igen…');
    isLoggedIn = false;
    await login(page);
    await navigateToDeliveryOverview(page);
  }

  // ── Trin 2: Søg på reference ──────────────────────────────────────────
  logger.debug(`Søger efter reference: #${aoReference}`);
  await searchReferenceAndWait(page, aoReference);

  // ── Trin 3: Scan alle tbody-rækker direkte i browseren ───────────────
  // Bruger page.evaluate() for at undgå Playwright-timeout og "stale element"
  // problemer med Vues virtuelle DOM.
  let scanResult = await scanOrderRows();

  // Hvis første scan ikke finder referencen, så prøv én refresh + ny søgning.
  if (!scanResult.found) {
    logger.warn(`Reference #${aoReference} ikke fundet i første scan – prøver refresh + ny søgning…`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await searchReferenceAndWait(page, aoReference);
    scanResult = await scanOrderRows();
  }

  const { found, status: statusText, ttHrefs } = scanResult;
  const uniqueTtHrefs = [...new Set(ttHrefs.map((href) => href.trim()).filter(Boolean))];
  logger.debug(
    `Scan-resultat: found=${found}, status="${statusText}", ttHrefs=${ttHrefs.length} link(s), unique=${uniqueTtHrefs.length}`
  );

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
  if (uniqueTtHrefs.length === 0) {
    logger.debug(`Ingen T&T link endnu for #${aoReference} (status: "${statusText}").`);
    return {
      success: false,
      reason: 'not_ready',
      message: `Track & Trace link ikke tilgængeligt endnu (status: "${statusText}")`,
    };
  }

  const trackingItems: TrackingItem[] = [];

  for (const ttHref of uniqueTtHrefs) {
    // GLS Express: brug bookingRef som trackingnummer
    if (ttHref.includes('booking-glsexpress.dk')) {
      const match = ttHref.match(/bookingRef=([^&]+)/);
      const trackingNumber = match ? decodeURIComponent(match[1]) : ttHref;
      logger.debug(`GLS Express tracking: ${trackingNumber}`);
      trackingItems.push({ trackingNumber, carrier: 'GLS', trackingUrl: ttHref });
      continue;
    }

    // PostNord: forsøg først at læse fuldt "Pakke"-nummer fra siden,
    // fallback til id-param i URL (fx ?id=3570...).
    if (ttHref.includes('postnord')) {
      let trackingNumber: string | null = null;

      const detailPage = await context!.newPage();
      detailPage.setDefaultTimeout(config.bot.pageTimeoutMs);
      try {
        await detailPage.goto(ttHref, { waitUntil: 'domcontentloaded' });

        await detailPage
          .locator('button:has-text("Accept all"), button:has-text("Accepter alle"), [id*="onetrust-accept"], .coi-banner__accept')
          .first()
          .click({ timeout: 4_000 })
          .catch(() => {});

        trackingNumber = await detailPage.evaluate(() => {
          const txt = document.body?.innerText ?? '';
          const m = txt.match(/\bPakke\s+([0-9]{10,})\b/i);
          return m?.[1] ?? null;
        });
      } finally {
        await detailPage.close().catch(() => {});
      }

      if (!trackingNumber) {
        const pnMatch = ttHref.match(/[?&]id=([^&]+)/i);
        trackingNumber = pnMatch?.[1] ? decodeURIComponent(pnMatch[1]) : ttHref;
      }

      logger.debug(`PostNord tracking: ${trackingNumber}`);
      trackingItems.push({ trackingNumber, carrier: 'PostNord', trackingUrl: ttHref });
      continue;
    }

    // Danske Fragtmænd: åbn hvert link i en frisk side for stabil udlæsning
    logger.debug(`Følger trace.fragt.dk-link: ${ttHref}`);
    let fragtbrevsnummer: string | null = null;
    const detailPage = await context!.newPage();
    detailPage.setDefaultTimeout(config.bot.pageTimeoutMs);

    try {
      await detailPage.goto(ttHref, { waitUntil: 'domcontentloaded' });

      // PostNord kan vise cookie-banner som blokerer indhold; forsøg at acceptere.
      if (ttHref.includes('postnord')) {
        await detailPage
          .locator('button:has-text("Accept all"), button:has-text("Accepter alle"), [id*="onetrust-accept"], .coi-banner__accept')
          .first()
          .click({ timeout: 4_000 })
          .catch(() => {});
      }

      await detailPage.waitForFunction(() => {
        const txt = document.body?.innerText ?? '';
        return /Fragtbrevsnummer\s*:|Referencenummer\s*:|Pakke\s+\d{10,}/i.test(txt);
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

        // PostNord-visning kan stå som: "Pakke 00357... Afsender ..."
        const fullText = document.body?.innerText ?? '';
        const postNordMatch = fullText.match(/\bPakke\s+([0-9]{10,})\b/i);
        if (postNordMatch?.[1]) {
          return postNordMatch[1].toUpperCase();
        }

        return null;
      });
    } finally {
      await detailPage.close().catch(() => {});
    }

    const trackingNumber = fragtbrevsnummer ?? ttHref;
    logger.debug(`Fragtlink tracking: ${trackingNumber}`);
    trackingItems.push({ trackingNumber, carrier: detectCarrierFromUrl(ttHref), trackingUrl: ttHref });
  }

  const uniqueTrackingItems: TrackingItem[] = dedupeTrackingItems(trackingItems);

  logger.debug(
    `Fandt ${uniqueTrackingItems.length} unik(ke) forsendelse(r) på ordre #${aoReference}: ${uniqueTrackingItems
      .map((t) => t.trackingNumber)
      .join(', ')}`
  );

  const first = uniqueTrackingItems[0];
  return {
    success: true,
    trackingNumber: first.trackingNumber,
    carrier: first.carrier,
    trackingUrl: first.trackingUrl,
    trackingItems: uniqueTrackingItems,
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
  return detectCarrierFromTrackingNumber(trackingNumber);
}

function detectCarrierFromUrl(url: string): string {
  if (url.includes('gls-group.com'))   return 'GLS';
  if (url.includes('postnord.com'))    return 'PostNord';
  if (url.includes('trace.fragt.dk'))   return 'Danske Fragtmænd';
  if (url.includes('dao.as'))          return 'DAO';
  if (url.includes('bring.com'))       return 'Bring';
  if (url.includes('dhl.com'))         return 'DHL';
  return normalizeCarrier(detectCarrierFromTrackingNumber(url));
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
