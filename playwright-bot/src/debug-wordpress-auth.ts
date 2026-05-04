/**
 * debug-wordpress-auth.ts
 *
 * Formål:
 * - Verificere at WordPress plugin-endpoints svarer
 * - Verificere hvilket header-navn der accepteres (X-API-Key vs X-KG-API-Key)
 * - Verificere hvilken env key der bliver brugt (WP_API_KEY eller KG_TRACKING_API_KEY)
 *
 * Kør:
 *   npm run debug:wp
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const baseUrl = (process.env.WP_BASE_URL ?? '').replace(/\/$/, '');
const wpApiKey = process.env.WP_API_KEY ?? '';
const kgTrackingApiKey = process.env.KG_TRACKING_API_KEY ?? '';
const activeKey = wpApiKey || kgTrackingApiKey;

function mask(value: string): string {
  if (!value) return '(mangler)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function testRequest(headerName: 'X-API-Key' | 'X-KG-API-Key'): Promise<void> {
  const url = `${baseUrl}/wp-json/kloakgods/v1/orders-missing-tracking`;
  try {
    const res = await axios.get(url, {
      timeout: 12_000,
      headers: {
        [headerName]: activeKey,
      },
      params: {
        max_checks: 10,
      },
    });

    const count = Array.isArray(res.data) ? res.data.length : 0;
    console.log(`OK   ${headerName}: status ${res.status}, ordrer returneret: ${count}`);
  } catch (err: any) {
    const status = err?.response?.status ?? 'ingen-status';
    const data = err?.response?.data;
    const msg = data?.message || err?.message || 'ukendt fejl';
    console.log(`FAIL ${headerName}: status ${status}, fejl: ${msg}`);
  }
}

async function testWpRestRoot(): Promise<void> {
  const url = `${baseUrl}/wp-json`;
  try {
    const res = await axios.get(url, { timeout: 10_000 });
    const name = res?.data?.name ?? '(ukendt navn)';
    console.log(`OK   WP REST root: status ${res.status}, site: ${name}`);
  } catch (err: any) {
    const status = err?.response?.status ?? 'ingen-status';
    const msg = err?.response?.data?.message || err?.message || 'ukendt fejl';
    console.log(`FAIL WP REST root: status ${status}, fejl: ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('WordPress Plugin API debug');
  console.log('========================================');
  console.log(`WP_BASE_URL           : ${baseUrl || '(mangler)'}`);
  console.log(`WP_API_KEY            : ${mask(wpApiKey)}`);
  console.log(`KG_TRACKING_API_KEY   : ${mask(kgTrackingApiKey)}`);
  console.log(`Aktiv key-kilde       : ${wpApiKey ? 'WP_API_KEY' : (kgTrackingApiKey ? 'KG_TRACKING_API_KEY' : '(ingen)')}`);
  console.log('');

  if (!baseUrl) {
    console.error('Stop: WP_BASE_URL mangler i .env');
    process.exitCode = 1;
    return;
  }

  if (!activeKey) {
    console.error('Stop: Både WP_API_KEY og KG_TRACKING_API_KEY mangler i .env');
    process.exitCode = 1;
    return;
  }

  await testWpRestRoot();
  await testRequest('X-API-Key');
  await testRequest('X-KG-API-Key');

  console.log('');
  console.log('Fortolkning:');
  console.log('- Hvis X-API-Key er OK og X-KG-API-Key fejler, forventer pluginet X-API-Key.');
  console.log('- Hvis begge fejler med 404/403, er plugin ikke aktivt eller key matcher ikke i WP.');
}

main().catch((err) => {
  console.error('Fatal fejl i debug-script:', err);
  process.exitCode = 1;
});
