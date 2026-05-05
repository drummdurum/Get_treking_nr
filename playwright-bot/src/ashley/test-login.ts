/**
 * test-login.ts
 * Quick Ahlsell login + order lookup test.
 *
 * Usage:
 *   npx ts-node src/ashley/test-login.ts --reference 33782 --expected ER120479
 */

import dotenv from 'dotenv';
dotenv.config();

import { closeBrowser, getTrackingForOrder, launchAndLogin } from './ashley';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const reference = getArg('--reference') ?? '33782';
  const expected = (getArg('--expected') ?? 'ER120479').toUpperCase();

  console.log('============================================');
  console.log(' Ahlsell login/lookup test');
  console.log('============================================');
  console.log(` Reference: ${reference}`);
  console.log(` Expected:  ${expected}`);
  console.log('============================================\n');

  try {
    console.log('1) Launch + login...');
    await launchAndLogin();
    console.log('   OK: Login succeeded.\n');

    console.log('2) Lookup tracking...');
    const result = await getTrackingForOrder(reference);

    if (!result.success) {
      console.error(`   FAIL: Lookup failed (${result.reason}) ${result.message ?? ''}`.trim());
      process.exitCode = 1;
      return;
    }

    const allNumbers = result.trackingItems.map((x) => x.trackingNumber.toUpperCase());
    console.log(`   Found tracking numbers: ${allNumbers.join(', ') || '(none)'}`);

    if (allNumbers.includes(expected)) {
      console.log(`   PASS: Expected tracking ${expected} found.`);
      process.exitCode = 0;
      return;
    }

    console.error(`   FAIL: Expected tracking ${expected} not found.`);
    process.exitCode = 2;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  } finally {
    await closeBrowser().catch(() => {});
  }
}

main();
