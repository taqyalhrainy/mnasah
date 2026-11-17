import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { io as socketClient } from 'socket.io-client';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('private invite rooms support multiple guests, scoped signaling, host controls, snapshots, chat and shared files', { timeout: 20000 }, async t => {
  const database = memoryMongo(), stored = new Map();
  const bytes = { async write(id, _name, source) { const chunks = []; for await (const chunk of source) chunks.push(chunk); stored.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
  const { httpServer, io } = await startPlatformServer({ database, attachmentStore: bytes, port: 0 });
  const base = `http://127.0.0.1:${httpServer.address().port}`, sockets = [];
  t.after(async () => { for (const socket of sockets) socket.disconnect(); await new Promise(resolve => io.close(resolve)); httpServer.close(); });
  async function post(path, body, expected = 200) {
    const response = await fetch(base + '/api/group-calls' + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const room = await post('', {}), other = await post('', {});
  const host = await post(`/${room.id}/join`, { name: 'المضيف', hostKey: room.hostKey });
  const guest = await post(`/${room.id}/join`, { name: 'أحمد' });
  const third = await post(`/${room.id}/join`, { name: 'سارة', hostKey: 'incorrect' });
  const outsider = await post(`/${other.id}/join`, { name: 'خارج الغرفة' });
  assert.equal(host.host, true); assert.equal(guest.host, false); assert.equal(third.host, false);
  await post(`/${room.id}/join`, { name: ' ' }, 400);
  const emit = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);
  async function connect(session) {
    const socket = socketClient(base, { auth: { groupToken: session.token }, extraHeaders: { origin: base }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const joined = await emit(socket, 'group:join', {}); assert.equal(joined.accepted, true); return [socket, joined];
  }
  const [a] = await connect(host), [b] = await connect(guest), [c] = await connect(third), [d] = await connect(outsider);
  assert.equal((await io.in(`group:${room.id}`).fetchSockets()).length, 3);
  let otherRoomSignal = false;
  d.on('group:signal', () => { otherRoomSignal = true; });
  a.emit('group:signal', { to: d.id, description: { type: 'offer', sdp: 'private' } });
  const operation = (socket, value) => emit(socket, 'group:operation', { relayId: crypto.randomUUID(), ...value });
  assert.equal((await operation(b, { kind: 'board-session', open: true })).accepted, false);
  assert.equal((await operation(a, { kind: 'board-session', open: true })).accepted, true);
  const stroke = { id: `123-student-${guest.id}-stroke-one`, color: '#111', size: 4, points: [{ x: 10, y: 20 }] };
  assert.equal((await operation(b, { kind: 'stroke', stroke })).accepted, true);
  assert.equal((await operation(c, { kind: 'erase', ids: [stroke.id] })).accepted, false);
  assert.equal((await operation(a, { kind: 'board-permissions', studentPenEnabled: false })).accepted, true);
  assert.equal((await operation(b, { kind: 'stroke', stroke: { ...stroke, id: stroke.id + 'blocked' } })).accepted, false);
  const received = new Promise(resolve => c.once('group:message', resolve));
  assert.equal((await emit(b, 'group:message', { body: 'مرحبا', name: 'forged', author_id: host.id })).ok, true);
  assert.equal((await received).author_id, guest.id);
  const late = await post(`/${room.id}/join`, { name: 'ضيف جديد' });
  const [, snapshot] = await connect(late);
  assert.equal(snapshot.state.boardOpen, true); assert.equal(snapshot.state.studentPenEnabled, false);
  assert.equal(snapshot.state.strokes.length, 1); assert.equal(snapshot.state.messages.length, 1);
  const image = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const url = `${base}/api/group-calls/${room.id}/files?${new URLSearchParams({ scope: 'whiteboard', type: 'image/png', size: String(image.length), name: 'board.png' })}`;
  const upload = await fetch(url, { method: 'POST', headers: { origin: base, 'content-type': 'application/octet-stream', 'x-group-session': guest.token }, body: image });
  assert.equal(upload.status, 200); const file = await upload.json();
  assert.deepEqual(Buffer.from(await (await fetch(base + file.url + '?preview=1')).arrayBuffer()), image);
  assert.equal((await fetch((base + file.url).replace(room.id, other.id))).status, 404);
  assert.equal((await database.collection('bookings').find().toArray()).length, 0, 'group calls do not create platform bookings');
  assert.equal((await database.collection('lesson_files').find().toArray()).length, 0);
  assert.equal(otherRoomSignal, false);
});
