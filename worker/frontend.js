import html from '../dist/client/index.html';
import { proxyBackend } from './frontend-proxy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (/^\/(?:owner|admin)(?:\/|$)/i.test(decodeURIComponent(url.pathname)) || url.pathname.startsWith('/api/admin/')) return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return proxyBackend(request);
    // The shell and all assets load without waiting for Mongo or Render.
    if (['/', '/index.html', '/students', '/teachers', '/video', '/video-test'].includes(url.pathname.replace(/\/$/, '') || '/')) {
      return new Response(request.method === 'HEAD' ? null : html, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      } });
    }
    const asset = await env.ASSETS.fetch(request);
    if (url.pathname.endsWith('.webmanifest') || url.pathname === '/service-worker.js') {
      const response = new Response(asset.body, asset);
      response.headers.set('Cache-Control', 'no-cache');
      return response;
    }
    return asset;
  },
};
