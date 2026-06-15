<?php
/**
 * Plugin Name: Kloakgods Tracking API
 * Description: Custom REST API for tracking automation.
 * Version: 1.2.0
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

function kg_log($level, $message, $context = []) {
    $context = is_array($context) ? $context : ['context' => $context];
    $context['source'] = 'kloakgods-tracking-api';

    if (function_exists('wc_get_logger')) {
        wc_get_logger()->log($level, $message, $context);
        return;
    }

    if (defined('WP_DEBUG') && WP_DEBUG) {
        error_log('[kloakgods-tracking-api] ' . strtoupper((string) $level) . ': ' . $message . ' ' . wp_json_encode($context));
    }
}

function kg_api_auth(WP_REST_Request $request) {
    $api_key = (string) $request->get_header('x-kg-api-key');
    if ($api_key === '') {
        $api_key = (string) $request->get_header('x-api-key');
    }

    $expected = (string) kg_get_api_key();
    if ($api_key === '' || $expected === '') {
        kg_log('warning', 'REST auth failed: missing API key.');
        return new WP_Error('forbidden', 'Invalid API key', ['status' => 403]);
    }

    if (!hash_equals($expected, $api_key)) {
        kg_log('warning', 'REST auth failed: invalid API key.');
        return new WP_Error('forbidden', 'Invalid API key', ['status' => 403]);
    }

    return true;
}

function kg_normalize_tracking_number($tracking_number) {
    return strtoupper(preg_replace('/\s+/', '', (string) $tracking_number));
}

function kg_tracking_compare_key($tracking_number) {
    $tracking_number = kg_normalize_tracking_number($tracking_number);
    if (preg_match('/^\d+$/', $tracking_number)) {
        return ltrim($tracking_number, '0');
    }

    return $tracking_number;
}

function kg_normalize_carrier($carrier) {
    $carrier = trim((string) $carrier);
    $key = strtolower(str_replace(['æ', 'ø', 'å'], ['ae', 'oe', 'aa'], $carrier));

    if (strpos($key, 'postnord') !== false || strpos($key, 'post nord') !== false) {
        return 'PostNord';
    }
    if (strpos($key, 'danske fragt') !== false || strpos($key, 'fragtmaend') !== false || strpos($key, 'fragtmand') !== false) {
        return 'Danske Fragtmænd';
    }
    if (strpos($key, 'gls') !== false) {
        return 'GLS';
    }
    if (strpos($key, 'dao') !== false) {
        return 'DAO';
    }
    if (strpos($key, 'bring') !== false) {
        return 'Bring';
    }
    if (strpos($key, 'dhl') !== false) {
        return 'DHL';
    }

    return $carrier;
}

function kg_get_order_tracking_numbers($order) {
    $numbers = [];

    $single = $order->get_meta('_tracking_number');
    if ($single) {
        $numbers[] = $single;
    }

    foreach (['_wc_shipment_tracking_items', '_shipment_tracking_items', '_tracking_items', '_ast_tracking_items'] as $meta_key) {
        $items = $order->get_meta($meta_key);
        if (!is_array($items)) {
            continue;
        }

        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            foreach (['tracking_number', 'tracking_id', 'tracking_code'] as $field) {
                if (!empty($item[$field])) {
                    $numbers[] = $item[$field];
                }
            }
        }
    }

    return array_values(array_unique(array_filter(array_map('kg_normalize_tracking_number', $numbers))));
}

function kg_order_has_tracking($order) {
    return count(kg_get_order_tracking_numbers($order)) > 0;
}

function kg_find_duplicate_tracking_order($tracking_number, $exclude_order_id) {
    $target_key = kg_tracking_compare_key($tracking_number);
    if ($target_key === '') {
        return null;
    }

    $orders = wc_get_orders([
        'status' => ['processing', 'on-hold', 'completed', 'shipped'],
        'limit'  => 250,
        'return' => 'objects',
    ]);

    foreach ($orders as $order) {
        if ((int) $order->get_id() === (int) $exclude_order_id) {
            continue;
        }

        foreach (kg_get_order_tracking_numbers($order) as $existing_tracking_number) {
            if (kg_tracking_compare_key($existing_tracking_number) === $target_key) {
                return $order;
            }
        }
    }

    return null;
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

    register_rest_route('kloakgods/v1', '/debug-order-meta/(?P<order_id>\d+)', [
        'methods'             => 'GET',
        'callback'            => 'kg_debug_order_meta',
        'permission_callback' => 'kg_api_auth',
    ]);
});

function kg_get_orders_missing_tracking(WP_REST_Request $request) {
    if (!function_exists('wc_get_orders')) {
        kg_log('error', 'WooCommerce is not active while fetching missing tracking orders.');
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    $limit      = (int) ($request->get_param('limit') ?: 100);
    $max_checks = (int) ($request->get_param('max_checks') ?: 10);

    $orders = wc_get_orders([
        'status'  => ['processing', 'on-hold'],
        'limit'   => $limit,
        'orderby' => 'date',
        'order'   => 'DESC',
    ]);

    $result = [];
    foreach ($orders as $order) {
        if (kg_order_has_tracking($order)) {
            continue;
        }

        $check_count = (int) $order->get_meta('_ao_tracking_check_count');
        if ($check_count >= $max_checks) {
            continue;
        }

        $result[] = [
            'order_id'     => $order->get_id(),
            'ao_reference' => $order->get_meta('_ao_reference_number') ?: null,
            'status'       => $order->get_status(),
            'check_count'  => $check_count,
            'last_checked' => $order->get_meta('_ao_tracking_checked_at') ?: null,
        ];
    }

    kg_log('info', 'Fetched orders missing tracking.', [
        'limit'       => $limit,
        'max_checks'  => $max_checks,
        'found_count' => count($result),
    ]);

    return rest_ensure_response($result);
}

function kg_update_tracking(WP_REST_Request $request) {
    if (!function_exists('wc_get_order')) {
        kg_log('error', 'WooCommerce is not active while updating tracking.');
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    if (!function_exists('ast_insert_tracking_number')) {
        kg_log('error', 'AST Pro function ast_insert_tracking_number is missing.');
        return new WP_Error('ast_missing', 'AST Pro (Zorem) plugin is not active', ['status' => 500]);
    }

    $order_id        = absint($request->get_param('order_id'));
    $tracking_number = kg_normalize_tracking_number(sanitize_text_field($request->get_param('tracking_number')));
    $carrier         = kg_normalize_carrier(sanitize_text_field($request->get_param('carrier')));
    $date_shipped    = sanitize_text_field($request->get_param('date_shipped'));
    $status_shipped  = $request->get_param('status_shipped');
    if ($status_shipped === null || $status_shipped === '') {
        $status_shipped = 1;
    }

    if (!$order_id || !$tracking_number) {
        kg_log('warning', 'Update tracking rejected: missing order_id or tracking_number.', [
            'order_id'        => $order_id,
            'tracking_number' => $tracking_number,
            'carrier'         => $carrier,
        ]);
        return new WP_Error('missing_data', 'Missing order_id or tracking_number', ['status' => 400]);
    }

    $order = wc_get_order($order_id);
    if (!$order) {
        kg_log('warning', 'Update tracking rejected: order not found.', [
            'order_id'        => $order_id,
            'tracking_number' => $tracking_number,
            'carrier'         => $carrier,
        ]);
        return new WP_Error('order_not_found', 'Order not found', ['status' => 404]);
    }

    kg_log('info', 'Update tracking request received.', [
        'order_id'        => $order_id,
        'tracking_number' => $tracking_number,
        'tracking_key'    => kg_tracking_compare_key($tracking_number),
        'carrier'         => $carrier,
    ]);

    $duplicate_order = kg_find_duplicate_tracking_order($tracking_number, $order_id);
    if ($duplicate_order) {
        kg_log('warning', 'Update tracking rejected: duplicate tracking number.', [
            'order_id'           => $order_id,
            'duplicate_order_id' => $duplicate_order->get_id(),
            'tracking_number'    => $tracking_number,
            'tracking_key'       => kg_tracking_compare_key($tracking_number),
            'carrier'            => $carrier,
        ]);
        return new WP_Error('duplicate_tracking', 'Tracking number is already used on another order.', [
            'status'             => 409,
            'duplicate_order_id' => $duplicate_order->get_id(),
            'tracking_number'    => $tracking_number,
            'tracking_key'       => kg_tracking_compare_key($tracking_number),
        ]);
    }

    try {
        $ast_result = ast_insert_tracking_number(
            $order_id,
            $tracking_number,
            $carrier,
            $date_shipped ?: date('Y-m-d'),
            $status_shipped
        );
    } catch (Throwable $e) {
        kg_log('error', 'AST insert tracking threw an exception.', [
            'order_id'        => $order_id,
            'tracking_number' => $tracking_number,
            'carrier'         => $carrier,
            'error'           => $e->getMessage(),
        ]);

        return new WP_Error('ast_insert_failed', 'AST insert tracking failed: ' . $e->getMessage(), ['status' => 500]);
    }

    $order->add_order_note(sprintf(
        'Tracking opdateret via Kloakgods API (AST Pro). Carrier: %s | Nummer: %s',
        $carrier,
        $tracking_number
    ));
    $order->update_meta_data('_tracking_number', $tracking_number);
    $order->update_meta_data('_tracking_provider', $carrier);
    $order->update_meta_data('_ao_tracking_checked_at', gmdate('c'));
    $order->save();

    kg_log('info', 'Tracking updated successfully.', [
        'order_id'        => $order_id,
        'tracking_number' => $tracking_number,
        'tracking_key'    => kg_tracking_compare_key($tracking_number),
        'carrier'         => $carrier,
        'ast_result'      => $ast_result,
    ]);

    return rest_ensure_response([
        'success'         => true,
        'order_id'        => $order_id,
        'tracking_number' => $tracking_number,
        'tracking_key'    => kg_tracking_compare_key($tracking_number),
        'carrier'         => $carrier,
        'ast_result'      => $ast_result,
    ]);
}

function kg_mark_checked(WP_REST_Request $request) {
    if (!function_exists('wc_get_order')) {
        kg_log('error', 'WooCommerce is not active while marking order checked.');
        return new WP_Error('woocommerce_missing', 'WooCommerce is not active', ['status' => 500]);
    }

    $order_id = absint($request->get_param('order_id'));
    if (!$order_id) {
        kg_log('warning', 'Mark checked rejected: missing order_id.');
        return new WP_Error('missing_data', 'Missing order_id', ['status' => 400]);
    }

    $order = wc_get_order($order_id);
    if (!$order) {
        kg_log('warning', 'Mark checked rejected: order not found.', ['order_id' => $order_id]);
        return new WP_Error('order_not_found', 'Order not found', ['status' => 404]);
    }

    $count = (int) $order->get_meta('_ao_tracking_check_count');
    $count++;
    $order->update_meta_data('_ao_tracking_check_count', $count);
    $order->update_meta_data('_ao_tracking_checked_at', gmdate('c'));
    $order->save();

    kg_log('info', 'Order marked checked.', [
        'order_id'    => $order_id,
        'check_count' => $count,
    ]);

    return rest_ensure_response([
        'success'     => true,
        'order_id'    => $order_id,
        'check_count' => $count,
    ]);
}

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
        'order_id'         => $order_id,
        'status'           => $order->get_status(),
        'tracking_numbers' => kg_get_order_tracking_numbers($order),
        'meta'             => $output,
    ]);
}
