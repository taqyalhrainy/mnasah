import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/services/classroomRelay.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', define: { 'import.meta.env': '{}' }, plugins: [{ name: 'socket-boundary', setup(builder) {
  builder.onResolve({ filter: /^socket.io-client$/ }, args => ({ path: args.path, namespace: 'fake' }));
  builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const io = () => testSocket;' }));
} }] });
const factory = new Function('module', 'exports', 'testSocket', 'window', `${bundle.outputFiles[0].text}; return module.exports.ClassroomRelay;`);
class Socket extends EventEmitter {
  connected = true; batches = []; accept = false; studentPenEnabled = false;
  timeout() { return this; }
  emit(event, payload, ack) {
    if (event === 'classroom:join') { this.join = payload; ack(null, { accepted: true, studentPenEnabled: this.studentPenEnabled }); return this; }
    if (event === 'classroom:operations') { this.batches.push(payload); ack(null, { delivered: this.accept }); return this; }
    return super.emit(event, payload, ack);
  }
  disconnect() { this.connected = false; }
}
test('backup retains unacknowledged edits, replays in order, receives ACKs and closes cleanly', async () => {
  const socket = new Socket(), Relay = factory({ exports: {} }, {}, socket, { location: { origin: 'http://localhost' } });
  const received = []; let ready = 0;
  const relay = new Relay('booking', 'students', message => received.push(message), () => ready++);
  const first = { kind: 'stroke', relayId: 'one' }, second = { kind: 'erase', relayId: 'two', ids: ['ink'] };
  relay.send(first); relay.send(second);
  await delay(150); assert.equal(socket.batches.length, 0, 'retains edits while other user is absent');
  socket.emit('connect'); assert.equal(socket.join.bookingId, 'booking');
  socket.emit('classroom:ready', { bookingId: 'other', ready: true }); assert.equal(relay.available, false);
  socket.emit('classroom:ready', { bookingId: 'booking', ready: true });
  await delay(150); assert.equal(socket.batches.length, 1);
  socket.accept = true; await delay(1100);
  assert.deepEqual(socket.batches[1].operations, [first, second], 'retries same IDs after failed recipient ACK');
  await delay(150); assert.equal(socket.batches.length, 2, 'delivered edits leave the queue');
  let acknowledgement;
  // Simulate server events, bypassing the outgoing test transport's emit.
  EventEmitter.prototype.emit.call(socket, 'classroom:operations', { bookingId: 'booking', operations: [first] }, response => acknowledgement = response);
  assert.deepEqual(received, [first]); assert.deepEqual(acknowledgement, { received: true });
  assert.equal(ready, 1);
  relay.close(); assert.equal(socket.connected, false);
});

test('backup restores the lesson pen permission on entry and reconnect', async () => {
  const socket = new Socket(), Relay = factory({ exports: {} }, {}, socket, { location: { origin: 'http://localhost' } });
  const permissions = [];
  const relay = new Relay('booking', 'students', () => undefined, () => undefined, enabled => permissions.push(enabled));
  await delay(20);
  socket.emit('connect');
  assert.deepEqual(permissions, [false]);
  socket.studentPenEnabled = true;
  socket.emit('connect');
  assert.deepEqual(permissions, [false, true]);
  relay.close();
  socket.studentPenEnabled = false;
  socket.emit('connect');
  assert.deepEqual(permissions, [false, true]);
});
