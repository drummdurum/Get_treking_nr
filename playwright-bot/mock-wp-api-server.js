/**
 * mock-wp-api-server.js
 * Lokal mock af WordPress tracking API til Postman-test.
 *
 * Kør:
 *   node mock-wp-api-server.js
 *
 * Endpoints:
 *   GET  /wp-json/kloakgods/v1/orders-missing-tracking?max_checks=10
 *   POST /wp-json/kloakgods/v1/update-tracking
 *   POST /wp-json/kloakgods/v1/mark-checked
 *   GET  /wp-json
 */

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.WP_API_KEY || 'dev-local-key';

/** @type {Array<{order_id:number, ao_reference:string, status:string, date:string, check_count:number, last_checked:string|null, tracking_items:Array<{tracking_provider:string, custom_tracking_provider:string, custom_tracking_link:string, tracking_number:string, date_shipped:string}>}>} */
const orders = [
  {
    order_id: 33733,
    ao_reference: '33733',
    status: 'processing',
    date: new Date().toISOString(),
    check_count: 0,
    last_checked: null,
    tracking_items: [],
  },
  {
    order_id: 33735,
    ao_reference: '33735',
    status: 'processing',
    date: new Date().toISOString(),
    check_count: 0,
    last_checked: null,
    tracking_items: [],
  },
];

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authOk(req) {
  const provided = req.headers['x-api-key'];
  return typeof provided === 'string' && provided === API_KEY;
}

function carrierUrl(carrier, trackingNumber) {
  const c = String(carrier || '').toLowerCase().trim();
  const map = {
    gls: `https://gls-group.com/DK/da/find-pakke?match=${trackingNumber}`,
    postnord: `https://tracking.postnord.com/tracking/#/search?id=${trackingNumber}`,
    dao: `https://www.dao.as/find-pakke/?searchfield=${trackingNumber}`,
    bring: `https://tracking.bring.com/tracking/${trackingNumber}`,
    dhl: `https://www.dhl.com/dk-da/home/tracking.html?tracking-id=${trackingNumber}`,
    ups: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    fedex: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
  };
  return map[c] || '';
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/wp-json') {
      return send(res, 200, { name: 'Kloakgods Local Mock', namespaces: ['kloakgods/v1'] });
    }

    if (!authOk(req)) {
      return send(res, 401, {
        code: 'rest_forbidden',
        message: 'Sorry, you are not allowed to do that.',
        data: { status: 401 },
      });
    }

    if (req.method === 'GET' && path === '/wp-json/kloakgods/v1/orders-missing-tracking') {
      const maxChecks = Number(url.searchParams.get('max_checks') || '10');
      const out = orders
        .filter((o) => o.ao_reference && o.ao_reference.trim() !== '')
        .filter((o) => o.tracking_items.length === 0)
        .filter((o) => o.check_count < maxChecks)
        .map((o) => ({
          order_id: o.order_id,
          ao_reference: o.ao_reference,
          status: o.status,
          date: o.date,
          check_count: o.check_count,
          last_checked: o.last_checked,
        }));
      return send(res, 200, out);
    }

    if (req.method === 'POST' && path === '/wp-json/kloakgods/v1/mark-checked') {
      const body = await parseJsonBody(req);
      const orderId = Number(body.order_id);
      const order = orders.find((o) => o.order_id === orderId);
      if (!order) return send(res, 404, { error: `Order ${orderId} not found.` });

      order.check_count += 1;
      order.last_checked = new Date().toISOString();
      return send(res, 200, {
        success: true,
        order_id: order.order_id,
        check_count: order.check_count,
      });
    }

    if (req.method === 'POST' && path === '/wp-json/kloakgods/v1/update-tracking') {
      const body = await parseJsonBody(req);
      const orderId = Number(body.order_id);
      const trackingNumber = String(body.tracking_number || '').trim();
      const carrier = String(body.carrier || '').trim();

      if (!orderId || !trackingNumber || !carrier) {
        return send(res, 400, { error: 'order_id, tracking_number og carrier er påkrævet.' });
      }

      const order = orders.find((o) => o.order_id === orderId);
      if (!order) return send(res, 404, { error: `Order ${orderId} not found.` });

      const trackingItem = {
        tracking_provider: '',
        custom_tracking_provider: carrier,
        custom_tracking_link: carrierUrl(carrier, trackingNumber),
        tracking_number: trackingNumber,
        date_shipped: String(Math.floor(Date.now() / 1000)),
      };

      order.tracking_items.push(trackingItem);
      order.check_count = 0;
      order.last_checked = null;

      return send(res, 200, {
        success: true,
        order_id: order.order_id,
        tracking: trackingItem,
      });
    }

    send(res, 404, { error: `No route for ${req.method} ${path}` });
  } catch (err) {
    send(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Mock WP API lytter på http://localhost:${PORT}`);
  console.log(`Brug X-API-Key: ${API_KEY}`);
});
