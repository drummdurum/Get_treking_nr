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
    // Send both header variants to support both deployed and local plugin versions.
    'X-API-Key': config.wp.apiKey,
    'X-KG-API-Key': config.wp.apiKey,
  },
  // Strip any PHP warnings / HTML output before the JSON (can happen if plugin
  // file has a BOM or whitespace before <?php on the server).
  transformResponse: [(data: unknown) => {
    if (typeof data !== 'string') return data;
    const jsonStart = data.indexOf('[');
    const jsonStartObj = data.indexOf('{');
    const idx = jsonStart === -1 ? jsonStartObj
               : jsonStartObj === -1 ? jsonStart
               : Math.min(jsonStart, jsonStartObj);
    if (idx > 0) {
      try { return JSON.parse(data.slice(idx)); } catch { /* fall through */ }
    }
    try { return JSON.parse(data); } catch { return data; }
  }],
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
  } catch (err: any) {
    logger.error(`Fejl ved opdatering af tracking på ordre #${payload.order_id}:`, err);
    // Axios fejl: prøv at udtrække fejlbesked fra response
    if (err.response && err.response.data) {
      // Prøv at returnere error-objektet fra API'et
      return {
        success: false,
        error: {
          code: err.response.data.code || err.response.data.data?.status || 'unknown',
          message: err.response.data.message || 'Ukendt fejl fra API',
        },
        order_id: payload.order_id,
      } as any;
    }
    // Anden fejl (fx netværk)
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err.message || 'Netværksfejl',
      },
      order_id: payload.order_id,
    } as any;
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
