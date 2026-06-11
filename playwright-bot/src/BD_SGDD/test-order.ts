import '../config';
import { logger } from '../logger';
import { closeBrowser, getTrackingForOrder, launchAndLogin } from './bd-scraper';

const reference = process.argv[2] ?? '47870';

async function main(): Promise<void> {
  await launchAndLogin();
  const result = await getTrackingForOrder(reference);
  logger.info(`[BD test] Resultat for ${reference}: ${JSON.stringify(result, null, 2)}`);
}

main()
  .catch((err) => {
    logger.error('[BD test] Fatal fejl:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser().catch(() => undefined);
  });
