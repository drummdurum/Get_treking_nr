/**
 * test-tracking.ts – tester AO ordresøgning + Track & Trace opslag.
 *
 * Kørsel (fra playwright-bot/):
 *   npx ts-node src/test-tracking.ts
 *
 * Ændre AO_ORDER_REF og EXPECTED_TRACKINGS_RAW nedenfor til det ordre du vil teste.
 */

import dotenv from 'dotenv';
dotenv.config();

import { launchAndLogin, getTrackingForOrder, closeBrowser } from './ao-scraper';

const AO_ORDER_REF = '33733';
const EXPECTED_TRACKINGS_RAW = ['FW827450', 'FW827447', 'FW827450'];

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log(' AO Tracking test');
  console.log('══════════════════════════════════════════');
  console.log(` Ordrenummer:      ${AO_ORDER_REF}`);
  console.log(` Forventet T&T:    ${EXPECTED_TRACKINGS_RAW.join(', ')}`);
  console.log('══════════════════════════════════════════\n');

  try {
    console.log('▶ Logger ind på AO…');
    await launchAndLogin();
    console.log('✓ Login OK\n');

    console.log(`▶ Slår op: ${AO_ORDER_REF}…`);
    const result = await getTrackingForOrder(AO_ORDER_REF);

    console.log('\n── Resultat ──────────────────────────────');
    console.log(JSON.stringify(result, null, 2));
    console.log('──────────────────────────────────────────');

    if (result.success) {
      const actualRaw = (result.trackingItems?.length ? result.trackingItems : [
        {
          trackingNumber: result.trackingNumber,
          carrier: result.carrier,
          trackingUrl: result.trackingUrl,
        },
      ]).map((item) => item.trackingNumber);

      const expectedUnique = Array.from(new Set(EXPECTED_TRACKINGS_RAW));
      const actualUnique = Array.from(new Set(actualRaw));

      const missing = expectedUnique.filter((n) => !actualUnique.includes(n));
      const unexpected = actualUnique.filter((n) => !expectedUnique.includes(n));

      console.log(`\n✓ Tracking fundet (${actualRaw.length} rå / ${actualUnique.length} unikke):`);
      console.log(`  Rå:      ${actualRaw.join(', ')}`);
      console.log(`  Unikke:  ${actualUnique.join(', ')}`);

      if (EXPECTED_TRACKINGS_RAW.length !== expectedUnique.length) {
        console.log(
          `ℹ Duplicate forventning opdaget (${EXPECTED_TRACKINGS_RAW.length} rå -> ${expectedUnique.length} unikke)`
        );
      }

      if (missing.length === 0 && unexpected.length === 0) {
        console.log(`✓ MATCH – alle forventede trackingnumre blev fundet: ${expectedUnique.join(', ')}`);
      } else {
        if (missing.length > 0) {
          console.log(`✗ MANGLER – ${missing.join(', ')}`);
        }
        if (unexpected.length > 0) {
          console.log(`✗ UVENTEDE – ${unexpected.join(', ')}`);
        }
      }
    } else {
      console.error(`\n✗ Ingen tracking: [${result.reason}] ${result.message}`);
    }
  } catch (err) {
    console.error('\n✗ FEJL:', err);
  } finally {
    await closeBrowser();
  }
}

main();
