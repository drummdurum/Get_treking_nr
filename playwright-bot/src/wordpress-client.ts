import axios, { AxiosInstance } from 'axios';
import { config } from './config';
import { logger } from './logger';
import type {
  OrderMissingTracking,
  UpdateTrackingPayload,
  UpdateTrackingResponse,
} from './types';

// ---------------------------------------------------------------------------
// Axios instance - all requests go through this with the API key header
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
      `Tracking gemt paa ordre #${payload.order_id}: ` +
      `${payload.carrier} / ${payload.tracking_number}`
    );
    return response.data;
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const responseData = err.response?.data;
      logger.error(`Fejl ved opdatering af tracking paa ordre #${payload.order_id}: WordPress API svarede med fejl`, {
        order_id: payload.order_id,
        carrier: payload.carrier,
        tracking_number: payload.tracking_number,
        status: err.response?.status,
        statusText: err.response?.statusText,
        response: responseData,
        code: err.code,
        message: err.message,
      });

      if (responseData) {
        const responseObject = typeof responseData === 'object' ? responseData as any : {};
        const message = responseObject.message || (typeof responseData === 'string' ? responseData : 'Ukendt fejl fra API');

        return {
          success: false,
          error: {
            code: responseObject.code || responseObject.data?.status || err.response?.status || 'unknown',
            message,
          },
          order_id: payload.order_id,
        } as any;
      }

      return {
        success: false,
        error: {
          code: err.code || 'wordpress_api_error',
          message: err.message || 'Ukendt fejl fra WordPress API',
        },
        order_id: payload.order_id,
      } as any;
    }

    logger.error(`Fejl ved opdatering af tracking paa ordre #${payload.order_id}:`, err);
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err.message || 'Netvaerksfejl',
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
    // Non-critical - don't rethrow
  }
}
