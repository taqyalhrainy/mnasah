import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { io } from 'socket.io-client';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('Mongo service routes and authenticated realtime messaging', async () => {
  const users = ['teacher', 'student', 'other'].map(id => ({ id, name: id, role: id === 'teacher' ? 'teachers' : 'students', status: 'active' }));
  const cookies = Object.fromEntries(users.map(user => [user.id, `mansah_session_${user.role}=${user.id}-token`]));
  const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(`${user.id}-token`).digest('hex'), expires: Date.now() + 3600000 })), slots: [{ id: 'slot', teacher_id: 'teacher', start: Date.now(), minutes: 60 }], bookings: [{ id: 'booking', slot_id: 'slot', student_id: 'student', status: 'completed' }] });
  const storedFiles = new Map();
  const attachmentStore = {
    async write(id, _name, source) { const parts = []; for await (const part of source) parts.push(Buffer.from(part)); storedFiles.set(id, Buffer.concat(parts)); },
    read: id => Readable.from(storedFiles.get(id) || []),
    async remove(id) { storedFiles.delete(id); },
  };
  const { httpServer, io: socketServer } = await startPlatformServer({ database: db, attachmentStore, port: 0 });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  async function call(who, path, body, status = 200, headers = {}) {
    const role = who === 'teacher' ? 'teachers' : 'students';
    const response = await fetch(`${base}/api/${role}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies[who] || '', ...(body === undefined ? {} : { 'Content-Type': 'application/json', origin: base }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  async function upload(who, threadId, messageId, name, bytes, status = 200) {
    const role = who === 'teacher' ? 'teachers' : 'students';
    const query = new URLSearchParams({ messageId, name, size: String(bytes.length) });
    const response = await fetch(`${base}/api/${role}/chat/threads/${threadId}/attachments?${query}`, { method: 'POST', headers: { cookie: cookies[who] || '', origin: base, 'Content-Type': 'application/octet-stream' }, body: bytes });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  const sockets = [];
  try {
    const thread = (await call('student', 'chat/threads')).threads[0];
    assert.equal(thread.peer.name, 'teacher');
    assert.equal((await call('teacher', 'chat/threads')).threads[0].id, thread.id);
    assert.equal((await call('other', 'chat/threads')).threads.length, 0);
    await call('other', `chat/threads/${thread.id}`, undefined, 404);
    await call('guest', 'chat/threads', undefined, 401);
    await call('student', 'chat/presence', { active: true }, 403, { origin: 'https://evil.test' });
    const attachmentMessage = crypto.randomUUID();
    const pdf = Buffer.from('%PDF-1.7\nMansah worksheet');
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const pdfFile = (await upload('student', thread.id, attachmentMessage, 'worksheet.pdf', pdf)).attachment;
    const imageFile = (await upload('student', thread.id, attachmentMessage, 'diagram.png', png)).attachment;
    assert.equal(imageFile.preview_type, 'image/png');
    let response = await fetch(`${base}/api/teachers/chat/threads/${thread.id}/attachments/${pdfFile.id}`, { headers: { cookie: cookies.teacher } });
    assert.equal(response.status, 404, 'Draft attachments must not be visible before the message is sent');
    await call('student', `chat/threads/${thread.id}/messages`, { id: attachmentMessage, body: 'ملفات الدرس', attachments: [pdfFile.id, imageFile.id] });
    const attached = (await call('teacher', `chat/threads/${thread.id}`)).messages.at(-1);
    assert.deepEqual(attached.attachments.map(file => file.name), ['worksheet.pdf', 'diagram.png']);
    response = await fetch(`${base}/api/teachers/chat/threads/${thread.id}/attachments/${pdfFile.id}`, { headers: { cookie: cookies.teacher } });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    response = await fetch(`${base}/api/students/chat/threads/${thread.id}/attachments/${imageFile.id}?preview=1`, { headers: { cookie: cookies.student } });
    assert.equal(response.headers.get('content-type'), 'image/png');
    response = await fetch(`${base}/api/students/chat/threads/${thread.id}/attachments/${pdfFile.id}`, { headers: { cookie: cookies.other } });
    assert.equal(response.status, 404, 'Unrelated accounts must not access attachments');
    const socket = io(base, { auth: { portal: 'teachers' }, extraHeaders: { cookie: cookies.teacher }, transports: ['websocket'], reconnection: false }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const changed = new Promise(resolve => socket.once('chat:changed', resolve));
    const id = crypto.randomUUID();
    await call('student', `chat/threads/${thread.id}/messages`, { id, body: 'سؤال من الطالب' });
    assert.equal((await changed).threadId, thread.id);
    let result = await call('teacher', `chat/threads/${thread.id}`);
    assert.equal(result.messages.at(-1).body, 'سؤال من الطالب');
    await call('teacher', `chat/threads/${thread.id}/read`, { messageId: id });
    assert.ok((await call('student', `chat/threads/${thread.id}`)).thread.peerReadAt > 0);
    await call('teacher', 'chat/settings', { readReceipts: false, showPresence: false });
    await call('teacher', 'chat/presence', { active: true });
    result = await call('student', `chat/threads/${thread.id}`);
    assert.equal(result.thread.peerReadAt, null); assert.equal(result.thread.peer.lastSeen, null);
    await call('teacher', 'chat/settings', { showPresence: true });
    const oldSeen = Date.now() - 360000;
    await db.collection('chat_settings').updateOne({ user_id: 'teacher' }, { $set: { last_seen: oldSeen, active: false } });
    await call('teacher', 'chat/presence', { active: false });
    result = await call('student', `chat/threads/${thread.id}`);
    assert.equal(result.thread.peer.status, 'offline');
    assert.equal(result.thread.peer.lastSeen, oldSeen, 'Inactive heartbeats must not keep the account recently online forever');
    await call('teacher', `chat/threads/${thread.id}/reaction`, { messageId: id, emoji: '👍', active: true });
    assert.equal((await call('student', `chat/threads/${thread.id}`)).messages.find(message => message.id === id).reactions[0].emoji, '👍');
    await call('teacher', `chat/threads/${thread.id}/typing`, { active: true });
    assert.equal((await call('student', `chat/threads/${thread.id}`)).thread.typing, true);
    await call('teacher', `chat/threads/${thread.id}/preferences`, { blocked: true });
    await call('student', `chat/threads/${thread.id}/messages`, { id: crypto.randomUUID(), body: 'لا تصل' }, 403);
    await call('teacher', `chat/threads/${thread.id}/preferences`, { blocked: false });
    await call('student', `chat/threads/${thread.id}/delete`, {});
    assert.equal((await call('student', `chat/threads/${thread.id}`)).messages.length, 0);
    assert.equal((await call('teacher', `chat/threads/${thread.id}`)).messages.length, 2);
    response = await fetch(`${base}/api/students/chat/threads/${thread.id}/attachments/${pdfFile.id}`, { headers: { cookie: cookies.student } });
    assert.equal(response.status, 404, 'A participant cannot access files from personally deleted history');
    await call('student', `chat/threads/${thread.id}/restore`, {});
    assert.equal((await call('student', `chat/threads/${thread.id}`)).messages.length, 0);
    const denied = io(base, { auth: { portal: 'teachers' }, transports: ['websocket'], reconnection: false }); sockets.push(denied);
    await new Promise((resolve, reject) => { denied.once('connect_error', resolve); denied.once('connect', () => reject(new Error('Unauthenticated socket connected'))); });
    const batchTime = Date.now() + 1;
    for (let index = 0; index < 55; index++) await db.collection('direct_messages').insertOne({ id: crypto.randomUUID(), thread_id: thread.id, author_id: 'student', body: `Message ${index}`, created: batchTime, reply_to: '', media_url: '' });
    const newest = await call('teacher', `chat/threads/${thread.id}`);
    assert.equal(newest.messages.length, 50); assert.equal(newest.hasMore, true);
    const first = newest.messages[0];
    const older = await call('teacher', `chat/threads/${thread.id}?before=${first.created}&beforeId=${first.id}`);
    assert.equal(older.messages.length, 7); assert.equal(older.hasMore, false);
    assert.equal(new Set([...older.messages, ...newest.messages].map(message => message.id)).size, 57, 'Pagination must not duplicate or skip messages sharing a timestamp');
  } finally {
    for (const socket of sockets) socket.disconnect();
    await new Promise(resolve => socketServer.close(resolve));
    httpServer.close();
  }
});
