/**
 * mailer.ts
 * Sender en email-oversigt via Resend efter morgenkørslen.
 */

import { Resend } from 'resend';
import { config } from './config';
import { logger } from './logger';
import type { RunSummary, UpdatedOrder } from './types';

let resend: Resend | null = null;

function getClient(): Resend {
  if (!resend) {
    resend = new Resend(config.mail.apiKey);
  }
  return resend;
}

export async function sendMorningReport(
  summary: RunSummary,
  updatedOrders: UpdatedOrder[],
): Promise<void> {
  if (!config.mail.apiKey || !config.mail.to || !config.mail.from) {
    logger.debug('[Mail] RESEND_API_KEY, RESEND_FROM eller RESEND_TO ikke sat – springer email over.');
    return;
  }

  const updatedRows =
    updatedOrders.length > 0
      ? updatedOrders
          .map(
            (o) =>
              `<tr>
                <td style="padding:6px 12px;border-bottom:1px solid #eee;">#${o.orderId}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.carrier}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;">${o.trackingNumber}</td>
              </tr>`,
          )
          .join('')
      : `<tr><td colspan="3" style="padding:8px 12px;color:#888;">Ingen ordrer opdateret denne kørsel</td></tr>`;

  const html = `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#1a1a1a;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">
    Kloakgods Tracking-Bot - Morgenrapport
  </h2>

  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr style="background:#f8f8f8;">
      <td style="padding:8px 12px;font-weight:bold;">Ordrer fundet</td>
      <td style="padding:8px 12px;">${summary.ordersFound}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:bold;">Tracking opdateret</td>
      <td style="padding:8px 12px;color:${summary.trackingUpdated > 0 ? '#2e7d32' : '#888'};">${summary.trackingUpdated}</td>
    </tr>
    <tr style="background:#f8f8f8;">
      <td style="padding:8px 12px;font-weight:bold;">Afventer tracking</td>
      <td style="padding:8px 12px;">${summary.trackingNotReady}</td>
    </tr>
  </table>

  <h3 style="color:#1a1a1a;">Opdaterede ordrer</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#1a1a1a;color:#fff;">
        <th style="padding:8px 12px;text-align:left;">Ordre</th>
        <th style="padding:8px 12px;text-align:left;">Fragtfirma</th>
        <th style="padding:8px 12px;text-align:left;">Trackingnummer</th>
      </tr>
    </thead>
    <tbody>
      ${updatedRows}
    </tbody>
  </table>

  <p style="margin-top:24px;font-size:12px;color:#aaa;">
    Sendt af Kloakgods Tracking-Bot · ${summary.startedAt.toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}
  </p>
</body>
</html>`;

  const textLines = [
    'Kloakgods Tracking-Bot - Morgenrapport',
    '',
    `Ordrer fundet: ${summary.ordersFound}`,
    `Tracking opdateret: ${summary.trackingUpdated}`,
    `Afventer tracking: ${summary.trackingNotReady}`,
    '',
    'Opdaterede ordrer:',
    ...(updatedOrders.length > 0
      ? updatedOrders.map((o) => `- #${o.orderId}: ${o.carrier} / ${o.trackingNumber}`)
      : ['- Ingen ordrer opdateret denne kørsel']),
  ];
  const text = textLines.join('\n');

  try {
    const { data, error } = await getClient().emails.send({
      from: config.mail.from,
      to: [config.mail.to],
      subject: `Tracking rapport: ${summary.trackingUpdated} opdateret, ${summary.trackingNotReady} afventer`,
      html,
      text,
    });

    if (error) {
      logger.warn(`[Mail] Resend returnerede fejl: ${JSON.stringify(error)}`);
    } else {
      logger.info(`[Mail] Morgenrapport sendt til ${config.mail.to} (id: ${data?.id ?? 'ukendt'})`);
    }
  } catch (err: unknown) {
    logger.warn(`[Mail] Kunne ikke sende email: ${err instanceof Error ? err.message : String(err)}`);
  }
}
