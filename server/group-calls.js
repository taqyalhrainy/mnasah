import crypto from 'node:crypto';
import { serveLessonFile } from './lesson-files.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const editableKinds = new Set(['sync-request', 'pointer', 'stroke-start', 'stroke-points', 'stroke', 'clear', 'erase', 'item-upsert', 'item-delete', 'mode', 'board-session', 'board-permissions', 'document', 'document-preload', 'document-view', 'document-annotations', 'youtube', 'sync']);
const hostKinds = new Set(['clear', 'mode', 'board-session', 'board-permissions', 'document', 'document-preload', 'document-view', 'youtube', 'sync']);
const initialState = () => ({ strokes: [], items: [], boardOpen: false, studentPenEnabled: true, document: null, annotations: [], youtube: null, mode: 'video', messages: [] });
const publicMember = socket => ({ id: socket.id, name: socket.data.groupMember.name, memberId: socket.data.groupMember.id, host: socket.data.groupMember.host, ...socket.data.groupMedia });

export function createGroupCalls({ io, database, connect, videoIce, attachmentStore, isAllowed, originAllowed }) {
  const rooms = new Map();
  const attempts = new Map();
  const channel = id => `group:${id}`;
  async function memberFor(value, roomId) {
    if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) return null;
    return database().collection('group_call_members').findOne({ token_hash: hash(value), ...(roomId ? { room_id: roomId } : {}), expires: { $gt: Date.now() } });
  }
  async function roomState(id) {
    if (!rooms.has(id)) {
      const record = await database().collection('group_calls').findOne({ id });
      if (!record) fail(404, 'رابط المكالمة غير موجود.');
      if (!rooms.has(id)) rooms.set(id, { state: record.state || initialState(), seen: new Set(), sockets: new Set(), save: Promise.resolve() });
    }
    return rooms.get(id);
  }
  const save = (id, room) => {
    room.save = room.save.catch(() => undefined).then(() => database().collection('group_calls').updateOne({ id }, { $set: { state: structuredClone(room.state), updated: Date.now() } }));
    return room.save;
  };
  async function serve(req, res, next) {
    if (!req.path.startsWith('/api/group-calls')) return next();
    try {
      if (!isAllowed()) return res.sendStatus(404);
      if (req.method === 'POST' && !originAllowed(req)) fail(403, 'مصدر الطلب غير صالح.');
      res.setHeader('Cache-Control', 'no-store');
      await connect();
      if (req.method === 'POST' && req.path === '/api/group-calls') {
        const key = req.ip || req.socket.remoteAddress;
        const previous = attempts.get(key) || { count: 0, since: Date.now() };
        if (Date.now() - previous.since > 3600000) { previous.count = 0; previous.since = Date.now(); }
        if (++previous.count > 20) fail(429, 'تم إنشاء عدة غرف. حاول لاحقاً.');
        attempts.set(key, previous);
        if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
        const id = token(), hostKey = token();
        await database().collection('group_calls').insertOne({ id, host_hash: hash(hostKey), state: initialState(), created: Date.now() });
        return res.json({ id, hostKey, url: `/call/${id}` });
      }
      const match = /^\/api\/group-calls\/([a-f0-9]{48})(?:\/(join|ice|files)(?:\/([a-f0-9-]{36}))?)?$/.exec(req.path);
      if (!match) fail(404, 'رابط المكالمة غير موجود.');
      const [, id, action, fileId] = match;
      const room = await database().collection('group_calls').findOne({ id });
      if (!room) fail(404, 'رابط المكالمة غير موجود.');
      if (req.method === 'GET' && !action) return res.json({ id, available: true });
      if (req.method === 'POST' && action === 'join') {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 60) fail(400, 'اكتب اسمك بحد أقصى 60 حرفاً.');
        const host = typeof req.body.hostKey === 'string' && hash(req.body.hostKey) === room.host_hash;
        const sessionToken = token(), member = { id: crypto.randomUUID(), room_id: id, token_hash: hash(sessionToken), name, host, expires: Date.now() + 7 * 86400000 };
        await database().collection('group_call_members').insertOne(member);
        return res.json({ roomId: id, token: sessionToken, id: member.id, host, name });
      }
      const member = await memberFor(req.get('x-group-session'), id);
      if (action === 'files') {
        if (req.method !== 'GET' && !member) fail(401, 'ادخل المكالمة أولاً.');
        await serveLessonFile(req, res, { db: database(), user: { id: member?.id || 'invite-reader' }, path: `bookings/${id}/files${fileId ? `/${fileId}` : ''}`, access: { canUpload: member?.host === true }, collection: 'group_call_files', urlPrefix: `/api/group-calls/${id}/files`, ...(attachmentStore() ? { bytes: attachmentStore() } : {}) });
        return;
      }
      if (action === 'ice' && req.method === 'GET' && member) return res.json(await videoIce());
      fail(403, 'تعذر تنفيذ الطلب.');
    } catch (error) { next(error); }
  }
  async function authorizeSocket(socket) {
    if (!isAllowed()) return false;
    await connect();
    const member = await memberFor(socket.handshake.auth?.groupToken);
    if (!member) return false;
    socket.data.groupMember = member;
    return true;
  }
  io.on('connection', socket => {
    const member = socket.data.groupMember;
    if (!member) return;
    const id = member.room_id;
    let joined = false, ready;
    let messages = 0, since = Date.now();
    const rateAllowed = () => { if (Date.now() - since > 1000) { since = Date.now(); messages = 0; } return ++messages <= 180; };
    socket.data.groupMedia = { audioEnabled: true, videoEnabled: false, screenEnabled: false, speaking: false };
    const roster = async () => {
      const peers = await io.in(channel(id)).fetchSockets();
      io.to(channel(id)).emit('group:peers', peers.map(publicMember));
    };
    socket.on('group:join', async (_payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        ready = await roomState(id);
        await socket.join(channel(id));
        if (!socket.connected) return ack({ accepted: false });
        ready.sockets.add(socket.id); joined = true;
        ack({ accepted: true, selfId: socket.id, state: ready.state });
        void roster();
      } catch { ack({ accepted: false }); }
    });
    socket.on('group:signal', payload => {
      if (!joined || !rateAllowed() || !payload || typeof payload.to !== 'string' || JSON.stringify(payload).length > 100000) return;
      const target = io.sockets.sockets.get(payload.to);
      if (target?.data.groupMember?.room_id !== id || !target.rooms.has(channel(id))) return;
      target.emit('group:signal', { from: socket.id, description: payload.description, candidate: payload.candidate, quality: payload.quality, restart: payload.restart === true });
    });
    socket.on('group:media', async payload => {
      if (!joined || !rateAllowed() || !payload) return;
      for (const key of ['audioEnabled', 'videoEnabled', 'screenEnabled', 'speaking', 'typing']) if (typeof payload[key] === 'boolean') socket.data.groupMedia[key] = payload[key];
      await roster();
    });
    socket.on('group:message', async (payload, ack) => {
      if (!joined || !rateAllowed() || typeof payload?.body !== 'string' || !payload.body.trim() || payload.body.length > 2000) return ack?.({ ok: false });
      try {
        const message = { id: crypto.randomUUID(), author_id: member.id, name: member.name, body: payload.body.trim(), created: Date.now() };
        ready.state.messages = [...(ready.state.messages || []), message].slice(-200);
        await save(id, ready);
        io.to(channel(id)).emit('group:message', message);
        ack?.({ ok: true });
      } catch { ack?.({ ok: false }); }
    });
    socket.on('group:operation', async (operation, ack) => {
      if (!joined || !rateAllowed() || !operation || !editableKinds.has(operation.kind) || typeof operation.relayId !== 'string' || operation.relayId.length > 100 || JSON.stringify(operation).length > 512 * 1024) return ack?.({ accepted: false });
      try {
        const state = ready.state;
        if (operation.kind === 'sync-request') {
          socket.emit('group:operation', { kind: 'sync', ...state, relayId: crypto.randomUUID(), relaySource: 'server-group' });
          return ack?.({ accepted: true });
        }
        if (!member.host && hostKinds.has(operation.kind)) return ack?.({ accepted: false });
        if (ready.seen.has(operation.relayId)) return ack?.({ accepted: true });
        if (!member.host && !state.studentPenEnabled && ['stroke-start', 'stroke-points', 'stroke'].includes(operation.kind)) return ack?.({ accepted: false });
        const own = value => typeof value === 'string' && value.includes(`-student-${member.id}-`);
        if (!member.host && operation.kind === 'erase' && (!Array.isArray(operation.ids) || !operation.ids.every(own))) return ack?.({ accepted: false });
        const op = { ...operation, relaySource: `group:${member.id}` };
        if (op.kind === 'stroke-start' || op.kind === 'stroke') {
          if (!op.stroke || !Array.isArray(op.stroke.points) || op.stroke.points.length > 1200 || !Number.isFinite(op.stroke.size)) return ack?.({ accepted: false });
          if (!member.host && !own(op.stroke.id)) return ack?.({ accepted: false });
          state.strokes = [...state.strokes.filter(s => s.id !== op.stroke.id), op.stroke];
        } else if (op.kind === 'stroke-points') {
          if (!Array.isArray(op.points) || op.points.length > 1200 || !member.host && !own(op.id)) return ack?.({ accepted: false });
          const stroke = state.strokes.find(s => s.id === op.id);
          if (stroke) stroke.points = [...stroke.points, ...op.points].slice(-1200);
        } else if (op.kind === 'erase') state.strokes = state.strokes.filter(s => !op.ids?.includes(s.id));
        else if (op.kind === 'item-upsert') {
          if (!op.item || typeof op.item.id !== 'string' || !['image', 'text'].includes(op.item.type)) return ack?.({ accepted: false });
          state.items = [...state.items.filter(i => i.id !== op.item.id), op.item];
        } else if (op.kind === 'item-delete') state.items = state.items.filter(i => i.id !== op.id);
        else if (op.kind === 'clear') { state.strokes = []; state.items = []; }
        else if (op.kind === 'board-session') state.boardOpen = op.open === true;
        else if (op.kind === 'board-permissions') { if (typeof op.studentPenEnabled !== 'boolean') return ack?.({ accepted: false }); state.studentPenEnabled = op.studentPenEnabled; }
        else if (op.kind === 'mode') state.mode = op.mode;
        else if (op.kind === 'document') { state.document = op.document; state.mode = op.document ? 'document' : 'video'; }
        else if (op.kind === 'document-view') state.documentView = op.view;
        else if (op.kind === 'document-annotations') {
          if (!Array.isArray(op.annotations)) return ack?.({ accepted: false });
          state.annotations = member.host ? op.annotations : [...state.annotations.filter(a => !own(a.id)), ...op.annotations.filter(a => own(a.id))];
          op.annotations = state.annotations;
        } else if (op.kind === 'youtube') { state.youtube = op.session; if (op.session) state.mode = 'youtube'; }
        else if (op.kind === 'sync') {
          for (const key of ['strokes', 'items', 'boardOpen', 'studentPenEnabled', 'document', 'documentView', 'annotations', 'youtube', 'mode']) if (key in op) state[key] = op[key];
        }
        ready.seen.add(op.relayId);
        if (ready.seen.size > 10000) ready.seen.delete(ready.seen.values().next().value);
        socket.to(channel(id)).emit('group:operation', op);
        if (!['pointer', 'stroke-start', 'stroke-points', 'document-preload'].includes(op.kind)) await save(id, ready);
        ack?.({ accepted: true });
      } catch { ack?.({ accepted: false }); }
    });
    socket.on('disconnect', () => {
      if (!joined) return;
      ready.sockets.delete(socket.id);
      void roster();
      if (!ready.sockets.size) void save(id, ready).catch(() => undefined).finally(() => { if (!ready.sockets.size && rooms.get(id) === ready) rooms.delete(id); });
    });
  });
  return { serve, authorizeSocket };
}
