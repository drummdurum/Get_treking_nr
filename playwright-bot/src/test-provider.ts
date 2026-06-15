import dotenv from 'dotenv';
dotenv.config();

import {
  closeBrowser as closeAoBrowser,
  getTrackingForOrder as getAoTrackingForOrder,
  launchAndLogin as launchAoAndLogin,
} from './ao/ao-scraper';
import {
  closeBrowser as closeAhlsellBrowser,
  getTrackingForOrder as getAhlsellTrackingForOrder,
  launchAndLogin as launchAhlsellAndLogin,
} from './ashley/ashley';
import {
  closeBrowser as closeBdBrowser,
  getTrackingForOrder as getBdTrackingForOrder,
  launchAndLogin as launchBdAndLogin,
} from './BD_SGDD/bd-scraper';
import { trackingNumbersEqual } from './tracking-utils';
import type { ScrapeResult } from './types';

type ProviderName = 'ao' | 'ahlsell' | 'bd';

interface Provider {
  launchAndLogin: () => Promise<void>;
  getTrackingForOrder: (reference: string) => Promise<ScrapeResult>;
  closeBrowser: () => Promise<void>;
}

const providers: Record<ProviderName, Provider> = {
  ao: {
    launchAndLogin: launchAoAndLogin,
    getTrackingForOrder: getAoTrackingForOrder,
    closeBrowser: closeAoBrowser,
  },
  ahlsell: {
    launchAndLogin: launchAhlsellAndLogin,
    getTrackingForOrder: getAhlsellTrackingForOrder,
    closeBrowser: closeAhlsellBrowser,
  },
  bd: {
    launchAndLogin: launchBdAndLogin,
    getTrackingForOrder: getBdTrackingForOrder,
    closeBrowser: closeBdBrowser,
  },
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function readProvider(): ProviderName {
  const value = (readArg('provider') ?? '').toLowerCase();
  if (value === 'ao' || value === 'ahlsell' || value === 'bd') return value;
  throw new Error('Brug --provider ao|ahlsell|bd');
}

function printResult(providerName: ProviderName, reference: string, expected: string | undefined, result: ScrapeResult): void {
  console.log('\nProvider test resultat');
  console.log('='.repeat(60));
  console.log(`Provider:  ${providerName}`);
  console.log(`Reference: ${reference}`);
  console.log(`Forventet: ${expected ?? '(ikke angivet)'}`);
  console.log(`Success:   ${result.success ? 'JA' : 'NEJ'}`);

  if (result.success) {
    console.log(`Carrier:   ${result.carrier}`);
    console.log(`Tracking:  ${result.trackingNumber}`);
    console.log(`URL:       ${result.trackingUrl ?? '(ingen)'}`);
    console.log(`Items:     ${result.trackingItems.length}`);
    for (const item of result.trackingItems) {
      console.log(`  - ${item.carrier} / ${item.trackingNumber} / ${item.trackingUrl ?? '(ingen URL)'}`);
    }

    if (expected) {
      const found = result.trackingItems.some((item) => trackingNumbersEqual(item.trackingNumber, expected));
      console.log(`Match:     ${found ? 'JA' : 'NEJ'}`);
      if (!found) process.exitCode = 2;
    }
  } else {
    console.log(`Reason:    ${result.reason}`);
    console.log(`Message:   ${result.message ?? '(ingen)'}`);
    process.exitCode = 1;
  }

  console.log('\nRaw JSON');
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const providerName = readProvider();
  const reference = readArg('ref') ?? readArg('reference');
  const expected = readArg('expected');

  if (!reference) throw new Error('Brug --ref <ordre/reference>');

  const provider = providers[providerName];
  try {
    console.log(`Starter ${providerName} test for reference ${reference}...`);
    await provider.launchAndLogin();
    const result = await provider.getTrackingForOrder(reference);
    printResult(providerName, reference, expected, result);
  } finally {
    await provider.closeBrowser().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('Provider test fatal fejl:', err);
  process.exitCode = 1;
});
