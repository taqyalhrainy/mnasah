import { BACKEND_ORIGIN } from '../shared/deployment.js';

const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const callback = /^\/api\/payments\/(?:paypal\/ipn|card\/(?:callback|return))$/;
const unavailable = () => Response.json({ error: 'ثواني وبنكون معك. نجهّز الاتصال بالمنصة…', starting: true }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '3' } });

// Only explicit API and Socket.IO paths reach the fixed upstream. No user data
// is cached or moved to this host's legacy D1 database. Bodies stay streaming.
export async function proxyBackend(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  const socket = url.pathname.startsWith('/socket.io/');
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const origin = request.headers.get('Origin');
  if (!callback.test(url.pathname) && ((unsafe || upgrade) && origin !== url.origin || socket && (origin && origin !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site'))) {
    return Response.json({ error: 'Invalid request origin' }, { status: 403, headers: privateHeaders });
  }
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key === 'host' || key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('x-emtidad-')) headers.delete(key);
  }
  // Browser caches and Cloudflare's cache must never cache authenticated API.
  headers.set('Cache-Control', 'no-store');
  const target = new URL(BACKEND_ORIGIN);
  target.pathname = url.pathname;
  target.search = url.search;
  try {
    const response = await fetchImpl(new Request(target, {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', duplex: 'half',
    }), { cf: { cacheTtl: 0, cacheEverything: false } });
    // Return the original upgraded response: Workers carries its WebSocket.
    if (response.status === 101) return response;
    // Render can return its loading HTML even with status 200. It must never
    // replace the independently served UI or escape into the API client.
    if ((response.headers.get('content-type') || '').includes('text/html') && (response.status < 300 || response.status >= 400)) return unavailable();
    const output = new Response(response.body, response);
    output.headers.set('Cache-Control', 'no-store');
    output.headers.set('X-Content-Type-Options', 'nosniff');
    const location = output.headers.get('Location');
    if (location) {
      const destination = new URL(location, BACKEND_ORIGIN);
      if (destination.origin === BACKEND_ORIGIN) {
        destination.host = url.host;
        destination.protocol = url.protocol;
        output.headers.set('Location', destination.href);
      }
    }
    return output;
  } catch { return unavailable(); }
}
