import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { serveLessonFile } from '../server/lesson-files.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('both lesson participants can share private raster board images; other uploads and outsiders stay blocked', async () => {
  const db = memoryMongo({ bookings: [{ id: 'booking', slot_id: 'slot', student_id: 'student' }], slots: [{ id: 'slot', teacher_id: 'teacher' }] });
  const stored = new Map();
  const bytes = { async write(id, name, source) { const chunks = []; for await (const chunk of source) chunks.push(chunk); stored.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); req.query = Object.fromEntries(url.searchParams);
    res.set = headers => { for (const [key, value] of Object.entries(headers)) res.setHeader(key, value); };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try { if (!await serveLessonFile(req, res, { db, bytes, user: { id: req.headers['x-test-user'] || 'outsider' }, path: url.pathname.slice(1) })) res.writeHead(404).end(); }
    catch (error) { res.statusCode = error.status || 500; res.json({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const upload = (user, data, extra = {}) => fetch(`${base}/bookings/booking/files?${new URLSearchParams({ scope: 'whiteboard', name: 'board.png', type: 'image/png', size: String(data.length), ...extra })}`, { method: 'POST', headers: { 'x-test-user': user, 'Content-Type': 'application/octet-stream' }, body: data });
  try {
    for (const user of ['teacher', 'student']) {
      const response = await upload(user, png); assert.equal(response.status, 200);
      const file = await response.json(), path = file.url.replace('/api/teachers/', '/');
      const read = await fetch(base + path + '?preview=1', { headers: { 'x-test-user': user === 'teacher' ? 'student' : 'teacher' } });
      assert.equal(read.status, 200); assert.equal(read.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await read.arrayBuffer()), png);
      assert.equal((await db.collection('lesson_files').findOne({ id: path.split('/').at(-1) })).uploaded_by, user);
      assert.equal((await fetch(base + path, { headers: { 'x-test-user': 'outsider' } })).status, 404);
    }
    assert.equal((await upload('outsider', png)).status, 404);
    assert.equal((await upload('student', png, { scope: '', type: 'application/pdf' })).status, 403);
    assert.equal((await upload('student', png, { type: 'application/pdf' })).status, 415);
    assert.equal((await upload('student', Buffer.from('<svg><script>bad()</script></svg>'), { type: 'image/webp' })).status, 415);
    assert.equal((await upload('student', png, { size: String(12 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(stored.size, 2, 'failed uploads are removed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
