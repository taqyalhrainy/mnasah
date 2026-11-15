// A second, authenticated route for classroom edits. Media stays peer-to-peer;
// a recipient acknowledgement lets its peer retain edits across reconnects.
const kinds = new Set(['sync-request', 'stroke', 'clear', 'erase', 'item-upsert', 'item-delete', 'mode', 'board-session', 'document', 'document-view', 'document-annotations', 'youtube', 'sync']);
const teacherOnly = new Set(['document', 'document-view']);
export function attachClassroomRelay(io, database) {
  const roomName = id => `classroom:${id}`;
  const announce = async id => {
    if (!id) return;
    const sockets = await io.in(roomName(id)).fetchSockets().catch(() => []);
    io.to(roomName(id)).emit('classroom:ready', { bookingId: id, ready: new Set(sockets.map(socket => socket.data.userId)).size > 1 });
  };
  async function membership(socket, id) {
    if (typeof id !== 'string' || !id || id.length > 150) return null;
    const db = database(), booking = await db.collection('bookings').findOne({ id });
    const slot = booking && await db.collection('slots').findOne({ id: booking.slot_id });
    if (!booking || !slot || ['cancelled', 'refunded'].includes(booking.status)) return null;
    const teacher = slot.teacher_id, student = booking.student_id, user = socket.data.userId;
    if (![teacher, student].includes(user)) return null;
    return { id, peer: user === teacher ? student : teacher, teacher: user === teacher, checked: Date.now() };
  }
  io.on('connection', socket => {
    let joined = null, joining = 0, inFlight = false, windowStart = 0, count = 0;
    socket.on('classroom:join', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      const generation = ++joining;
      try {
        const next = await membership(socket, payload?.bookingId);
        if (!socket.connected || generation !== joining) return ack({ accepted: false });
        if (!next) return ack({ accepted: false });
        const previous = joined?.id;
        if (previous) await socket.leave(roomName(previous));
        joined = next;
        await socket.join(roomName(next.id));
        ack({ accepted: true });
        if (previous && previous !== next.id) void announce(previous);
        void announce(next.id);
      } catch { ack({ accepted: false }); }
    });
    socket.on('classroom:operations', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (inFlight || !joined || payload?.bookingId !== joined.id) return ack({ delivered: false });
      inFlight = true;
      let pending = false;
      const generation = joining;
      try {
        if (Date.now() - joined.checked > 30000) {
          const current = await membership(socket, joined.id);
          if (generation !== joining) return ack({ delivered: false });
          joined = current;
        }
        if (!joined) return ack({ delivered: false, rejected: true });
        const active = joined;
        const operations = payload.operations;
        if (!Array.isArray(operations) || !operations.length || operations.length > 32 || Buffer.byteLength(JSON.stringify(operations)) > 512 * 1024) return ack({ delivered: false, rejected: true });
        if (operations.some(op => !op || !kinds.has(op.kind) || typeof op.relayId !== 'string' || op.relayId.length > 100 || !op.relayId.length || (teacherOnly.has(op.kind) && !joined.teacher) || (op.kind === 'youtube' && op.session === null && !joined.teacher) || (op.kind === 'sync' && !joined.teacher && ('document' in op || 'documentView' in op || op.youtube === null)))) return ack({ delivered: false, rejected: true });
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
        count += operations.length;
        if (count > 160) return ack({ delivered: false });
        const peers = (await io.in(roomName(active.id)).fetchSockets()).filter(peer => peer.data.userId === active.peer).map(peer => peer.id);
        if (generation !== joining || !socket.connected) return ack({ delivered: false });
        if (!peers.length) return ack({ delivered: false });
        pending = true;
        io.to(peers).timeout(2500).emit('classroom:operations', { bookingId: active.id, operations }, (_error, responses) => {
          inFlight = false;
          ack({ delivered: responses?.some(response => response?.received === true) || false });
        });
        return;
      } catch { ack({ delivered: false }); }
      finally { if (!pending) inFlight = false; }
    });
    socket.on('disconnect', () => { joining++; void announce(joined?.id); });
  });
}
