import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const context = { exports: {}, setTimeout, clearTimeout };
vm.runInNewContext(ts.transpile(fs.readFileSync('src/features/video/documentPageCache.ts', 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), context);
const { DocumentPageCache } = context.exports;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('preview is immediately usable while the authenticated upload is pending; repeated work is deduplicated', async () => {
  const upload = deferred(); let renders = 0, uploads = 0;
  const cache = new DocumentPageCache({ count: 10, render: async page => { renders++; return `local:${page}`; }, publish: async src => { uploads++; await upload.promise; return `shared:${src}`; }, onReady() {} });
  const sharing = cache.share(1);
  assert.equal(await cache.local(1), 'local:1');
  assert.equal(await cache.local(1), 'local:1');
  assert.equal(renders, 1);
  assert.equal(cache.share(1), sharing);
  upload.resolve(); assert.equal(await sharing, 'shared:local:1');
  assert.equal(uploads, 1); cache.dispose();
});

test('foreground jumps take priority over queued prefetch and uploads stay serialized', async () => {
  const gate = deferred(), order = []; let active = 0, maximum = 0;
  const cache = new DocumentPageCache({ count: 100, render: async page => `page:${page}`, publish: async (src, page) => { active++; maximum = Math.max(maximum, active); order.push(page); if (page === 1) await gate.promise; active--; return src; }, onReady() {} });
  const first = cache.share(1), background = cache.share(2, false), jump = cache.share(40);
  await tick(); gate.resolve(); await Promise.all([first, background, jump]);
  assert.deepEqual(order, [1, 40, 2]); assert.equal(maximum, 1); cache.dispose();
});

test('warmed pages need neither a second render nor a second HTTP upload', async () => {
  const ready = new Map(); let renders = 0, uploads = 0;
  const cache = new DocumentPageCache({ count: 4, render: async page => { renders++; return String(page); }, publish: async src => { uploads++; return `url:${src}`; }, onReady: (src, page) => ready.set(page, src) });
  await cache.local(1); await cache.share(1); cache.warm(1);
  for (let i = 0; i < 20 && !ready.has(3); i++) await tick();
  assert.equal(ready.get(2), 'url:2');
  const before = [renders, uploads]; assert.equal(await cache.local(2), '2'); assert.equal(await cache.share(2), 'url:2');
  assert.deepEqual([renders, uploads], before); cache.dispose();
});

test('LRU bounds decoded preview memory for large documents', async () => {
  let renders = 0;
  const cache = new DocumentPageCache({ count: 624, limit: 3, render: async page => { renders++; return String(page); }, publish: async src => src, onReady() {} });
  for (const page of [1, 2, 3, 1, 4, 3]) await cache.local(page);
  assert.equal(renders, 4); await cache.local(2); assert.equal(renders, 5); cache.dispose();
});

test('closing a document cancels queued work and prevents late previews from reopening it', async () => {
  const gate = deferred(); let delivered = 0;
  const cache = new DocumentPageCache({ count: 5, render: async page => String(page), publish: async src => { await gate.promise; return src; }, onReady() { delivered++; } });
  const current = cache.share(1), pending = cache.share(2, false);
  const checked = Promise.all([assert.rejects(current, /closed/), assert.rejects(pending, /closed/)]);
  await tick(); cache.dispose(); gate.resolve(); await checked;
  assert.equal(delivered, 0); await assert.rejects(cache.local(3), /closed/);
});
