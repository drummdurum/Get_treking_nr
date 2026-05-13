/**
 * ahlsell-scraper.ts
 * Playwright-scraper mod Ahlsell B2B portal (ahlsell.dk/da).
 */

import { Browser, BrowserContext, chromium } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import type { ScrapeResult, TrackingItem } from '../types';

let browser: Browser | null = null;
let context: BrowserContext | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function launchAndLogin(): Promise<void> {
  logger.info('[Ahlsell] Starter browser...');

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

export async function getTrackingForOrder(reference: string): Promise<ScrapeResult> {
  if (!context || !browser?.isConnected()) {
    return { success: false, reason: 'error', message: 'Browser ikke tilgaengelig.' };
  }

  const page = await context.newPage();
  page.setDefaultTimeout(config.bot.pageTimeoutMs);
  const trackingItems: TrackingItem[] = [];

  try {
    const ordersLoadTimeoutMs = Math.max(config.bot.pageTimeoutMs, 60_000);

    // Byg søge-URL direkte med reference og 6-måneders datointerval
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setMonth(fromDate.getMonth() - 6);
    const fmtDate = (d: Date): string =>
      `${d.getFullYear()}%2F${String(d.getMonth() + 1).padStart(2, '0')}%2F${String(d.getDate()).padStart(2, '0')}`;

    const ordersUrl =
      `${config.ahlsell.baseUrl}/min-side/bogholderi/ordreoversigt` +
      `?fromDate=${fmtDate(fromDate)}&reference=${encodeURIComponent(reference)}&toDate=${fmtDate(toDate)}&page=1`;

    logger.debug(`[Ahlsell] Navigerer til søgeresultat for reference: ${reference}`);
    await page.goto(ordersUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

      // Afvis cookie-banner hvis det dukker op på siden
      await page.locator('#coiOverlay').waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
      await page.getByRole('button', { name: 'Accepter alle' }).click({ timeout: 5_000 }).catch(() => {});
      await page.locator('#coiOverlay').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});

    // Klik paa Ordrenr-linket i resultatlisten (foerste match)
    const orderLink = page.locator('a[title="Ordrenr."]').first();
    const orderLinkVisible = await orderLink.isVisible().catch(() => false);

    if (!orderLinkVisible) {
      logger.info(`[Ahlsell] Kunne ikke finde ordre med reference ${reference} på Ahlsell.`);
      return {
        success: false,
        reason: 'not_found',
        message: `Ordre med reference ${reference} kunne ikke findes på Ahlsell`,
      };
    }

    await orderLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Klik paa Track and trace-linket fra ordredetaljesiden
    const tntLink = page
      .locator('a[title="Track and trace"], a[href*="/mine-services/track-and-trace?"]')
      .first();

    await tntLink.waitFor({ state: 'attached', timeout: config.bot.pageTimeoutMs }).catch(() => {});
    const tntExists = (await tntLink.count().catch(() => 0)) > 0;

    if (tntExists) {
      await tntLink.scrollIntoViewIfNeeded().catch(() => {});
      await tntLink.click({ timeout: config.bot.pageTimeoutMs }).catch(async () => {
        await tntLink.click({ force: true, timeout: config.bot.pageTimeoutMs });
      });
    } else {
      return {
        success: false,
        reason: 'not_ready',
        message: 'Track and Trace link ikke tilgaengelig endnu',
      };
    }

    await page.waitForLoadState('domcontentloaded');

    await page.waitForFunction(() => {
      const hasDetails = document.querySelectorAll('a[href*="/track-and-trace-detaljer"]').length > 0;
      const text = document.body?.innerText ?? '';
      const hasTrackingOnPage = /[A-Z]{2}\d{6,}/.test(text);
      return hasDetails || hasTrackingOnPage;
    }, { timeout: ordersLoadTimeoutMs }).catch(() => {});

    // Find "Vis detaljer" links i T&T listen for den reference vi har soegt paa.
    const detailUrls = await page.evaluate((ref: string) => {
      const normalizedRef = `#${ref}`;
      const urls: string[] = [];
      const rows = Array.from(document.querySelectorAll('ul li'));

      for (const row of rows) {
        const text = row.textContent ?? '';
        if (!text.includes(normalizedRef) && !text.includes(ref)) continue;
        const detailsAnchor = row.querySelector('a[href*="/track-and-trace-detaljer"]') as HTMLAnchorElement | null;
        if (detailsAnchor?.href) urls.push(detailsAnchor.href);
      }

      // Fallback: hvis referencespecifik filtrering fejler, proev alle Vis detaljer links.
      if (urls.length === 0) {
        const all = Array.from(document.querySelectorAll('a[href*="/track-and-trace-detaljer"]')) as HTMLAnchorElement[];
        for (const anchor of all) {
          if (anchor.href) urls.push(anchor.href);
        }
      }

      return [...new Set(urls)];
    }, reference);

    if (detailUrls.length === 0) {
      return {
        success: false,
        reason: 'not_ready',
        message: 'Vis detaljer link ikke fundet endnu',
      };
    }

    logger.info(`[Ahlsell] Fandt ${detailUrls.length} Vis detaljer link(s) for reference ${reference}.`);

    for (let i = 0; i < detailUrls.length; i++) {
      const detailUrl = detailUrls[i];
      const detailPage = await context!.newPage();
      detailPage.setDefaultTimeout(config.bot.pageTimeoutMs);

      try {
        logger.info(`[Ahlsell] Aabner detaljeside ${i + 1}/${detailUrls.length}: ${detailUrl}`);
        await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded' });

        const tntPopupButton = detailPage
          .locator('button.c-btn.c-btn--link')
          .filter({ hasText: /track and trace/i })
          .first();

        await tntPopupButton.waitFor({ state: 'visible', timeout: ordersLoadTimeoutMs }).catch(() => {});
        const hasPopupButton = (await tntPopupButton.count().catch(() => 0)) > 0;
        if (hasPopupButton) {
          await tntPopupButton.scrollIntoViewIfNeeded().catch(() => {});
          await detailPage.locator('.overlay.h-full').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
          await tntPopupButton.click({ timeout: config.bot.pageTimeoutMs }).catch(async () => {
            await tntPopupButton.click({ force: true, timeout: config.bot.pageTimeoutMs });
          });
        } else {
          logger.warn(`[Ahlsell] Track and trace knap ikke fundet paa detaljeside ${i + 1}.`);
          continue;
        }

        await detailPage.waitForFunction(() => {
          const hasPackageLabel = Array.from(document.querySelectorAll('p'))
            .some((el) => /pakkenummer\s*:/i.test((el.textContent ?? '').trim()));
          const text = document.body?.innerText ?? '';
          return hasPackageLabel || /Pakkenummer\s*:|[A-Z]{2}\d{6,}/i.test(text);
        }, { timeout: ordersLoadTimeoutMs }).catch(() => {});

        const parsed = await detailPage.evaluate(() => {
          const text = document.body.innerText ?? '';
          let trackingNumber: string | null = null;
          let carrier: string | null = null;

          const popupPairs = Array.from(document.querySelectorAll('div.grid p'))
            .map((p) => (p.textContent ?? '').trim())
            .filter(Boolean);

          for (let idx = 0; idx < popupPairs.length - 1; idx++) {
            const label = popupPairs[idx].toLowerCase();
            const value = popupPairs[idx + 1];
            if (!trackingNumber && label.startsWith('pakkenummer')) {
              trackingNumber = value.toUpperCase();
            }
            if (!carrier && label.startsWith('kurer')) {
              carrier = value;
            }
          }

          if (!trackingNumber) {
            const packRegex = /Pakkenummer\s*:\s*([A-Z]{2}\d{6,})/i;
            const packMatch = text.match(packRegex);
            trackingNumber = packMatch?.[1]?.toUpperCase() ?? null;
          }

          if (!carrier) {
            const carrierRegex = /Kurer\s*:\s*([^\n]+)/i;
            const carrierMatch = text.match(carrierRegex);
            carrier = carrierMatch?.[1]?.trim() ?? null;
          }

          return { trackingNumber, carrier };
        });

        if (parsed.trackingNumber) {
          const carrier = parsed.carrier ?? 'Danske Fragtmaend';
          const trackingUrl = `https://tracking.postnord.com/tracking/#/search?id=${parsed.trackingNumber}`;
          logger.info(`[Ahlsell] Tracking fundet for ${reference}: ${parsed.trackingNumber}`);
          trackingItems.push({
            trackingNumber: parsed.trackingNumber,
            carrier,
            trackingUrl,
          });
        }
      } finally {
        await detailPage.close().catch(() => {});
      }
    }

    const uniqueTrackingItems = trackingItems.filter((item, index, arr) => {
      const key = `${item.carrier}|${item.trackingNumber}`;
      return arr.findIndex((x) => `${x.carrier}|${x.trackingNumber}` === key) === index;
    });

    if (uniqueTrackingItems.length > 0) {
      logger.info(`[Ahlsell] Returnerer ${uniqueTrackingItems.length} unik(ke) trackingnummer(e) for ${reference}.`);
      const first = uniqueTrackingItems[0];
      return {
        success: true,
        trackingNumber: first.trackingNumber,
        carrier: first.carrier,
        trackingUrl: first.trackingUrl,
        trackingItems: uniqueTrackingItems,
      };
    }

    return {
      success: false,
      reason: 'not_ready',
      message: 'Ingen pakkenummer fundet i Vis detaljer siderne',
    };

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Ahlsell] Fejl ved opslag af ${reference}: ${message}`);
    return { success: false, reason: 'error', message };
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    logger.info('[Ahlsell] Browser lukket.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login (intern)
// ─────────────────────────────────────────────────────────────────────────────

async function login(): Promise<void> {
  if (!context) throw new Error('Browser context ikke initialiseret.');

  const page = await context.newPage();
  page.setDefaultTimeout(config.bot.pageTimeoutMs);

  try {
    logger.info(`[Ahlsell] Logger ind paa ${config.ahlsell.baseUrl}`);
    await page.goto(config.ahlsell.baseUrl, { waitUntil: 'networkidle' });

    // Accepter cookies
    try {
      await page.getByRole('button', { name: 'Accepter alle' }).click({ timeout: 8_000 });
      logger.debug('[Ahlsell] Cookie-banner accepteret.');
    } catch {
      logger.debug('[Ahlsell] Intet cookie-banner fundet - fortsaetter.');
    }

    // Udfyld login
    await page.getByLabel('Brugernavn').fill(config.ahlsell.username);
    await page.getByLabel('Kodeord').fill(config.ahlsell.password);
    await page.getByRole('button', { name: 'Log ind', exact: true }).click();

    // Vent paa at vi er logget ind
    await page.waitForSelector('a:has-text("Se alle ordrer")', {
      state: 'attached',
      timeout: config.bot.pageTimeoutMs,
    });

    logger.info('[Ahlsell] Login lykkedes.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Ahlsell] Login fejlede: ${message}`);
    await page.screenshot({ path: 'logs/ahlsell-login-error.png' }).catch(() => {});
    throw new Error(`Ahlsell login fejlede: ${message}`);
  } finally {
    await page.close();
  }
}