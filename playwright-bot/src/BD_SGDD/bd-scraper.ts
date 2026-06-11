import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import type { ScrapeResult, TrackingItem } from '../types';

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function launchAndLogin(): Promise<void> {
  logger.info('[BD] Starter browser...');

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

  try {
    await gotoOrdersPage(page);
    await searchByReference(page, reference);

    const opened = await openOrderFromResults(page, reference);
    if (!opened) {
      await page.screenshot({ path: `logs/bd-order-${reference}-not-found.png`, fullPage: true }).catch(() => {});
      logger.info(`[BD] Kunne ikke finde ordre med reference ${reference}.`);
      return {
        success: false,
        reason: 'not_found',
        message: `Ordre med reference ${reference} kunne ikke findes paa BD`,
      };
    }

    const hasTrackAndTrace = await waitForTrackAndTraceText(page);
    if (!hasTrackAndTrace) {
      await page.screenshot({ path: `logs/bd-order-${reference}-still-loading.png`, fullPage: true }).catch(() => {});
      return {
        success: false,
        reason: 'not_ready',
        message: 'BD ordredetaljen viste ikke Track & Trace teksten endnu',
      };
    }

    const trackingItems = await extractTrackingItems(page);
    if (trackingItems.length === 0) {
      await page.screenshot({ path: `logs/bd-order-${reference}-not-ready.png`, fullPage: true }).catch(() => {});
      const status = await readOrderStatus(page);
      logger.info(`[BD] Ordre ${reference} fundet, men ingen tracking fundet endnu. Status: ${status ?? 'ukendt'}`);
      return {
        success: false,
        reason: 'not_ready',
        message: `BD ordre fundet, men tracking er ikke tilgaengelig endnu${status ? ` (status: ${status})` : ''}`,
      };
    }

    const uniqueTrackingItems = trackingItems.filter((item, index, arr) => {
      const key = `${item.carrier}|${item.trackingNumber}`;
      return arr.findIndex((x) => `${x.carrier}|${x.trackingNumber}` === key) === index;
    });

    const first = uniqueTrackingItems[0];
    logger.info(`[BD] Returnerer ${uniqueTrackingItems.length} trackingnummer/-numre for ${reference}.`);
    return {
      success: true,
      trackingNumber: first.trackingNumber,
      carrier: first.carrier,
      trackingUrl: first.trackingUrl,
      trackingItems: uniqueTrackingItems,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[BD] Fejl ved opslag af ${reference}: ${message}`);
    await page.screenshot({ path: `logs/bd-order-${reference}-error.png`, fullPage: true }).catch(() => {});
    return { success: false, reason: 'error', message };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    logger.info('[BD] Browser lukket.');
  }
}

async function login(): Promise<void> {
  if (!context) throw new Error('Browser context ikke initialiseret.');
  if (!config.bd.username || !config.bd.password) {
    throw new Error('BD_USERNAME/BD_PASSWORD mangler i .env');
  }

  const page = await context.newPage();
  page.setDefaultTimeout(config.bot.pageTimeoutMs);

  try {
    logger.info(`[BD] Logger ind via ${config.bd.loginUrl}`);
    await page.goto(config.bd.loginUrl, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);

    await page
      .locator('button[aria-controls="login-curtain"][aria-label="Login/opret konto"]')
      .first()
      .click({ timeout: 10_000 });

    const loginCurtain = page.locator('.LoginCurtain_loginCurtain__container__Sz69M, form:has(input[data-email-input="true"])').first();
    await loginCurtain.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });

    const usernameInput = loginCurtain
      .locator(
        'input[data-email-input="true"], input[name="email"], input[type="email"]'
      )
      .first();
    const passwordInput = loginCurtain
      .locator('input[data-password-input="true"], input[name="password"], input[type="password"]')
      .first();

    await usernameInput.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });
    await usernameInput.fill(config.bd.username);
    await passwordInput.fill(config.bd.password);

    const submitButton = loginCurtain
      .locator('button[data-testid="loginTest"], button:has-text("Log ind")')
      .first()
    await submitButton.waitFor({ state: 'visible', timeout: config.bot.pageTimeoutMs });
    await submitButton.click();

    await page.waitForFunction(() => {
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const visibleLoginForm = Array.from(document.querySelectorAll('form, .LoginCurtain_loginCurtain__container__Sz69M'))
        .some((el) => isVisible(el) && !!el.querySelector('input[data-email-input="true"], input[data-password-input="true"]'));
      const visibleLoginButton = Array.from(document.querySelectorAll('button[aria-controls="login-curtain"][aria-label="Login/opret konto"]'))
        .some(isVisible);

      return !visibleLoginForm && !visibleLoginButton;
    }, { timeout: config.bot.pageTimeoutMs });

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    logger.info('[BD] Login lykkedes.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[BD] Login fejlede: ${message}`);
    await page.screenshot({ path: 'logs/bd-login-error.png', fullPage: true }).catch(() => {});
    throw new Error(`BD login fejlede: ${message}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function gotoOrdersPage(page: Page): Promise<void> {
  await page.goto(config.bd.ordersUrl, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  const hasOrdersUi = await waitForOrdersUi(page, config.bot.pageTimeoutMs);
  const hasLoginButton = await page
    .locator('button[aria-controls="login-curtain"][aria-label="Login/opret konto"]')
    .first()
    .isVisible()
    .catch(() => false);

  if ((!hasOrdersUi && hasLoginButton) || /login|log-ind/i.test(page.url())) {
    logger.warn('[BD] Session mangler/udloebet - logger ind igen.');
    await login();
    await page.goto(config.bd.ordersUrl, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    const hasOrdersUiAfterLogin = await waitForOrdersUi(page, config.bot.pageTimeoutMs);
    if (!hasOrdersUiAfterLogin) {
      throw new Error('BD ordresiden blev ikke fundet efter login.');
    }
  } else if (!hasOrdersUi) {
    logger.warn('[BD] Ordresidens kendte tekst blev ikke fundet, men siden viser ikke login. Fortsaetter til soegning.');
  }
}

async function waitForOrdersUi(page: Page, timeout: number): Promise<boolean> {
  return await page
    .waitForFunction(() => {
      const visible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const visibleText = Array.from(document.querySelectorAll('button, [role="button"], span, th, input'))
        .filter(visible)
        .map((el) => `${el.textContent ?? ''} ${(el as HTMLInputElement).placeholder ?? ''}`)
        .join('\n');

      return /Reference|Ordrenummer|Ordredato|Ordrer/i.test(visibleText);
    }, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function searchByReference(page: Page, reference: string): Promise<void> {
  logger.debug(`[BD] Soeger efter reference: ${reference}`);

  await clickReferenceFilter(page);

  const searchValue = reference.replace(/^#/, '');
  const searchInput = await findSearchInput(page);
  await searchInput.fill(searchValue);
  await searchInput.press('Enter').catch(async () => {
    await page.locator('button:has-text("Søg"), button:has-text("Search"), button[type="submit"]').first().click();
  });

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await waitForReferenceRow(page, reference, 45_000);

  const foundWithoutHash = await hasReferenceRow(page, reference);
  if (foundWithoutHash || reference.startsWith('#')) return;

  await searchInput.fill(`#${searchValue}`);
  await searchInput.press('Enter').catch(async () => {
    await page.locator('button:has-text("Søg"), button:has-text("Search"), button[type="submit"]').first().click();
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await waitForReferenceRow(page, reference, 20_000);
}

async function hasReferenceRow(page: Page, reference: string): Promise<boolean> {
  return await page.evaluate((ref) => {
    const target = ref.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return Array.from(document.querySelectorAll('tbody tr')).some((row) => {
      const text = (row.textContent ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      return text.includes(target);
    });
  }, reference);
}

async function waitForReferenceRow(page: Page, reference: string, timeout: number): Promise<boolean> {
  return await page
    .waitForFunction((ref) => {
      const target = ref.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      return Array.from(document.querySelectorAll('tbody tr')).some((row) => {
        const text = (row.textContent ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        return text.includes(target);
      });
    }, reference, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function clickReferenceFilter(page: Page): Promise<void> {
  const currentReference = page
    .locator('button:has-text("Reference"), [role="button"]:has-text("Reference"), input[placeholder*="Reference" i]')
    .first();
  if (await currentReference.isVisible().catch(() => false)) {
    return;
  }

  const filterButton = page
    .locator('button:has-text("Ordrenummer"), [role="button"]:has-text("Ordrenummer")')
    .first();
  if (!(await filterButton.isVisible().catch(() => false))) {
    throw new Error('Kunne ikke finde Ordrenummer-filteret paa BD ordresiden.');
  }

  await filterButton.click({ timeout: 5_000 }).catch(async () => {
    await filterButton.click({ force: true, timeout: 5_000 });
  });

  const referenceOption = page
    .locator('button[data-value="reference"][role="radio"], button[data-testid="radio-button"][data-value="reference"]')
    .first();
  await referenceOption.waitFor({ state: 'visible', timeout: 8_000 });
  await referenceOption.click({ timeout: 5_000 }).catch(async () => {
    await referenceOption.click({ force: true, timeout: 5_000 });
  });

  await page.waitForFunction(() => {
    const checkedReference = document.querySelector('button[data-value="reference"][aria-checked="true"]');
    if (checkedReference) return true;

    const text = Array.from(document.querySelectorAll('button, [role="button"], input'))
      .map((el) => `${el.textContent ?? ''} ${(el as HTMLInputElement).placeholder ?? ''}`)
      .join('\n');
    return /Reference/i.test(text);
  }, { timeout: 8_000 }).catch(() => {});
}

async function findSearchInput(page: Page) {
  const candidates = [
    page.locator('input[placeholder*="Reference" i]:visible').first(),
    page.locator('input[placeholder*="Ordrenummer" i]:visible').first(),
    page.locator('input[placeholder*="ordre" i]:visible').first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  throw new Error('Kunne ikke finde søgefeltet paa BD ordresiden.');
}

async function openOrderFromResults(page: Page, reference: string): Promise<boolean> {
  const row = page.locator('tbody tr').filter({ hasText: new RegExp(`#?${escapeRegExp(reference)}`) }).first();
  const rowVisible = await row.isVisible({ timeout: 20_000 }).catch(() => false);
  if (!rowVisible) return false;

  const beforeUrl = page.url();
  const orderNumber = ((await row.locator('td').first().textContent().catch(() => null)) ?? '').trim();
  const href = await row.locator('a[href]').first().getAttribute('href').catch(() => null);

  if (href) {
    await row.locator('a[href]').first().click();
  } else {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const firstCell = row.locator('td').first();

    await firstCell.click({ timeout: 5_000 }).catch(async () => {
      await row.click({ force: true, timeout: 5_000 });
    });

    if (!(await waitForOrderDetails(page, beforeUrl, orderNumber, 6_000))) {
      await firstCell.dblclick({ force: true, timeout: 5_000 }).catch(() => undefined);
    }

    if (!(await waitForOrderDetails(page, beforeUrl, orderNumber, 6_000))) {
      await row.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return await waitForOrderDetails(page, beforeUrl, orderNumber, config.bot.pageTimeoutMs);
}

async function waitForOrderDetails(page: Page, beforeUrl: string, orderNumber: string, timeout: number): Promise<boolean> {
  return await page
    .waitForFunction(({ oldUrl, orderNo }) => {
      const text = document.body?.innerText ?? '';
      const stillOnResultTable = !!document.querySelector('section[class*="AdvancedTable_advancedTable"] tbody tr');
      const urlChanged = window.location.href !== oldUrl;
      const hasDetailText = /Ordredetaljer|Ordrelinjer|Leveringer|Track|Trace|Faktura|Genbestil|Leveringsadresse/i.test(text);
      const hasOrderNo = orderNo.length > 0 && text.includes(orderNo);

      return urlChanged || (hasOrderNo && hasDetailText && !stillOnResultTable);
    }, { oldUrl: beforeUrl, orderNo: orderNumber }, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForTrackAndTraceText(page: Page): Promise<boolean> {
  await page.waitForTimeout(16_000);

  return await page
    .waitForFunction(() => {
      const text = document.body?.innerText ?? '';
      return /Track\s*&\s*Trace\s+[A-Z0-9-]{6,}/i.test(text);
    }, { timeout: 75_000 })
    .then(() => true)
    .catch(() => false);
}

async function extractTrackingItems(page: Page): Promise<TrackingItem[]> {
  return await page.evaluate(() => {
    const items: TrackingItem[] = [];
    const trackingHosts = [
      'postnord',
      'gls',
      'dao',
      'bring',
      'dhl',
      'fragt',
      'track',
      'trace',
      'tracking',
    ];

    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.href;
      const text = (anchor.textContent ?? '').trim();
      const haystack = `${href} ${text}`.toLowerCase();
      if (!trackingHosts.some((host) => haystack.includes(host))) continue;

      const trackingNumber = extractTrackingNumber(href, text);
      if (!trackingNumber) continue;
      items.push({
        trackingNumber,
        carrier: detectCarrier(href, text, trackingNumber),
        trackingUrl: href,
      });
    }

    const bodyText = document.body?.innerText ?? '';
    const trackAndTraceMatch = bodyText.match(/Track\s*&\s*Trace\s+([A-Z0-9-]{6,})/i);
    if (trackAndTraceMatch?.[1]) {
      const trackingNumber = trackAndTraceMatch[1].toUpperCase();
      items.push({
        trackingNumber,
        carrier: detectCarrier('', bodyText, trackingNumber),
      });
    }

    const labelMatch = bodyText.match(/(?:Track\s*&\s*Trace|Track and Trace|Tracking|Pakkenummer|Fragtbrevsnummer)\s*:?\s*([A-Z0-9-]{8,})/i);
    if (labelMatch?.[1]) {
      const trackingNumber = labelMatch[1].toUpperCase();
      items.push({
        trackingNumber,
        carrier: detectCarrier('', bodyText, trackingNumber),
      });
    }

    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.carrier}|${item.trackingNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    function extractTrackingNumber(href: string, text: string): string | null {
      const decoded = decodeURIComponent(href);
      const params = ['id', 'match', 'trackingNumber', 'trackingnumber', 'parcel', 'parcelNumber', 'bookingRef', 'reference'];
      for (const param of params) {
        const match = decoded.match(new RegExp(`[?&]${param}=([^&#]+)`, 'i'));
        if (match?.[1] && /^[A-Z0-9-]{8,}$/i.test(match[1])) return match[1].toUpperCase();
      }

      const pathMatch = decoded.match(/\/([A-Z0-9]{10,})(?:[/?#]|$)/i);
      if (pathMatch?.[1]) return pathMatch[1].toUpperCase();

      const textMatch = text.match(/\b([A-Z]{2}\d{8,}[A-Z]{0,2}|\d{10,}|\d{3,}-\d{3,})\b/i);
      return textMatch?.[1]?.toUpperCase() ?? null;
    }

    function detectCarrier(href: string, text: string, trackingNumber: string): string {
      const haystack = `${href} ${text}`.toLowerCase();
      if (haystack.includes('postnord')) return 'PostNord';
      if (haystack.includes('gls')) return 'GLS';
      if (haystack.includes('dao')) return 'DAO';
      if (haystack.includes('bring')) return 'Bring';
      if (haystack.includes('dhl')) return 'DHL';
      if (haystack.includes('fragt')) return 'Danske Fragtmaend';
      if (/^FM\d{6,}$/i.test(trackingNumber)) return 'Danske Fragtmaend';
      if (/^00370\d{9,}$/.test(trackingNumber)) return 'GLS';
      if (/^[A-Z]{2}\d{9}DK$/i.test(trackingNumber)) return 'PostNord';
      return 'Ukendt';
    }
  });
}

async function readOrderStatus(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const match = text.match(/Status\s*:?\s*([^\n]+)/i);
    if (match?.[1]) return match[1].trim();

    const row = Array.from(document.querySelectorAll('tbody tr')).find((tr) =>
      /Afsluttet|Afsendt|Leveret|Under behandling|Annulleret/i.test(tr.textContent ?? '')
    );
    const rowText = row?.textContent ?? '';
    const statusMatch = rowText.match(/(Afsluttet|Afsendt|Leveret|Under behandling|Annulleret)/i);
    return statusMatch?.[1] ?? null;
  });
}

async function acceptCookies(page: Page): Promise<void> {
  await page
    .locator(
      '.coi-consent-banner__agree-button, button:has-text("Accepter alle cookies"), button:has-text("Accepter alle"), button:has-text("Accept all"), button:has-text("Tillad alle"), .coi-banner__accept'
    )
    .first()
    .click({ timeout: 5_000 })
    .catch(() => undefined);

  await page
    .locator('.coi-consent-banner, #coiOverlay')
    .first()
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => undefined);
}

function normalizeReference(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
