import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('public about page and discovery files work without a session', async () => {
  const { httpServer, io } = await startPlatformServer({ database: memoryMongo({}), port: 0, portalMode: 'public' });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const page = await fetch(base + '/about/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<h1>/);
    assert.match(html, /rel="canonical" href="https:\/\/emtidad-alelm\.onrender\.com\/about\/"/);
    assert.doesNotMatch(html, /noindex/);
    assert.equal(JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@type'], 'AboutPage');
    for (const pathname of ['/robots.txt', '/sitemap.xml', '/google2431f05154e788a3.html']) {
      const response = await fetch(base + pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
      const content = await response.text();
      if (pathname === '/sitemap.xml') {
        assert.match(content, /https:\/\/emtidad-alelm\.onrender\.com\/about\//);
        assert.doesNotMatch(content, /\/students|\/teachers/);
      }
    }
  } finally { await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
});
