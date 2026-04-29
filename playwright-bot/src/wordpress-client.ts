import axios, { AxiosInstance } from 'axios';
import { config } from './config';
import { logger } from './logger';
import type {
  OrderMissingTracking,
  UpdateTrackingPayload,
  UpdateTrackingResponse,
} from './types';

// ---------------------------------------------------------------------------
// Axios instance – all requests go through this with the API key header
// ---------------------------------------------------------------------------

const http: AxiosInstance = axios.create({
  baseURL: `${config.wp.baseUrl}/wp-json/kloakgods/v1`,
  timeout: 15_000,
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': config.wp.apiKey,
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all WooCommerce orders that have an AO reference but no tracking number.
 */
export async function getOrdersMissingTracking(): Promise<OrderMissingTracking[]> {
  try {
    const response = await http.get<OrderMissingTracking[]>(
      '/orders-missing-tracking',
      { params: { max_checks: config.bot.maxRetriesPerOrder } }
    );
    return response.data;
  } catch (err) {
    logger.error('Fejl ved hentning af ordrer fra WordPress:', err);
    throw err;
  }
}

/**
 * Post a tracking number back to WordPress / WooCommerce.
 */
export async function postTracking(
  payload: UpdateTrackingPayload
): Promise<UpdateTrackingResponse> {
  try {
    const response = await http.post<UpdateTrackingResponse>(
      '/update-tracking',
      payload
    );
    logger.info(
      `Tracking gemt på ordre #${payload.order_id}: ` +
      `${payload.carrier} / ${payload.tracking_number}`
    );
    return response.data;
  } catch (err) {
    logger.error(`Fejl ved opdatering af tracking på ordre #${payload.order_id}:`, err);
    throw err;
  }
}

/**
 * Tell WordPress that the bot checked this order but tracking isn't ready yet.
 * Increments the check-counter so we stop after MAX_RETRIES_PER_ORDER attempts.
 */
export async function markOrderChecked(orderId: number): Promise<void> {
  try {
    await http.post('/mark-checked', { order_id: orderId });
    logger.debug(`Ordre #${orderId} markeret som tjekket (ingen tracking endnu).`);
  } catch (err) {
    logger.warn(`Kunne ikke markere ordre #${orderId} som tjekket:`, err);
    // Non-critical – don't rethrow
  }
}
