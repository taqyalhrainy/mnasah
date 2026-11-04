import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('Mongo catalog order is shared, scoped, and restricted to the owner', async t => {
  const users = ['admin', 'teachers', 'students'].map(role => ({ id: role, role, status: 'active', name: role, subject: '', bio: '', email: `${role}@test.com` }));
  const sessions = users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: Date.now() + 3600000 }));
  const groups = ['one', 'two', 'three'].map((id, position) => ({ id, kind: 'group', name: id, position }));
  const stages = ['a', 'b', 'c'].map((id, position) => ({ id, parent_id: 'one', kind: 'category', name: id, position, levels: [], subjects: ['رياضيات'] }));
  const db = memoryMongo({ users, sessions, catalog: [...groups, ...stages, { ...stages[0], id: 'other', parent_id: 'two' }] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  async function call(role, body, expected = 200) {
    const response = await fetch(`${base}/api/${role}/catalog`, { headers: { cookie: `mansah_session_${role}=${role}`, origin: base, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  await call('students', { action: 'reorder-groups', ids: ['three', 'one', 'two'] }, 403);
  await call('admin', { action: 'reorder-groups', ids: ['three', 'one', 'one'] }, 409);
  await call('admin', { action: 'reorder-groups', ids: ['three', 'one', 'two'] });
  assert.deepEqual((await call('students')).groups.map(row => row.id), ['three', 'one', 'two']);
  await call('admin', { action: 'reorder', parentId: 'one', ids: ['c', 'a', 'other'] }, 409);
  await call('admin', { action: 'reorder', parentId: 'one', ids: ['c', 'a', 'b'] });
  assert.deepEqual((await call('teachers')).categories.filter(row => row.parentId === 'one').map(row => row.id), ['c', 'a', 'b']);
  assert.equal((await call('students')).categories.find(row => row.id === 'other').parentId, 'two');
});
