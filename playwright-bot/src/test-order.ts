/**
 * test-order.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Hurtigt test-script: slår ét ordre-ID op i WordPress og viser hvad botten
 * ville gøre. Tester IKKE AO/Ahlsell-login – kun WordPress-forbindelsen.
 *
 * Kørsel:
 *   npx ts-node src/test-order.ts --order-id 1234
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

const args = process.argv.slice(2);
const orderIdArg = args[args.indexOf('--order-id') + 1];

if (!orderIdArg || isNaN(Number(orderIdArg))) {
  console.error('\nBrug: npx ts-node src/test-order.ts --order-id <ID>\nEksempel: npx ts-node src/test-order.ts --order-id 33757\n');
  process.exit(1);
}

const ORDER_ID = parseInt(orderIdArg, 10);

const http = axios.create({
  baseURL: `${config.wp.baseUrl}/wp-json/kloakgods/v1`,
  timeout: 15_000,
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': config.wp.apiKey,
  },
});

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log(` Kloakgods Tracking Bot – Ordre test`);
  console.log('══════════════════════════════════════════════');
  console.log(` WordPress URL: ${config.wp.baseUrl}`);
  console.log(` Ordre ID:      #${ORDER_ID}`);
  console.log('══════════════════════════════════════════════\n');

  // ── Trin 1: Hent alle ordrer der mangler tracking ─────────────────────
  console.log('Trin 1: Henter ordrer uden tracking fra WordPress…\n');

  let orders: any[] = [];
  try {
    const res = await http.get('/orders-missing-tracking');
    orders = res.data;
    console.log(`  ✓ Forbundet til WordPress REST API`);
    console.log(`  ✓ Fandt ${orders.length} ordre(r) der mangler tracking totalt\n`);
  } catch (err: any) {
    const status = err?.response?.status;
    const body   = err?.response?.data;

    if (status === 401 || status === 403) {
      console.error('  ✗ ADGANG NÆGTET (401/403)');
      console.error('    → Tjek at WP_API_KEY i .env matcher nøglen fra WooCommerce → Tracking Bot API\n');
    } else if (status === 404) {
      console.error('  ✗ ENDPOINT IKKE FUNDET (404)');
      console.error('    → Er plugin\'et aktiveret i WordPress?\n');
    } else {
      console.error(`  ✗ HTTP-fejl ${status ?? 'UNKNOWN'}:`, body ?? err.message);
    }
    process.exit(1);
  }

  // ── Trin 2: Find den specifikke ordre ─────────────────────────────────
  console.log(`Trin 2: Søger efter ordre #${ORDER_ID} i listen…\n`);

  const match = orders.find((o: any) => o.order_id === ORDER_ID);

  if (match) {
    console.log('  ✓ Ordre fundet og mangler tracking:\n');
    console.log('  ┌─────────────────────────────────────────────');
    console.log(`  │ Ordre ID:      #${match.order_id}`);
    console.log(`  │ AO Reference:  ${match.ao_reference || '(INGEN – skal sættes i ordren!)'}`);
    console.log(`  │ Status:        ${match.status}`);
    console.log(`  │ Dato:          ${match.date}`);
    console.log(`  │ Tjekket:       ${match.check_count} gang(e)`);
    console.log(`  │ Sidst tjekket: ${match.last_checked ?? 'Aldrig'}`);
    console.log('  └─────────────────────────────────────────────\n');

    if (!match.ao_reference) {
      console.warn('  ⚠ ADVARSEL: Ordren har ingen AO-reference. Åbn ordren i');
      console.warn(`    WordPress og udfyld feltet "AO / Ahlsell Reference".\n`);
    } else {
      console.log(`  → Botten ville nu slå "${match.ao_reference}" op på AO/Ahlsell.`);
      console.log('     Kør den fulde bot for at teste AO-login:\n');
      console.log('     npx ts-node src/index.ts --once\n');
    }

  } else {
    // Ordren er ikke i listen – find ud af hvorfor
    console.log(`  ✗ Ordre #${ORDER_ID} er IKKE i listen over ordrer der mangler tracking.\n`);
    console.log('  Mulige årsager:');
    console.log('  1. Ordren har allerede et tracking-nummer → ingen handling nødvendig');
    console.log('  2. Ordren har ingen AO-reference gemt   → åbn ordren og tilføj den');
    console.log(`  3. Ordren har status der ikke hentes    → kun "processing" og "on-hold" hentes`);
    console.log(`  4. Ordren er tjekket for mange gange    → check_count >= MAX_RETRIES_PER_ORDER (${config.bot.maxRetriesPerOrder})\n`);

    // Hent direkte fra WooCommerce REST API for at se ordren
    console.log(`  Forsøger at hente ordre #${ORDER_ID} direkte via WooCommerce API…\n`);
    try {
      const wcRes = await axios.get(
        `${config.wp.baseUrl}/wp-json/wc/v3/orders/${ORDER_ID}`,
        {
          timeout: 10_000,
          headers: { 'X-API-Key': config.wp.apiKey },
          auth: undefined, // WC bruger consumer key/secret – dette er bare info
        }
      );
      const o = wcRes.data;
      console.log(`  (WC API) Status:    ${o.status}`);
      console.log(`  (WC API) Oprettet:  ${o.date_created}`);
    } catch {
      // WC API kræver consumer key – forventet fejl her
      console.log('  (WC direkte API ikke tilgængeligt uden consumer key – det er OK)\n');
    }
  }

  // ── Trin 3: Vis alle fundne ordrer som oversigt ───────────────────────
  if (orders.length > 0) {
    console.log('Trin 3: Alle ordrer der mangler tracking lige nu:\n');
    console.log('  ID       AO Reference   Status         Tjekket');
    console.log('  ──────────────────────────────────────────────────');
    for (const o of orders) {
      const id  = String(o.order_id).padEnd(8);
      const ref = (o.ao_reference || '(ingen)').padEnd(14);
      const st  = o.status.padEnd(14);
      console.log(`  ${id} ${ref} ${st} ${o.check_count}x`);
    }
    console.log('');
  }
}

main().catch((err) => {
  logger.error('Uventet fejl:', err);
  process.exit(1);
});
