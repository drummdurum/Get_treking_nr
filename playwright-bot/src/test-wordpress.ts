/**
 * test-wordpress.ts
 * Tester forbindelsen til WordPress REST API og de to endpoints.
 * Kør: npx ts-node src/test-wordpress.ts
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = (process.env.WP_BASE_URL ?? '').replace(/\/$/, '');
const API_KEY  = process.env.WP_API_KEY ?? '';

const http = axios.create({
  baseURL: `${BASE_URL}/wp-json/kloakgods/v1`,
  timeout: 10_000,
  headers: { 'X-API-Key': API_KEY },
});

async function main() {
  console.log('══════════════════════════════════════════');
  console.log(' WordPress API test');
  console.log('══════════════════════════════════════════');
  console.log(` URL:     ${BASE_URL}/wp-json/kloakgods/v1`);
  console.log(` API-key: ${API_KEY ? API_KEY.slice(0, 6) + '…' : '(mangler!)'}`);
  console.log('══════════════════════════════════════════\n');

  // ── 1. GET /orders-missing-tracking ──────────────────────────────────────
  console.log('▶ GET /orders-missing-tracking…');
  try {
    const res = await http.get('/orders-missing-tracking');
    const orders = res.data as unknown[];
    console.log(`✓ ${orders.length} ordre(r) mangler tracking:`);
    console.log(JSON.stringify(orders, null, 2));
  } catch (err: any) {
    const status  = err.response?.status;
    const message = err.response?.data?.message ?? err.message;
    if (status === 401 || status === 403) {
      console.error(`✗ Adgang nægtet (${status}) – tjek at plugin er installeret og API-nøglen er korrekt`);
    } else if (status === 404) {
      console.error(`✗ Endpoint ikke fundet (404) – er plugin'et aktiveret på ${BASE_URL}?`);
    } else {
      console.error(`✗ Fejl: ${status ?? ''} ${message}`);
    }
  }

  // ── 2. Hurtig ping – WP REST base ────────────────────────────────────────
  console.log('\n▶ GET /wp-json (WP REST API heartbeat)…');
  try {
    const res = await axios.get(`${BASE_URL}/wp-json`, { timeout: 8_000 });
    const name = (res.data as any)?.name ?? '?';
    console.log(`✓ WordPress svarer: "${name}"`);
  } catch (err: any) {
    console.error(`✗ WordPress ikke tilgængeligt: ${err.message}`);
  }
}

main().catch(console.error);
