import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Optional local lab dependency, isolated from production dependencies.
// npm install --prefix DO_NOT_UPLOAD/call-network-lab node-turn
export async function networkRelay(port = 55340) {
  const require = createRequire(path.resolve('DO_NOT_UPLOAD/call-network-lab/package.json'));
  const Turn = require('node-turn');
  const originalCreateSocket = dgram.createSocket;
  const originalSetTimeout = globalThis.setTimeout, allocationTimers = new Set();
  // The legacy lab server can orphan a long allocation timer after deallocation.
  // Track those test-process timers too, so teardown cannot retain Node for hours.
  globalThis.setTimeout = function (callback, delay, ...args) {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay >= 300000) { timer.unref(); allocationTimers.add(timer); }
    return timer;
  };
  const sockets = [], timers = new Set(), lanes = new Map();
  let phase = { bytesPerSecond: Infinity, loss: 0, latency: 0 }, sent = 0, dropped = 0, received = 0, seed = 773;
  dgram.createSocket = function (...args) {
    const socket = originalCreateSocket.apply(this, args); sockets.push(socket);
    socket.on('message', () => { received++; });
    const originalSend = socket.send.bind(socket);
    socket.send = function (...args) {
      const packet = args[0];
      // Impair only TURN ChannelData sent to browsers. Keep allocation/consent
      // management intact; media is still encrypted DTLS/SRTP end-to-end.
      if (!Buffer.isBuffer(packet) || (packet[0] & 0xc0) !== 0x40 || !Number.isFinite(phase.bytesPerSecond)) return originalSend(...args);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = `${args[1]}:${args[2]}`;
      const now = performance.now(), lane = lanes.get(key) || now;
      const due = Math.max(lane, now) + packet.length / phase.bytesPerSecond * 1000;
      if (seed / 0x100000000 < phase.loss || due - now > 250) {
        dropped++; if (typeof args.at(-1) === 'function') queueMicrotask(() => args.at(-1)(null)); return;
      }
      lanes.set(key, due);
      const timer = setTimeout(() => { timers.delete(timer); try { sent++; originalSend(...args); } catch { /* Relay shut down. */ } }, due - now + phase.latency);
      timers.add(timer);
    };
    return socket;
  };
  const server = new Turn({ listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], listeningPort: port, minPort: port + 1, maxPort: port + 180, authMech: 'long-term', credentials: { lab: 'local-network-test-only' }, debugLevel: 'FATAL' });
  // The optional legacy lab server retains nonce cleanup timers for an hour.
  // Keep expiration validation, but let this short-lived test exit cleanly.
  server.authentification.generateNonce = function () { const nonce = randomBytes(16).toString('hex'); this.nonces[nonce] = { ttl: Date.now() + 3600000 }; return nonce; };
  server.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  return {
    iceServers: [{ urls: `turn:127.0.0.1:${port}?transport=udp`, username: 'lab', credential: 'local-network-test-only' }],
    impair(value) { phase = value; lanes.clear(); },
    metrics: () => ({ sent, dropped, received }),
    close() { dgram.createSocket = originalCreateSocket; globalThis.setTimeout = originalSetTimeout; allocationTimers.forEach(clearTimeout); timers.forEach(clearTimeout); Object.values(server.allocations).forEach(allocation => clearTimeout(allocation.timer)); for (const socket of sockets) try { socket.close(); } catch { /* Already closed. */ } },
  };
}
