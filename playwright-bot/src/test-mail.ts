/**
 * test-mail.ts
 * Kør med: npx ts-node src/test-mail.ts
 */

import { sendMorningReport } from './mailer';
import { config } from './config';

async function main() {
  console.log('Sender test-email...');

  await sendMorningReport(
    {
      ordersFound: 5,
      trackingUpdated: 3,
      trackingNotReady: 1,
      errors: 1,
      startedAt: new Date(Date.now() - 42000),
      finishedAt: new Date(),
    },
    [
      { orderId: 1234, carrier: 'GLS', trackingNumber: 'TEST123456789' },
      { orderId: 1235, carrier: 'PostNord', trackingNumber: 'TEST987654321' },
      { orderId: 1236, carrier: 'AO', trackingNumber: 'AO-ABC-001' },
    ],
  );

  console.log(`Faerdig - tjek din indbakke pa ${config.mail.to || '(RESEND_TO mangler i .env)'}`);
}

main().catch(console.error);
