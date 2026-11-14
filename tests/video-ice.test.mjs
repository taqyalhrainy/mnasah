import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVideoIceProvider } from '../server/video-ice.js';

const relay = { urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443?transport=tcp'], username: 'short-lived', credential: 'short-lived-password' };
test('missing relay configuration is reported honestly instead of claiming TURN readiness', async () => {
  const result = await createVideoIceProvider({ env: {} })();
  assert.equal(result.relay_available, false); assert.ok(result.ice_servers.length);
});
test('standard TURN provider credentials support singular and plural URL configuration', async () => {
  for (const name of ['TURN_URL', 'TURN_URLS', 'VITE_TURN_URL', 'VITE_TURN_URLS']) {
    const result = await createVideoIceProvider({ env: { [name]: relay.urls.join(','), TURN_USERNAME: relay.username, TURN_CREDENTIAL: relay.credential } })();
    assert.equal(result.relay_available, true); assert.deepEqual(result.ice_servers.at(-1), relay);
  }
});
test('Cloudflare master token stays server-side and concurrent requests share cached temporary credentials', async () => {
  let calls = 0;
  const provider = createVideoIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: 'key-id', CLOUDFLARE_TURN_API_TOKEN: 'master-secret' }, fetchImpl: async (url, options) => {
    calls++; assert.match(url, /\/key-id\/credentials\/generate-ice-servers$/); assert.equal(options.headers.Authorization, 'Bearer master-secret');
    assert.deepEqual(JSON.parse(options.body), { ttl: 3600 }); assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ iceServers: relay }) };
  } });
  const results = await Promise.all(Array.from({ length: 25 }, () => provider()));
  assert.equal(calls, 1); assert.ok(results.every(result => result.relay_available));
  assert.ok(!JSON.stringify(results).includes('master-secret'));
  await provider(); assert.equal(calls, 1);
});
test('provider failure reuses valid credentials but never expired ones or retries on every student request', async () => {
  let clock = 0, fail = false, calls = 0;
  const provider = createVideoIceProvider({ env: { TWILIO_ACCOUNT_SID: 'sid', TWILIO_AUTH_TOKEN: 'secret' }, now: () => clock, fetchImpl: async () => {
    calls++; if (fail) throw new Error('temporary outage'); return { ok: true, json: async () => ({ ice_servers: [relay] }) };
  } });
  assert.equal((await provider()).relay_available, true);
  clock = 300001; fail = true;
  assert.equal((await provider()).relay_available, true); assert.equal(calls, 2);
  await provider(); assert.equal(calls, 2);
  clock = 3600001;
  assert.equal((await provider()).relay_available, false);
});
test('malformed provider replies cannot advertise uncredentialed relays', async () => {
  const provider = createVideoIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: 'id', CLOUDFLARE_TURN_API_TOKEN: 'secret' }, fetchImpl: async () => ({ ok: true, json: async () => ({ iceServers: { urls: 'turn:relay.example' } }) }) });
  assert.equal((await provider()).relay_available, false);
});

test('relay-only diagnostic mode requires actual configured TURN credentials', async () => {
  assert.equal((await createVideoIceProvider({ env: { VIDEO_RELAY_ONLY: 'true' } })()).ice_transport_policy, 'all');
  const configured = createVideoIceProvider({ env: { VIDEO_RELAY_ONLY: 'true', TURN_URL: relay.urls[0], TURN_USERNAME: relay.username, TURN_CREDENTIAL: relay.credential } });
  assert.equal((await configured()).ice_transport_policy, 'relay');
});
