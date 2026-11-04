import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import { publicOwnerPage } from '../shared/portal-access.js';

test('owner UI is unavailable on the public platform hostname', () => {
  for (const path of ['/owner', '/owner/', '/admin', '/%6fwner']) assert.equal(publicOwnerPage(path, 'emtidad-alelm.onrender.com'), true);
  assert.equal(publicOwnerPage('/students', 'emtidad-alelm.onrender.com'), false);
  assert.equal(publicOwnerPage('/owner', 'emtidad-alelm-owner.onrender.com'), false);
});

test('public and owner deployments isolate routes, login and existing sessions', async t => {
  const token = 'existing-owner-token';
  const owner = { id: 'owner', role: 'admin', status: 'active', name: 'Owner', email: 'owner@test.com', subject: '', bio: '' };
  const db = memoryMongo({ users: [owner], sessions: [{ user_id: owner.id, token: crypto.createHash('sha256').update(token).digest('hex'), expires: Date.now() + 3600000 }] });
  for (const mode of ['public', 'owner']) {
    const { httpServer, io } = await startPlatformServer({ database: db, port: 0, portalMode: mode });
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    try {
      const admin = await fetch(`${base}/api/admin/users`, { headers: { cookie: `mansah_session_admin=${token}` } });
      assert.equal(admin.status, mode === 'public' ? 404 : 200);
      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: `mansah_session=${token}` } });
      assert.equal((await me.json()).user?.role || null, mode === 'public' ? null : 'admin');
      const forbiddenRole = mode === 'public' ? 'admin' : 'students';
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: forbiddenRole, email: 'none@test.com', password: 'unused-password' }) });
      assert.equal(login.status, 404);
      assert.equal((await fetch(`${base}/${mode === 'public' ? 'owner' : 'students'}`)).status, 404);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally { await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
  }
});
