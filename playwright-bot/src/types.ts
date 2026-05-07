// ============================================================
// Shared TypeScript types for the Kloakgods tracking bot
// ============================================================

/**
 * A WooCommerce order that is missing a tracking number,
 * as returned by GET /wp-json/kloakgods/v1/orders-missing-tracking
 */
export interface OrderMissingTracking {
  order_id: number;
  ao_reference: string;
  status: string;
  date: string;          // ISO-8601
  check_count: number;
  last_checked: string | null;  // ISO-8601 or null
}

/**
 * Payload for POST /wp-json/kloakgods/v1/update-tracking
 */
export interface UpdateTrackingPayload {
  order_id: number;
  tracking_number: string;
  carrier: string;
}

/**
 * Response from POST /wp-json/kloakgods/v1/update-tracking
 */
export interface UpdateTrackingResponse {
  success: boolean;
  order_id: number;
  tracking: {
    tracking_provider: string;
    custom_tracking_provider: string;
    custom_tracking_link: string;
    tracking_number: string;
    date_shipped: string;
  };
}

/**
 * Et enkelt tracking-punkt (én forsendelse / ét fragtbrev)
 */
export interface TrackingItem {
  trackingNumber: string;
  carrier: string;
  trackingUrl?: string;
}

/**
 * Result of a single scrape attempt against AO/Ahlsell.
 * trackingItems indeholder ALLE forsendelser fundet på ordren (kan være flere).
 * trackingNumber / carrier / trackingUrl peger på det første element (bagud-kompatibilitet).
 */
export type ScrapeResult =
  | { success: true;  trackingNumber: string; carrier: string; trackingUrl?: string; trackingItems: TrackingItem[] }
  | { success: false; reason: 'not_found' | 'not_ready' | 'login_failed' | 'error'; message?: string };

/**
 * Summary logged at the end of each bot run
 */
export interface RunSummary {
  ordersFound: number;
  trackingUpdated: number;
  trackingNotReady: number;
  errors: number;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * En ordre hvor tracking er blevet opdateret i denne kørsel
 */
export interface UpdatedOrder {
  orderId: number;
  carrier: string;
  trackingNumber: string;
}
