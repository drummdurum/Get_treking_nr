<?php
/**
 * Plugin Name: Kloakgods Tracking API
 * Description: Custom REST API for AO tracking automation.
 * Version: 1.1.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function kg_get_api_key() {
    if (defined('KG_TRACKING_API_KEY') && KG_TRACKING_API_KEY) {
        return KG_TRACKING_API_KEY;
    }
    return 'HEMMELIG_NOGLE_HER';
}

function kg_api_auth(WP_REST_Request $request) {
    $api_key  = (string) $request->get_header('x-kg-api-key');
    $expected = (string) kg_get_api_key();

    if ($api_key === '' || $expected === '') {
        return new WP_Error('forbidden', 'Invalid API key', ['status' => 403]);
    }

    if (!hash_equals($expected, $api_key)) {
        return new WP_Error('forbidden', 'Invalid API key', ['status' => 403]);
    }

    return true;
}

add_action('rest_api_init', function () {
    register_rest_route('kloakgods/v1', '/orders-missing-tracking', [
        'methods'             => 'GET',
        'callback'            => 'kg_get_orders_missing_tracking',
        'permission_callback' => 'kg_api_auth',
    ]);

    register_rest_route('kloakgods/v1', '/update-tracking', [
        'methods'             => 'POST',
        'callback'            => 'kg_update_tracking',
        'permission_callback' => 'kg_api_auth',
    ]);

    register_rest_route('kloakgods/v1', '/mark-checked', [
        'methods'             => 'POST',
        'callback'            => 'kg_mark_checked',
        'permission_callback' => 'kg_api_auth',
    ]);

    // MIDLERTIDIGT debug-endpoint – FJERN efter brug!
    register_rest_route('kloakgods/v1', '/debug-order-meta/(?P<order_id>\d+)', [
        'methods'             => 'GET',
        'callback'            => 'kg_debug_order_meta',
        'permission_callback' => 'kg_api_auth',
    ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /orders-missing-tracking
// ─────────────────────────────────────────────────────────────────────────────

function kg_get_orders_missing_tracking(WP_REST_Request $request) {
    if (!function_exists('wc_get_orders')) {
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    $limit      = (int) ($request->get_param('limit')      ?: 50);
    $max_checks = (int) ($request->get_param('max_checks') ?: 10);

    $orders = wc_get_orders([
        'status'  => ['processing', 'on-hold'],
        'limit'   => $limit,
        'orderby' => 'date',
        'order'   => 'DESC',
    ]);

    $result = [];

    foreach ($orders as $order) {
        $order_id = $order->get_id();

        // Spring over ordrer der allerede har tracking
        $tracking_number = $order->get_meta('_tracking_number');
        if ($tracking_number) {
            continue;
        }

        // Spring over ordrer der er tjekket for mange gange
        $check_count = (int) $order->get_meta('_ao_tracking_check_count');
        if ($check_count >= $max_checks) {
            continue;
        }

        $result[] = [
            'order_id'     => $order_id,
            'ao_reference' => $order->get_meta('_ao_reference_number') ?: null,
            'status'       => $order->get_status(),
            'check_count'  => $check_count,
            'last_checked' => $order->get_meta('_ao_tracking_checked_at') ?: null,
        ];
    }

    return rest_ensure_response($result);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /update-tracking
// ─────────────────────────────────────────────────────────────────────────────

function kg_update_tracking(WP_REST_Request $request) {
    if (!function_exists('wc_get_order')) {
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    if (!function_exists('ast_insert_tracking_number')) {
        return new WP_Error('ast_missing', 'AST Pro (Zorem) plugin is not active', ['status' => 500]);
    }

    $order_id        = absint($request->get_param('order_id'));
    $tracking_number = sanitize_text_field($request->get_param('tracking_number'));
    $carrier         = sanitize_text_field($request->get_param('carrier'));
    $date_shipped    = sanitize_text_field($request->get_param('date_shipped'));
    $status_shipped  = $request->get_param('status_shipped');
    if ($status_shipped === null || $status_shipped === '') {
        $status_shipped = 1; // Default: shipped/completed, which can trigger payment capture
    }

    if (!$order_id || !$tracking_number) {
        return new WP_Error('missing_data', 'Missing order_id or tracking_number', ['status' => 400]);
    }

    $order = wc_get_order($order_id);
    if (!$order) {
        return new WP_Error('order_not_found', 'Order not found', ['status' => 404]);
    }

    // Tjek om tracking-nummeret allerede findes på en anden ordre
    $args = array(
        'status'    => array('processing', 'on-hold', 'completed', 'shipped'),
        'limit'     => 1,
        'meta_key'  => '_tracking_number',
        'meta_value'=> $tracking_number,
        'exclude'   => array($order_id),
    );
    $orders_with_same_tracking = wc_get_orders($args);
    if (!empty($orders_with_same_tracking)) {
        return new WP_Error('duplicate_tracking', 'Tracking-nummeret er allerede brugt på en anden ordre.', ['status' => 409]);
    }

    // Brug AST Pro til at indsætte tracking
    $ast_result = ast_insert_tracking_number(
        $order_id,
        $tracking_number,
        $carrier,
        $date_shipped ?: date('Y-m-d'),
        $status_shipped
    );

    // Tilføj order note som log
    $order->add_order_note(sprintf(
        'Tracking opdateret via Kloakgods API (AST Pro). Carrier: %s | Nummer: %s',
        $carrier,
        $tracking_number
    ));
    $order->save();

    return rest_ensure_response([
        'success'         => true,
        'order_id'        => $order_id,
        'tracking_number' => $tracking_number,
        'carrier'         => $carrier,
        'ast_result'      => $ast_result,
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mark-checked
// ─────────────────────────────────────────────────────────────────────────────

function kg_mark_checked(WP_REST_Request $request) {
    if (!function_exists('wc_get_order')) {
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    $order_id = absint($request->get_param('order_id'));
    if (!$order_id) {
        return new WP_Error('missing_data', 'Missing order_id', ['status' => 400]);
    }

    $order = wc_get_order($order_id);
    if (!$order) {
        return new WP_Error('order_not_found', 'Order not found', ['status' => 404]);
    }

    $count = (int) $order->get_meta('_ao_tracking_check_count');
    $count++;
    $order->update_meta_data('_ao_tracking_check_count', $count);
    $order->update_meta_data('_ao_tracking_checked_at', gmdate('c'));
    $order->save();

    return rest_ensure_response([
        'success'     => true,
        'order_id'    => $order_id,
        'check_count' => $count,
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDLERTIDIGT: GET /debug-order-meta/{order_id} – FJERN efter brug!
// ─────────────────────────────────────────────────────────────────────────────

function kg_debug_order_meta(WP_REST_Request $request) {
    $order_id = absint($request->get_param('order_id'));
    $order    = wc_get_order($order_id);

    if (!$order) {
        return new WP_Error('order_not_found', 'Order not found', ['status' => 404]);
    }

    $meta   = $order->get_meta_data();
    $output = [];
    foreach ($meta as $meta_item) {
        $data     = $meta_item->get_data();
        $output[] = ['key' => $data['key'], 'value' => $data['value']];
    }

    return rest_ensure_response([
        'order_id' => $order_id,
        'status'   => $order->get_status(),
        'meta'     => $output,
    ]);
}
