import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io as socketClient } from 'socket.io-client';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('booking presence persists before private realtime events and safely clears departing sessions', { timeout: 15000 }, async t => {
  const now = Date.now();
  const users = ['teacher', 'student', 'other', 'other-teacher', 'owner'].map(id => ({
    id, name: id, status: 'active', role: id === 'owner' ? 'admin' : id.includes('teacher') ? 'teachers' : 'students',
  }));
  const role = id => users.find(user => user.id === id)?.role || 'students';
  const cookie = id => `mansah_session_${role(id)}=${id}-presence-token`;
  const store = memoryMongo({
    users,
    sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(`${user.id}-presence-token`).digest('hex'), expires: now + 3600000 })),
    slots: [{ id: 'slot', teacher_id: 'teacher', start: now - 60000, minutes: 60 }],
    bookings: [{ id: 'booking', slot_id: 'slot', student_id: 'student', start: now - 60000, minutes: 60, status: 'confirmed', room: 'private-room', notes: 'private-notes' }],
  });
  let beforePresenceWrite;
  let rejectFinalization = false;
  const database = { collection(name) {
    const collection = store.collection(name);
    if (name !== 'bookings') return collection;
    return { ...collection,
      find(filter, options) {
        if (rejectFinalization && filter.start?.$lte) throw new Error('Leave must not wait for finalization');
        return collection.find(filter, options);
      },
      async updateOne(filter, update, options) {
        if (beforePresenceWrite && ('teacher_present_until' in (update.$set || {}) || 'student_present_until' in (update.$set || {}))) await beforePresenceWrite();
        return collection.updateOne(filter, update, options);
      },
    };
  } };
  const { httpServer, io } = await startPlatformServer({ database, port: 0 });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = new Map();
  const received = new Map();
  t.after(async () => {
    for (const socket of sockets.values()) socket.disconnect();
    await new Promise(resolve => io.close(resolve));
    httpServer.close();
  });
  for (const id of ['teacher', 'student', 'other', 'other-teacher']) {
    const socket = socketClient(base, { auth: { portal: role(id) }, extraHeaders: { cookie: cookie(id) }, transports: ['websocket'], reconnection: false });
    sockets.set(id, socket);
    received.set(id, []);
    socket.on('booking:presence', event => received.get(id).push(event));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  }
  async function call(id, body, status = 200, { origin = base, bookingId = 'booking' } = {}) {
    const response = await fetch(`${base}/api/${role(id)}/bookings/${bookingId}/presence`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: id === 'guest' ? '' : cookie(id), origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  function nextEvent(id) {
    return new Promise((resolve, reject) => {
      const socket = sockets.get(id);
      const timer = setTimeout(() => { socket.off('booking:presence', onEvent); reject(new Error(`Missing presence event for ${id}`)); }, 2000);
      function onEvent(event) { clearTimeout(timer); resolve(event); }
      socket.once('booking:presence', onEvent);
    });
  }
  async function change(id, body) {
    const teacherEvent = nextEvent('teacher');
    const studentEvent = nextEvent('student');
    const response = await call(id, body);
    const [teacher, student] = await Promise.all([teacherEvent, studentEvent]);
    assert.deepEqual(teacher, student);
    return { response, event: teacher };
  }
  const persisted = () => store.collection('bookings').findOne({ id: 'booking' });
  function pauseNextPresenceWrite() {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforePresenceWrite = async () => { beforePresenceWrite = undefined; entered(); await gate; };
    return { started, release };
  }

  await t.test('authenticated participants receive the persisted minimal snapshot immediately', async () => {
    let release, entered;
    const blocked = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforePresenceWrite = async () => { entered(); await gate; };
    const pending = change('teacher', { active: true, peerId: 'teacher-a' });
    try {
      await blocked;
      await delay(25);
      assert.equal(received.get('teacher').length, 0, 'No event before persistence');
      assert.equal((await persisted()).teacher_present_until, undefined);
    } finally { beforePresenceWrite = undefined; release(); }
    const { event, response } = await pending;
    assert.deepEqual(Object.keys(event).sort(), ['bookingId', 'teacher_present_until', 'student_present_until', 'teacherPeerId', 'studentPeerId', 'teacher_last_seen_at', 'student_last_seen_at', 'updatedAt'].sort());
    assert.equal(event.bookingId, 'booking');
    assert.equal(event.teacherPeerId, 'teacher-a');
    assert.equal(event.studentPeerId, null);
    assert.equal(event.teacher_present_until, (await persisted()).teacher_present_until);
    assert.equal(event.teacher_last_seen_at, (await persisted()).teacher_last_seen_at);
    assert.equal(event.teacher_present_until - event.teacher_last_seen_at, 45000);
    assert.ok(event.updatedAt >= event.teacher_last_seen_at);
    assert.equal(response.teacherLive, true);
    assert.ok(response.teacher_joined_at > 0);
    assert.equal(response.studentLive, false);
    const student = await change('student', { active: true, peerId: 'student-a' });
    assert.equal(student.event.studentPeerId, 'student-a');
    assert.equal(student.event.teacherPeerId, 'teacher-a', 'Snapshot includes the persisted other participant');
    const count = received.get('teacher').length;
    await call('student');
    await delay(25);
    assert.equal(received.get('teacher').length, count, 'GET must not publish an event');
    assert.equal(received.get('other').length, 0);
    assert.equal(received.get('other-teacher').length, 0);
  });

  await t.test('leave bypasses finalization and clears presence, peer ID, and card snapshot', async () => {
    const joinedAt = (await persisted()).teacher_joined_at;
    rejectFinalization = true;
    try {
      const { event, response } = await change('teacher', { active: false, peerId: 'teacher-a' });
      assert.equal(event.teacher_present_until, 0);
      assert.equal(event.teacherPeerId, null);
      assert.equal(event.studentPeerId, 'student-a');
      assert.equal(response.teacherLive, false);
      assert.equal(response.teacher_joined_at, joinedAt, 'Leave preserves attendance evidence');
      assert.equal((await persisted()).teacher_peer_id, '');
      // Legacy no-peer leave and repeated leave still clear successfully.
      assert.equal((await change('teacher', { active: false })).response.teacherLive, false);
    } finally { rejectFinalization = false; }
  });

  await t.test('stale peer leave cannot clear a new session, including a replacement during the write', async () => {
    await change('teacher', { active: true, peerId: 'teacher-b' });
    const before = await persisted();
    const count = received.get('teacher').length;
    const ignored = await call('teacher', { active: false, peerId: 'teacher-a' });
    assert.equal(ignored.teacherPeerId, 'teacher-b');
    assert.equal((await persisted()).teacher_last_seen_at, before.teacher_last_seen_at);
    await delay(25);
    assert.equal(received.get('teacher').length, count, 'Ignored leave publishes no event');
    beforePresenceWrite = async () => {
      beforePresenceWrite = undefined;
      await store.collection('bookings').updateOne({ id: 'booking' }, { $set: { teacher_peer_id: 'teacher-c', teacher_present_until: Date.now() + 45000 } });
    };
    const raced = await call('teacher', { active: false, peerId: 'teacher-b' });
    assert.equal(raced.teacherPeerId, 'teacher-c');
    assert.ok((await persisted()).teacher_present_until > Date.now());
    const left = await change('teacher', { active: false, peerId: 'teacher-c' });
    assert.equal(left.event.teacher_present_until, 0);
  });

  await t.test('new-protocol heartbeats delayed across leave cannot resurrect either participant', async () => {
    for (const id of ['teacher', 'student']) {
      const peerId = `${id}-heartbeat-race`;
      const prefix = id === 'teacher' ? 'teacher' : 'student';
      await change(id, { active: true, peerId, joining: true });
      assert.equal((await change(id, { active: true, peerId, joining: false })).response[`${prefix}Live`], true);
      const gate = pauseNextPresenceWrite();
      const pending = call(id, { active: true, peerId, joining: false });
      let departed, count;
      try {
        await gate.started;
        await change(id, { active: false, peerId, joining: false });
        departed = await persisted();
        count = received.get('teacher').length;
      } finally { gate.release(); }
      assert.equal((await pending)[`${prefix}Live`], false);
      assert.equal(departed[`${prefix}_last_departed_peer_id`], peerId);
      assert.deepEqual(await persisted(), departed, 'Delayed heartbeat must change no stored fields');
      assert.equal((await call(id, { active: true, peerId, joining: false }))[`${prefix}Live`], false, 'Late HTTP arrival cannot renew a departed peer');
      await delay(25);
      assert.equal(received.get('teacher').length, count, 'Ignored heartbeats publish no event');
    }
  });

  await t.test('replacement rejects old heartbeats, cleanup and concurrently stale explicit joins', async () => {
    await change('teacher', { active: true, peerId: 'replacement-a', joining: true });
    const heartbeatGate = pauseNextPresenceWrite();
    const heartbeat = call('teacher', { active: true, peerId: 'replacement-a', joining: false });
    let replacement;
    try {
      await heartbeatGate.started;
      await change('teacher', { active: true, peerId: 'replacement-b', joining: true });
      replacement = await persisted();
    } finally { heartbeatGate.release(); }
    assert.equal((await heartbeat).teacherPeerId, 'replacement-b');
    assert.equal((await call('teacher', { active: false, peerId: 'replacement-a', joining: false })).teacherPeerId, 'replacement-b');
    assert.equal((await call('teacher', { active: true, peerId: 'replacement-a', joining: false })).teacherPeerId, 'replacement-b');
    assert.deepEqual(await persisted(), replacement);

    const joinGate = pauseNextPresenceWrite();
    const oldJoin = call('teacher', { active: true, peerId: 'stale-join', joining: true });
    try {
      await joinGate.started;
      await change('teacher', { active: true, peerId: 'replacement-c', joining: true });
      replacement = await persisted();
    } finally { joinGate.release(); }
    assert.equal((await oldJoin).teacherPeerId, 'replacement-c');
    assert.deepEqual(await persisted(), replacement, 'Join CAS must reject an intervening peer replacement');
  });

  await t.test('a late first join cannot cross its leave, even when the peer was already empty', async () => {
    for (const initialPeer of [undefined, '']) {
      await store.collection('bookings').updateOne({ id: 'booking' }, {
        $set: { teacher_present_until: 0, ...(initialPeer === '' ? { teacher_peer_id: '' } : {}) },
        $unset: { teacher_joined_at: '', teacher_last_seen_at: '', teacher_last_departed_peer_id: '', ...(initialPeer === undefined ? { teacher_peer_id: '' } : {}) },
      });
      const peerId = initialPeer === undefined ? 'late-initial-missing' : 'late-initial-empty';
      const gate = pauseNextPresenceWrite();
      const pending = call('teacher', { active: true, peerId, joining: true });
      let departed, count;
      try {
        await gate.started;
        await change('teacher', { active: false, peerId, joining: false });
        departed = await persisted();
        count = received.get('teacher').length;
      } finally { gate.release(); }
      assert.equal((await pending).teacherLive, false);
      assert.equal(departed.teacher_last_departed_peer_id, peerId);
      assert.equal(departed.teacher_joined_at, undefined, 'A cancelled first join must not add attendance');
      assert.deepEqual(await persisted(), departed);
      assert.equal((await call('teacher', { active: true, peerId, joining: true })).teacherLive, false, 'Departure tombstone also blocks a join arriving after leave');
      await delay(25);
      assert.equal(received.get('teacher').length, count, 'Rejected joins publish no event');
      assert.equal((await change('teacher', { active: true, peerId: `fresh-${peerId}`, joining: true })).response.teacherLive, true, 'A fresh peer may join normally');
    }
  });

  await t.test('authentication, participant ownership, origin and peer validation reject writes without broadcasting', async () => {
    const before = await persisted();
    const count = received.get('teacher').length;
    await call('guest', { active: false }, 401);
    await call('other', { active: false }, 404);
    await call('other-teacher', { active: false }, 404);
    await call('owner', { active: false }, 403);
    await call('teacher', { active: false }, 403, { origin: 'https://untrusted.example' });
    await call('teacher', { active: false, peerId: 'x'.repeat(161) }, 400);
    await call('teacher', { active: true, peerId: 'invalid', joining: 'true' }, 400);
    await call('teacher', { active: true, joining: true }, 400);
    await call('teacher', { active: true, joining: false }, 400);
    await call('teacher', { active: false }, 404, { bookingId: 'missing' });
    beforePresenceWrite = async () => { throw Object.assign(new Error('Presence storage unavailable'), { status: 503 }); };
    try { await call('teacher', { active: false }, 503); }
    finally { beforePresenceWrite = undefined; }
    assert.deepEqual(await persisted(), before);
    await delay(25);
    assert.equal(received.get('teacher').length, count);
    assert.equal(received.get('other').length, 0);
    assert.equal(received.get('other-teacher').length, 0);
    const denied = socketClient(base, { auth: { portal: 'students' }, transports: ['websocket'], reconnection: false });
    try {
      await new Promise((resolve, reject) => { denied.once('connect_error', resolve); denied.once('connect', () => reject(new Error('Guest socket authenticated'))); });
    } finally { denied.disconnect(); }
  });

  await t.test('closed lessons allow cleanup but reject resurrection, including concurrent finalization', async () => {
    await change('teacher', { active: true, peerId: 'teacher-d' });
    beforePresenceWrite = async () => {
      beforePresenceWrite = undefined;
      await store.collection('bookings').updateOne({ id: 'booking' }, { $set: { status: 'completed' } });
    };
    await call('teacher', { active: true, peerId: 'must-not-replace' }, 403);
    assert.equal((await persisted()).teacher_peer_id, 'teacher-d');
    for (const status of ['completed', 'cancelled']) {
      await store.collection('bookings').updateOne({ id: 'booking' }, { $set: { status, teacher_peer_id: 'departing', teacher_present_until: Date.now() + 45000 } });
      const { event } = await change('teacher', { active: false, peerId: 'departing' });
      assert.equal(event.teacher_present_until, 0);
      assert.equal((await persisted()).status, status);
      await call('teacher', { active: true, peerId: 'reopen' }, 403);
      assert.equal((await persisted()).teacher_present_until, 0);
    }
  });
});
