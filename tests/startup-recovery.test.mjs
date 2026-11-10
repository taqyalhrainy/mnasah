import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync('index.html', 'utf8').match(/<script id="boot-recovery">([\s\S]*?)<\/script>/)[1];
function boot({ url = 'https://emtidad-alelm.onrender.com/teachers?view=rooms', blockedStorage = false, last = 0 } = {}) {
  const events = {}, timers = [], navigations = [], children = [];
  let mounted = false;
  const box = {
    URL, Date, window: { addEventListener: (name, handler) => { events[name] = handler; } },
    location: { href: url, replace: target => navigations.push(target) },
    sessionStorage: { getItem() { if (blockedStorage) throw new Error('blocked'); return String(last); }, setItem(_key, value) { if (blockedStorage) throw new Error('blocked'); last = Number(value); } },
    document: {
      documentElement: { lang: 'ar' },
      querySelector: () => mounted ? null : { appendChild: node => children.push(node) },
      getElementById: id => children.find(node => node.id === id),
      createElement: () => ({ style: {} }),
    },
    setTimeout: handler => timers.push(handler),
  };
  vm.runInNewContext(script, box);
  return { events, timers, navigations, children, mount: () => { mounted = true; } };
}

test('failed initial module bypasses the cached shell once, preserving route and query', () => {
  const app = boot();
  app.events.error({ target: { tagName: 'SCRIPT', type: 'module' } });
  app.timers[0]();
  assert.equal(app.navigations.length, 1);
  const next = new URL(app.navigations[0]);
  assert.equal(next.pathname, '/teachers');
  assert.equal(next.searchParams.get('view'), 'rooms');
  assert.ok(next.searchParams.has('__app_reload'));
});

test('blocked browser storage still recovers and a failed retry offers a button without a reload loop', () => {
  const first = boot({ blockedStorage: true });
  first.timers[0]();
  assert.equal(first.navigations.length, 1);
  const retry = boot({ url: first.navigations[0], blockedStorage: true });
  retry.events.error({ target: { tagName: 'SCRIPT', type: 'module' } });
  retry.timers[0]();
  assert.equal(retry.navigations.length, 0);
  assert.equal(retry.children.length, 1);
  retry.children[0].onclick();
  assert.equal(retry.navigations.length, 1);
});

test('startup watchdog never reloads a mounted app or an active call', () => {
  const app = boot();
  app.mount();
  app.timers[0]();
  app.events['vite:preloadError']({ preventDefault() { throw new Error('must allow normal error boundary'); } });
  assert.equal(app.navigations.length, 0);
});
