<?php
/**
 * Plugin Name: Kloakgods Tracking API
 * Description: Custom REST API endpoints for AO/Ahlsell tracking automation via Playwright bot
 * Version:     1.0.0
 * Author:      Kloakgods
 * Text Domain: kloakgods-tracking
 */

defined( 'ABSPATH' ) || exit;

class Kloakgods_Tracking_API {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /** WordPress option key where the API key is stored */
    const OPTION_API_KEY = 'kloakgods_tracking_api_key';

    /** Order meta: AO/Ahlsell reference number */
    const META_AO_REFERENCE = '_ao_reference_number';

    /** Order meta: ISO-8601 timestamp of last tracking check by the bot */
    const META_CHECKED_AT = '_ao_tracking_checked_at';

    /** Order meta: How many times the bot has attempted to find tracking */
    const META_CHECK_COUNT = '_ao_tracking_check_count';

    /**
     * WooCommerce Shipment Tracking plugin meta key.
     * Each item: ['tracking_provider','custom_tracking_provider',
     *             'tracking_number','date_shipped','custom_url']
     */
    const META_WC_TRACKING = '_wc_shipment_tracking_items';

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    public function __construct() {
        add_action( 'rest_api_init',                   [ $this, 'register_routes' ] );
        add_action( 'admin_menu',                      [ $this, 'add_admin_page' ] );
        add_action( 'admin_init',                      [ $this, 'register_settings' ] );
        add_action( 'add_meta_boxes',                  [ $this, 'add_ao_meta_box' ] );
        add_action( 'woocommerce_process_shop_order_meta', [ $this, 'save_ao_meta_box' ] );
        // HPOS (WooCommerce 7+) compatibility
        add_action( 'woocommerce_process_shop_order_meta', [ $this, 'save_ao_meta_box' ] );
    }

    // -------------------------------------------------------------------------
    // REST routes
    // -------------------------------------------------------------------------

    public function register_routes() {
        register_rest_route( 'kloakgods/v1', '/orders-missing-tracking', [
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => [ $this, 'get_orders_missing_tracking' ],
            'permission_callback' => [ $this, 'check_api_key' ],
        ] );

        register_rest_route( 'kloakgods/v1', '/update-tracking', [
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => [ $this, 'update_tracking' ],
            'permission_callback' => [ $this, 'check_api_key' ],
            'args'                => [
                'order_id'        => [ 'required' => true, 'type' => 'integer', 'minimum' => 1 ],
                'tracking_number' => [ 'required' => true, 'type' => 'string',  'sanitize_callback' => 'sanitize_text_field' ],
                'carrier'         => [ 'required' => true, 'type' => 'string',  'sanitize_callback' => 'sanitize_text_field' ],
            ],
        ] );

        // Convenience: mark an order as "checked" without a tracking number yet
        register_rest_route( 'kloakgods/v1', '/mark-checked', [
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => [ $this, 'mark_checked' ],
            'permission_callback' => [ $this, 'check_api_key' ],
            'args'                => [
                'order_id' => [ 'required' => true, 'type' => 'integer', 'minimum' => 1 ],
            ],
        ] );
    }

    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    public function check_api_key( WP_REST_Request $request ): bool {
        $stored_key = get_option( self::OPTION_API_KEY, '' );

        if ( empty( $stored_key ) ) {
            return false;
        }

        $provided_key = $request->get_header( 'X-API-Key' );

        // Use timing-safe comparison to prevent timing attacks
        return hash_equals( $stored_key, (string) $provided_key );
    }

    // -------------------------------------------------------------------------
    // GET /orders-missing-tracking
    // -------------------------------------------------------------------------

    public function get_orders_missing_tracking( WP_REST_Request $request ): WP_REST_Response {
        $max_checks = (int) $request->get_param( 'max_checks' ) ?: 10; // skip orders checked too many times

        $orders = wc_get_orders( [
            'status'     => [ 'processing', 'on-hold' ],
            'limit'      => 50,
            'meta_query' => [
                'relation' => 'AND',
                [
                    'key'     => self::META_AO_REFERENCE,
                    'value'   => '',
                    'compare' => '!=',
                ],
                [
                    'relation' => 'OR',
                    // No check-count key at all (never checked)
                    [
                        'key'     => self::META_CHECK_COUNT,
                        'compare' => 'NOT EXISTS',
                    ],
                    // Or check count below threshold
                    [
                        'key'     => self::META_CHECK_COUNT,
                        'value'   => $max_checks,
                        'compare' => '<',
                        'type'    => 'NUMERIC',
                    ],
                ],
            ],
        ] );

        $result = [];

        foreach ( $orders as $order ) {
            // Skip orders that already have tracking stored
            if ( $this->order_has_tracking( $order ) ) {
                continue;
            }

            $result[] = [
                'order_id'     => $order->get_id(),
                'ao_reference' => $order->get_meta( self::META_AO_REFERENCE, true ),
                'status'       => $order->get_status(),
                'date'         => $order->get_date_created()->format( 'c' ),
                'check_count'  => (int) $order->get_meta( self::META_CHECK_COUNT, true ),
                'last_checked' => $order->get_meta( self::META_CHECKED_AT, true ) ?: null,
            ];
        }

        return new WP_REST_Response( $result, 200 );
    }

    // -------------------------------------------------------------------------
    // POST /update-tracking
    // -------------------------------------------------------------------------

    public function update_tracking( WP_REST_Request $request ): WP_REST_Response {
        $order_id        = $request->get_param( 'order_id' );
        $tracking_number = $request->get_param( 'tracking_number' );
        $carrier         = $request->get_param( 'carrier' );

        $order = wc_get_order( $order_id );

        if ( ! $order ) {
            return new WP_REST_Response(
                [ 'error' => "Order {$order_id} not found." ],
                404
            );
        }

        // ------------------------------------------------------------------
        // Save to WooCommerce Shipment Tracking plugin
        // ------------------------------------------------------------------
        $tracking_item = [
            'tracking_provider'        => '',        // empty = custom provider
            'custom_tracking_provider' => sanitize_text_field( $carrier ),
            'custom_tracking_link'     => $this->get_carrier_url( $carrier, $tracking_number ),
            'tracking_number'          => sanitize_text_field( $tracking_number ),
            'date_shipped'             => (string) time(),
        ];

        // Preserve existing tracking items and append the new one
        $existing = $order->get_meta( self::META_WC_TRACKING, true );
        if ( ! is_array( $existing ) ) {
            $existing = [];
        }
        $existing[] = $tracking_item;

        $order->update_meta_data( self::META_WC_TRACKING, $existing );

        // ------------------------------------------------------------------
        // Also store flat meta for easy querying / display
        // ------------------------------------------------------------------
        $order->update_meta_data( '_tracking_number', sanitize_text_field( $tracking_number ) );
        $order->update_meta_data( '_tracking_carrier', sanitize_text_field( $carrier ) );
        $order->save();

        // ------------------------------------------------------------------
        // Optionally add an order note
        // ------------------------------------------------------------------
        $order->add_order_note(
            sprintf(
                __( 'Tracking opdateret automatisk via Kloakgods bot. Carrier: %s | Nummer: %s', 'kloakgods-tracking' ),
                esc_html( $carrier ),
                esc_html( $tracking_number )
            )
        );

        // ------------------------------------------------------------------
        // Trigger WooCommerce Shipment Tracking email if available
        // ------------------------------------------------------------------
        do_action( 'woocommerce_shipment_tracking_order_tracking_sent', $order_id );

        // ------------------------------------------------------------------
        // Clear "check" counters now that we have tracking
        // ------------------------------------------------------------------
        $order->delete_meta_data( self::META_CHECK_COUNT );
        $order->delete_meta_data( self::META_CHECKED_AT );
        $order->save();

        return new WP_REST_Response( [
            'success'  => true,
            'order_id' => $order_id,
            'tracking' => $tracking_item,
        ], 200 );
    }

    // -------------------------------------------------------------------------
    // POST /mark-checked
    // -------------------------------------------------------------------------

    public function mark_checked( WP_REST_Request $request ): WP_REST_Response {
        $order_id = $request->get_param( 'order_id' );
        $order    = wc_get_order( $order_id );

        if ( ! $order ) {
            return new WP_REST_Response( [ 'error' => "Order {$order_id} not found." ], 404 );
        }

        $count = (int) $order->get_meta( self::META_CHECK_COUNT, true );
        $order->update_meta_data( self::META_CHECK_COUNT, $count + 1 );
        $order->update_meta_data( self::META_CHECKED_AT, gmdate( 'c' ) );
        $order->save();

        return new WP_REST_Response( [
            'success'     => true,
            'order_id'    => $order_id,
            'check_count' => $count + 1,
        ], 200 );
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private function order_has_tracking( $order ): bool {
        $items = $order->get_meta( self::META_WC_TRACKING, true );
        if ( is_array( $items ) && count( $items ) > 0 ) {
            return true;
        }
        // Fallback: check flat meta
        $flat = $order->get_meta( '_tracking_number', true );
        return ! empty( $flat );
    }

    /**
     * Returns a tracking URL for well-known Danish/Nordic carriers.
     * Add more as needed.
     */
    private function get_carrier_url( string $carrier, string $tracking_number ): string {
        $carrier_lower = strtolower( trim( $carrier ) );

        $urls = [
            'gls'        => "https://gls-group.com/DK/da/find-pakke?match={$tracking_number}",
            'postnord'   => "https://tracking.postnord.com/tracking/#/search?id={$tracking_number}",
            'dao'        => "https://www.dao.as/find-pakke/?searchfield={$tracking_number}",
            'bring'      => "https://tracking.bring.com/tracking/{$tracking_number}",
            'dhl'        => "https://www.dhl.com/dk-da/home/tracking.html?tracking-id={$tracking_number}",
            'ups'        => "https://www.ups.com/track?tracknum={$tracking_number}",
            'fedex'      => "https://www.fedex.com/fedextrack/?trknbr={$tracking_number}",
        ];

        return $urls[ $carrier_lower ] ?? '';
    }

    // -------------------------------------------------------------------------
    // Admin: AO Reference meta box on order edit screen
    // -------------------------------------------------------------------------

    public function add_ao_meta_box() {
        $screen = class_exists( '\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController' )
            && wc_get_container()->get( '\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController' )->custom_orders_table_usage_is_enabled()
            ? wc_get_page_screen_id( 'shop-order' )
            : 'shop_order';

        add_meta_box(
            'kloakgods_ao_reference',
            __( 'AO / Ahlsell Reference', 'kloakgods-tracking' ),
            [ $this, 'render_ao_meta_box' ],
            $screen,
            'side',
            'default'
        );
    }

    public function render_ao_meta_box( $post_or_order ) {
        $order_id = is_a( $post_or_order, 'WC_Order' )
            ? $post_or_order->get_id()
            : $post_or_order->ID;

        $order_obj  = wc_get_order( $order_id );
        $ao_ref     = $order_obj ? esc_attr( $order_obj->get_meta( self::META_AO_REFERENCE, true ) ) : '';
        $checked_at = $order_obj ? $order_obj->get_meta( self::META_CHECKED_AT, true ) : '';
        $count      = $order_obj ? (int) $order_obj->get_meta( self::META_CHECK_COUNT, true ) : 0;

        wp_nonce_field( 'kloakgods_save_ao_meta', 'kloakgods_ao_nonce' );
        ?>
        <p>
            <label for="ao_reference_number"><strong><?php esc_html_e( 'AO Reference nr.', 'kloakgods-tracking' ); ?></strong></label><br>
            <input type="text"
                   id="ao_reference_number"
                   name="ao_reference_number"
                   value="<?php echo $ao_ref; ?>"
                   style="width:100%"
                   placeholder="f.eks. 987654">
        </p>
        <?php if ( $checked_at ) : ?>
        <p style="color:#888;font-size:11px;">
            <?php echo esc_html( sprintf( __( 'Bot tjekket %d gang(e). Sidst: %s', 'kloakgods-tracking' ), $count, $checked_at ) ); ?>
        </p>
        <?php endif; ?>
        <?php
    }

    public function save_ao_meta_box( $order_id ) {
        if (
            ! isset( $_POST['kloakgods_ao_nonce'] ) ||
            ! wp_verify_nonce( $_POST['kloakgods_ao_nonce'], 'kloakgods_save_ao_meta' ) // phpcs:ignore
        ) {
            return;
        }

        if ( isset( $_POST['ao_reference_number'] ) ) {
            $order_obj = wc_get_order( $order_id );
            if ( $order_obj ) {
                $order_obj->update_meta_data(
                    self::META_AO_REFERENCE,
                    sanitize_text_field( wp_unslash( $_POST['ao_reference_number'] ) )
                );
                $order_obj->save();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Admin settings page (generate / display API key)
    // -------------------------------------------------------------------------

    public function add_admin_page() {
        add_submenu_page(
            'woocommerce',
            __( 'Tracking Bot API', 'kloakgods-tracking' ),
            __( 'Tracking Bot API', 'kloakgods-tracking' ),
            'manage_woocommerce',
            'kloakgods-tracking-api',
            [ $this, 'render_admin_page' ]
        );
    }

    public function register_settings() {
        register_setting( 'kloakgods_tracking_group', self::OPTION_API_KEY, [
            'type'              => 'string',
            'sanitize_callback' => 'sanitize_text_field',
        ] );
    }

    public function render_admin_page() {
        if (
            isset( $_POST['generate_api_key'] ) &&
            check_admin_referer( 'kloakgods_generate_key' )
        ) {
            $new_key = wp_generate_password( 48, false );
            update_option( self::OPTION_API_KEY, $new_key );
            echo '<div class="notice notice-success"><p>' . esc_html__( 'Ny API-nøgle genereret.', 'kloakgods-tracking' ) . '</p></div>';
        }

        $api_key  = get_option( self::OPTION_API_KEY, '' );
        $base_url = get_rest_url( null, 'kloakgods/v1' );
        ?>
        <div class="wrap">
            <h1><?php esc_html_e( 'Kloakgods Tracking Bot – API', 'kloakgods-tracking' ); ?></h1>

            <h2><?php esc_html_e( 'API-nøgle', 'kloakgods-tracking' ); ?></h2>
            <p><?php esc_html_e( 'Send denne nøgle som HTTP-header: X-API-Key', 'kloakgods-tracking' ); ?></p>

            <?php if ( $api_key ) : ?>
                <code style="font-size:14px;padding:8px;display:inline-block;background:#f5f5f5;"><?php echo esc_html( $api_key ); ?></code>
            <?php else : ?>
                <p><em><?php esc_html_e( 'Ingen nøgle endnu. Generér en nedenfor.', 'kloakgods-tracking' ); ?></em></p>
            <?php endif; ?>

            <form method="post" style="margin-top:12px;">
                <?php wp_nonce_field( 'kloakgods_generate_key' ); ?>
                <input type="submit" name="generate_api_key" class="button button-secondary"
                       value="<?php esc_attr_e( 'Generér ny API-nøgle', 'kloakgods-tracking' ); ?>">
            </form>

            <hr>
            <h2><?php esc_html_e( 'Endpoints', 'kloakgods-tracking' ); ?></h2>
            <table class="widefat" style="max-width:700px;">
                <thead><tr><th>Metode</th><th>URL</th><th>Beskrivelse</th></tr></thead>
                <tbody>
                    <tr>
                        <td><code>GET</code></td>
                        <td><code><?php echo esc_html( $base_url ); ?>/orders-missing-tracking</code></td>
                        <td><?php esc_html_e( 'Ordrer uden tracking men med AO reference', 'kloakgods-tracking' ); ?></td>
                    </tr>
                    <tr>
                        <td><code>POST</code></td>
                        <td><code><?php echo esc_html( $base_url ); ?>/update-tracking</code></td>
                        <td><?php esc_html_e( 'Gem tracking nummer på en ordre', 'kloakgods-tracking' ); ?></td>
                    </tr>
                    <tr>
                        <td><code>POST</code></td>
                        <td><code><?php echo esc_html( $base_url ); ?>/mark-checked</code></td>
                        <td><?php esc_html_e( 'Marker at botten har tjekket ordren (ingen tracking fundet endnu)', 'kloakgods-tracking' ); ?></td>
                    </tr>
                </tbody>
            </table>
        </div>
        <?php
    }
}

new Kloakgods_Tracking_API();
