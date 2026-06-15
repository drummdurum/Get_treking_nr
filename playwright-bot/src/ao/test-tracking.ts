import dotenv from 'dotenv';
dotenv.config();

import { closeBrowser, getTrackingForOrder, launchAndLogin } from './ao-scraper';

const argOrder = process.argv.find((a) => /^--order=/.test(a));
const argExpected = process.argv.find((a) => /^--expected=/.test(a));

const AO_ORDER_REF = argOrder ? argOrder.split('=')[1] : process.env.AO_ORDER_REF || '33953';
const EXPECTED_TRACKING = argExpected ? argExpected.split('=')[1] : process.env.EXPECTED_TRACKING;

async function main() {
  console.log('\nAO Tracking test');
  console.log('='.repeat(42));
  console.log(`Ordrenummer:   ${AO_ORDER_REF}`);
  console.log(`Forventet T&T: ${EXPECTED_TRACKING ?? '(ikke angivet)'}`);
  console.log('='.repeat(42));

  try {
    console.log('\nLogger ind paa AO...');
    await launchAndLogin();
    console.log('Login OK');

    console.log(`\nSlaar op: ${AO_ORDER_REF}...`);
    const result = await getTrackingForOrder(AO_ORDER_REF);

    console.log('\nResultat');
    console.log('-'.repeat(42));
    console.log(JSON.stringify(result, null, 2));
    console.log('-'.repeat(42));

    if (result.success) {
      const match = EXPECTED_TRACKING ? result.trackingNumber === EXPECTED_TRACKING : undefined;
      console.log(`\nOK Tracking fundet: ${result.trackingNumber} (${result.carrier})`);
      if (match !== undefined) {
        console.log(match
          ? `OK MATCH - tracker stemmer overens med forventet ${EXPECTED_TRACKING}`
          : `FEJL MISMATCH - forventede ${EXPECTED_TRACKING}, fik ${result.trackingNumber}`
        );
      }
    } else {
      console.error(`\nIngen tracking: [${result.reason}] ${result.message}`);
    }
  } catch (err) {
    console.error('\nFEJL:', err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

main();
