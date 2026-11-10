import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';

// Run the actual service with deterministic transport/device boundaries. No
// browser permissions, network services, or production injection hooks needed.
const bundle = await build({
  entryPoints: ['src/services/videoConnection.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'node', define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'service-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(peerjs|\.\.\/i18n\/preferences|\.\/platformApi)$/ }, args => ({ path: args.path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents:
      args.path === 'peerjs' ? 'export default testPeer;' :
        args.path === './platformApi' ? 'export const request = async () => ({});' : 'export const t = text => text;',
    }));
  } }],
});
const createService = new Function('module', 'exports', 'testPeer', 'navigator', 'window', 'document', 'MediaStream', `${bundle.outputFiles[0].text}; return module.exports.VideoConnection;`);
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test('camera flip replaces only video, preserves microphone and retains the selected camera on toggles', async () => {
  const h = harness();
  const stream = await h.service.start({ video: true });
  const microphone = stream.getAudioTracks()[0], front = stream.getVideoTracks()[0];
  const rear = new Track('video'); rear.getSettings = () => ({ facingMode: 'environment' });
  h.devices.acquire = async constraints => { assert.equal(constraints.audio, false); assert.equal(constraints.video.facingMode.ideal, 'environment'); return new Stream([rear]); };
  const result = await h.service.switchCamera();
  assert.equal(result.facing, 'environment'); assert.equal(result.stream, stream);
  assert.equal(front.readyState, 'ended'); assert.equal(stream.getVideoTracks()[0], rear);
  assert.equal(stream.getAudioTracks()[0], microphone); assert.equal(microphone.readyState, 'live');
  const count = h.acquisitions.length;
  await h.service.toggleVideo(false); await h.service.toggleVideo(true);
  assert.equal(h.acquisitions.length, count); assert.equal(stream.getVideoTracks()[0], rear);
  h.service.close();
});

test('failed rear-camera switch restores the front camera without stopping audio', async () => {
  const h = harness(); const stream = await h.service.start({ video: true });
  const microphone = stream.getAudioTracks()[0], restored = new Track('video');
  h.devices.acquire = async constraints => { if (constraints.video.facingMode.ideal === 'environment') throw Object.assign(new Error('no rear camera'), { name: 'NotFoundError' }); return new Stream([restored]); };
  await assert.rejects(h.service.switchCamera());
  assert.equal(h.service.getCameraFacing(), 'user'); assert.equal(stream.getVideoTracks()[0], restored);
  assert.equal(stream.getAudioTracks()[0], microphone); assert.equal(microphone.readyState, 'live');
  h.service.close();
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class Track extends EventTarget {
  readyState = 'live'; enabled = true; muted = false; onended = null;
  constructor(kind) { super(); this.kind = kind; }
  stop() { this.readyState = 'ended'; }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
}
class Transport extends EventEmitter {
  open = false; sent = []; closed = false;
  constructor(peer) {
    super(); this.peer = peer;
    this.peerConnection = Object.assign(new EventTarget(), {
      connectionState: 'new', getSenders: () => [], getReceivers: () => [], restartIce() {},
    });
  }
  answer() {}
  send(message) { this.sent.push(message); this.deliver?.(message); }
  close(options) {
    if (options?.flush) { this.flushed = true; this.flush?.(); return; }
    if (this.closed) return;
    this.closed = true; this.open = false; this.emit('close');
  }
  opened() { this.open = true; this.emit('open'); }
  state(state) { this.peerConnection.connectionState = state; this.peerConnection.dispatchEvent(new Event('connectionstatechange')); }
}

// PeerJS incoming media calls do not have an RTCPeerConnection until answer().
class IncomingCall extends Transport {
  constructor(peer) { super(peer); this.peerConnection = undefined; }
  answer(stream) {
    this.answeredWith = stream;
    this.open = true;
    this.peerConnection = Object.assign(new EventTarget(), {
      connectionState: 'new', getSenders: () => [], getReceivers: () => [], restartIce() {},
    });
  }
}

function harness(role = 'teacher', getRemotePeerId) {
  const timers = new Map(); let clock = 0; let nextTimer = 0;
  const peers = []; const acquisitions = [];
  const timer = (fn, delay, interval = false) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay, delay, interval }); return id; };
  const window = Object.assign(new EventTarget(), {
    setTimeout: (fn, delay) => timer(fn, delay), setInterval: (fn, delay) => timer(fn, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  });
  class Peer extends EventEmitter {
    open = true; calls = []; connections = []; destroyed = false; disconnected = false;
    constructor() { super(); peers.push(this); }
    call(peer) { const call = new Transport(peer); this.calls.push(call); return call; }
    connect(peer) { const data = new Transport(peer); this.connections.push(data); return data; }
    destroy() { this.destroyed = true; this.calls.forEach(call => call.close()); this.connections.forEach(data => data.close()); }
    reconnect() { this.disconnected = false; }
  }
  const devices = {
    async getUserMedia(constraints) {
      acquisitions.push(constraints);
      if (devices.acquire) return devices.acquire(constraints);
      return new Stream([...(constraints.audio ? [new Track('audio')] : []), ...(constraints.video ? [new Track('video')] : [])]);
    },
    getDisplayMedia: async () => new Stream([new Track('video')]),
  };
  const document = { visibilityState: 'visible', createElement: () => ({ getContext: () => ({ clearRect() {} }) }) };
  const module = { exports: {} };
  const VideoConnection = createService(module, module.exports, Peer, { mediaDevices: devices }, window, document, Stream);
  const events = [];
  const callbacks = Object.fromEntries([
    'onRemoteStream', 'onRemoteVideoSource', 'onRemoteVideoEnabled', 'onRemoteAudioEnabled', 'onRemoteTyping',
    'onRemoteSpeaking', 'onDataOpen', 'onLocalPeerId', 'onLocalVideoSource', 'onLocalScreenStream',
    'onRemoteScreenStream', 'onLocalStreamChange', 'onRemoteProfile', 'onPeerLeft', 'onStatus',
  ].map(name => [name, (...args) => events.push([name, ...args])]));
  if (getRemotePeerId) callbacks.getRemotePeerId = getRemotePeerId;
  const service = new VideoConnection('room-1', role, callbacks);
  return {
    service, peers, events, acquisitions, devices, timers, callbacks, document, window,
    async advance(ms) {
      const target = clock + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, value] = next; clock = value.at;
        if (value.interval) value.at += value.delay; else timers.delete(id);
        value.fn(); await settle();
      }
      clock = target; await settle();
    },
  };
}

async function participant() {
  const h = harness(); await h.service.start();
  const peer = h.peers[0];
  const data = new Transport('student-1'); peer.emit('connection', data); data.opened();
  const call = peer.calls.at(-1); const remote = new Stream([new Track('audio'), new Track('video')]);
  call.emit('stream', remote);
  data.emit('data', { type: 'profile', profile: { name: 'Student' } });
  data.emit('data', { type: 'speaking', speaking: true });
  h.events.length = 0;
  return { ...h, peer, data, call, remote };
}

for (const ordering of ['data-first', 'media-first']) test(`incoming call is answered before diagnostics bind (${ordering})`, async () => {
  const h = harness('student', async () => 'teacher');
  const local = await h.service.start({ video: true });
  const peer = h.peers[0];
  if (ordering === 'data-first') {
    peer.emit('open', 'student'); await settle(); peer.connections[0].opened();
  }
  const call = new IncomingCall('teacher');
  assert.equal(call.peerConnection, undefined);
  assert.doesNotThrow(() => peer.emit('call', call));
  assert.equal(call.answeredWith, local);
  assert.ok(call.peerConnection);
  const remote = new Stream([new Track('audio'), new Track('video')]);
  call.emit('stream', remote);
  if (ordering === 'media-first') peer.connections[0].opened();
  assert.ok(h.events.some(event => event[0] === 'onRemoteStream' && event[1] === remote));
  assert.equal(call.closed, false);
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 0);
  h.service.close();
});

function assertCleared(h) {
  for (const [name, value] of [
    ['onRemoteProfile', null], ['onRemoteSpeaking', false], ['onRemoteTyping', false],
    ['onRemoteScreenStream', null], ['onRemoteVideoEnabled', false], ['onRemoteAudioEnabled', false],
  ]) assert.ok(h.events.some(event => event[0] === name && event[1] === value), name);
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 1);
  assert.ok(h.call.closed);
  assert.ok(h.remote.getTracks().every(track => track.readyState === 'ended'));
}

test('explicit leave clears media/profile/activity immediately, acknowledges and retires screen calls', async () => {
  const h = await participant();
  const screen = new Transport('student-1'); screen.metadata = { kind: 'screen' };
  h.peer.emit('call', screen); screen.emit('stream', new Stream([new Track('video')]));
  h.data.emit('data', { type: 'peer-leave' });
  assertCleared(h); assert.ok(screen.closed);
  assert.deepEqual(h.data.sent.at(-1), { type: 'peer-leave-ack' });
  assert.ok(h.data.flushed);
  h.data.emit('data', { type: 'speaking', speaking: true });
  assert.deepEqual(h.events.filter(event => event[0] === 'onRemoteSpeaking').at(-1), ['onRemoteSpeaking', false]);
  await h.advance(750); assert.ok(h.data.closed);
  h.service.close();
});

for (const signal of ['close', 'error']) test(`data ${signal} clears a participant without waiting for ICE`, async () => {
  const h = await participant(); h.data.emit(signal, new Error('network'));
  assertCleared(h);
  h.call.emit('close'); h.data.emit('close');
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 1);
  h.service.close();
});

test('close sends leave before teardown, stops capture synchronously and waits for acknowledgement', async () => {
  const h = await participant();
  const local = await h.service.start({ video: true }); await h.service.toggleVideo(true);
  const camera = h.acquisitions.length;
  h.service.close(); h.service.close();
  assert.equal(camera, 2);
  assert.deepEqual(h.data.sent.at(-1), { type: 'peer-leave' });
  assert.ok(local.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(h.peer.destroyed, false); assert.equal(h.data.closed, false);
  h.data.emit('data', { type: 'peer-leave-ack' });
  assert.ok(h.peer.destroyed); assert.ok(h.data.closed);
  assert.equal(h.data.sent.filter(message => message.type === 'peer-leave').length, 1);
  assert.equal(h.timers.size, 0);
});

test('leave timeout destroys only the captured session after immediate same-instance restart', async () => {
  const h = await participant(); h.service.close();
  await h.service.start(); const replacement = h.peers.at(-1);
  await h.advance(749); assert.equal(h.peer.destroyed, false);
  await h.advance(1); assert.ok(h.peer.destroyed); assert.equal(replacement.destroyed, false);
  h.service.close();
});

test('connected peers deliver leave and acknowledgement before transport destruction', async () => {
  const teacher = harness(); const student = harness('student');
  await Promise.all([teacher.service.start(), student.service.start()]);
  const incomingCall = new IncomingCall('teacher'); student.peers[0].emit('call', incomingCall);
  const outgoingData = student.peers[0].connections[0];
  const incomingData = new Transport('student'); teacher.peers[0].emit('connection', incomingData);
  for (const [from, to] of [[outgoingData, incomingData], [incomingData, outgoingData]]) {
    from.deliver = message => queueMicrotask(() => { if (from.open && to.open) to.emit('data', message); });
    from.flush = () => queueMicrotask(() => to.close());
  }
  incomingData.opened(); outgoingData.opened(); await settle();
  const remote = new Stream([new Track('audio')]); incomingCall.emit('stream', remote);
  student.events.length = 0;
  teacher.service.close(); assert.equal(teacher.peers[0].destroyed, false);
  await settle();
  assert.ok(teacher.peers[0].destroyed);
  assert.ok(outgoingData.sent.some(message => message.type === 'peer-leave-ack'));
  assert.ok(remote.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(student.events.filter(event => event[0] === 'onPeerLeft').length, 1);
  assert.ok([...teacher.timers.values()].every(timer => timer.delay !== 750));
  student.service.close();
});

test('a failed leave send still stops capture, clears its deadline and destroys transport', async () => {
  const h = await participant(); const local = await h.service.start();
  h.data.send = () => { throw new Error('closed channel'); };
  h.service.close();
  assert.ok(h.peer.destroyed); assert.equal(h.timers.size, 0);
  assert.ok(local.getTracks().every(track => track.readyState === 'ended'));
});

test('pagehide sends leave on unload, while backgrounding, PiP and BFCache stay resumable', async () => {
  const h = await participant(); const local = await h.service.start();
  h.document.visibilityState = 'hidden'; h.window.dispatchEvent(new Event('visibilitychange'));
  h.window.dispatchEvent(new Event('enterpictureinpicture'));
  h.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  assert.ok(local.getTracks().every(track => track.readyState === 'live'));
  assert.equal(h.data.sent.some(message => message.type === 'peer-leave'), false);
  h.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  assert.deepEqual(h.data.sent.at(-1), { type: 'peer-leave' });
  assert.ok(local.getTracks().every(track => track.readyState === 'ended'));
  await h.advance(750); assert.ok(h.peer.destroyed);
  await h.service.start(); const peer = h.peers.at(-1);
  h.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  assert.ok(peer.destroyed);
});

test('returning peer survives old data/media/track/ICE callbacks and retired stream events', async () => {
  const h = await participant(); h.data.emit('data', { type: 'peer-leave' });
  const fresh = new Transport('student-1'); h.peer.emit('connection', fresh); fresh.opened();
  const call = h.peer.calls.at(-1); const stream = new Stream([new Track('audio')]); call.emit('stream', stream);
  h.events.length = 0;
  h.data.emit('close'); h.data.emit('error', new Error('late')); h.data.emit('data', { type: 'peer-leave' });
  h.call.emit('close'); h.call.emit('error', new Error('late')); h.call.emit('stream', h.remote);
  h.remote.getTracks()[0].dispatchEvent(new Event('ended')); h.call.state('failed');
  await h.advance(18000);
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 0);
  assert.equal(h.events.filter(event => event[0] === 'onRemoteStream').length, 0);
  assert.equal(call.closed, false); assert.equal(fresh.closed, false);
  h.service.close();
});

test('new peer ID replaces old media before replaying state; late close cannot erase it', async () => {
  const h = await participant(); h.callbacks.getRemotePeerId = async () => 'student-2';
  const data = new Transport('student-2'); h.peer.emit('connection', data); data.opened(); await settle();
  assertCleared(h);
  const call = h.peer.calls.at(-1); call.emit('stream', new Stream([new Track('audio')]));
  h.events.length = 0; h.data.emit('close'); h.call.state('disconnected');
  await h.advance(30000);
  assert.equal(call.closed, false);
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 0);
  h.service.close();
});

test('an asynchronous data-open validation cannot displace a newer accepted connection', async () => {
  const h = await participant(); const validation = deferred();
  h.callbacks.getRemotePeerId = () => validation.promise;
  const stale = new Transport('student-2'); h.peer.emit('connection', stale); stale.opened();
  h.data.emit('close');
  const fresh = new Transport('student-3'); h.peer.emit('connection', fresh); fresh.opened();
  const call = h.peer.calls.at(-1); call.emit('stream', new Stream([new Track('audio')]));
  h.events.length = 0; validation.resolve('student-2'); await settle();
  assert.ok(stale.closed); assert.equal(fresh.closed, false); assert.equal(call.closed, false);
  assert.equal(h.events.filter(event => event[0] === 'onPeerLeft').length, 0);
  h.service.close();
});

test('initial start requests both devices once and reuses live camera/audio during toggles and resume', async () => {
  const h = harness(); const first = h.service.start({ video: true });
  assert.equal(h.service.start({ video: true }), first);
  const local = await first; const camera = local.getVideoTracks()[0];
  assert.ok(h.acquisitions[0].audio); assert.ok(h.acquisitions[0].video);
  await h.service.toggleVideo(false); camera.muted = true;
  await h.service.toggleVideo(true); camera.muted = false;
  h.service.resumeAfterBackground(); await settle();
  assert.equal(h.acquisitions.length, 1);
  h.service.close(); assert.ok(local.getTracks().every(track => track.readyState === 'ended'));
  await h.service.start({ video: true });
  assert.equal(h.acquisitions.length, 2, 'stopped tracks are never reused across leave');
  h.service.close();
});

test('concurrent camera requests share acquisition and a pending toggle respects a later disable', async () => {
  const h = harness(); await h.service.start(); const device = deferred(); h.devices.acquire = () => device.promise;
  const a = h.service.toggleVideo(true); const b = h.service.toggleVideo(true);
  await h.service.toggleVideo(false);
  const camera = new Track('video'); device.resolve(new Stream([camera])); await Promise.all([a, b]);
  assert.equal(h.acquisitions.length, 2); assert.equal(camera.enabled, false);
  h.service.close(); assert.equal(camera.readyState, 'ended');
});

test('pending audio/video repairs and display capture stop late tracks after leave', async () => {
  const h = harness(); const local = await h.service.start({ video: true });
  local.getTracks().forEach(track => track.stop());
  const audio = deferred(); const video = deferred(); const display = deferred();
  h.devices.acquire = constraints => constraints.audio ? audio.promise : video.promise;
  h.devices.getDisplayMedia = () => display.promise;
  const repairs = [h.service.repairAudio(), h.service.repairAudio(), h.service.repairVideo(true), h.service.toggleVideo(true), assert.rejects(h.service.startScreenShare(), /Call closed/)];
  assert.equal(h.acquisitions.length, 3);
  h.service.close(); h.events.length = 0;
  const tracks = [new Track('audio'), new Track('video'), new Track('video')];
  audio.resolve(new Stream([tracks[0]])); video.resolve(new Stream([tracks[1]])); display.resolve(new Stream([tracks[2]]));
  await Promise.all(repairs);
  assert.ok(tracks.every(track => track.readyState === 'ended'));
  assert.equal(h.events.length, 0);
});

test('late start acquisition cannot replace a restarted session or leave its device running', async () => {
  const h = harness(); const device = deferred(); h.devices.acquire = () => device.promise;
  const old = h.service.start(); const rejected = assert.rejects(old, /Call closed/);
  h.service.close(); h.devices.acquire = undefined;
  const current = await h.service.start(); const stale = new Track('audio'); device.resolve(new Stream([stale]));
  await rejected; assert.equal(stale.readyState, 'ended');
  assert.equal(current.getTracks()[0].readyState, 'live'); assert.equal(h.peers.length, 1);
  h.service.close();
});

test('discovery and media timeout retries remain available for both roles', async () => {
  for (const role of ['teacher', 'student']) {
    let remote = 'peer-1'; const h = harness(role, async () => remote); await h.service.start();
    const peer = h.peers[0]; peer.emit('open', 'local'); await settle();
    const transports = role === 'teacher' ? peer.calls : peer.connections;
    assert.equal(transports.length, 1);
    if (role === 'teacher') { await h.advance(18000); assert.ok(transports.length >= 2); }
    else { transports[0].opened(); transports[0].emit('close'); await settle(); assert.equal(transports.length, 2); }
    remote = 'peer-2'; await h.advance(1500); assert.equal(transports.at(-1).peer, 'peer-2');
    h.service.close();
  }
});

test('transient ICE disconnects keep their foreground/background recovery grace periods', async () => {
  for (const [visibility, grace] of [['visible', 12000], ['hidden', 30000]]) {
    const h = await participant(); h.document.visibilityState = visibility;
    h.call.state('disconnected'); await h.advance(grace - 1);
    assert.equal(h.call.closed, false);
    h.call.state('connected'); await h.advance(1);
    assert.equal(h.call.closed, false);
    h.call.state('disconnected'); await h.advance(grace);
    assertCleared(h); h.service.close();
  }
});

for (const name of ['NotReadableError', 'AbortError']) test(`${name} retries microphone capture after 150/300 ms`, async () => {
  const h = harness(); let attempts = 0;
  h.devices.acquire = () => {
    if (++attempts < 3) throw new DOMException('device releasing', name);
    return new Stream([new Track('audio')]);
  };
  const joining = h.service.start(); await settle();
  await h.advance(149); assert.equal(attempts, 1);
  await h.advance(1); assert.equal(attempts, 2);
  await h.advance(299); assert.equal(attempts, 2);
  await h.advance(1); const stream = await joining;
  assert.equal(attempts, 3); assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  h.service.close();
});

test('exhausted combined camera capture falls back to a live microphone with video disabled', async () => {
  const h = harness();
  h.devices.acquire = constraints => {
    if (constraints.video) throw new DOMException('camera busy', 'NotReadableError');
    return new Stream([new Track('audio')]);
  };
  const joining = h.service.start({ video: true }); await settle(); await h.advance(450);
  const stream = await joining;
  assert.equal(h.acquisitions.length, 4);
  assert.equal(h.acquisitions.at(-1).video, false);
  assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  const data = new Transport('student'); h.peers[0].emit('connection', data); data.opened();
  assert.deepEqual(data.sent.find(message => message.type === 'video-state'), { type: 'video-state', enabled: false });
  h.service.close(); assert.equal(stream.getAudioTracks()[0].readyState, 'ended');
});

test('combined plus mic-only failures exhaust retries within 900 ms of scheduled backoff', async () => {
  const h = harness(); h.devices.acquire = () => { throw new DOMException('device busy', 'AbortError'); };
  const failed = assert.rejects(h.service.start({ video: true })); await settle();
  await h.advance(899); assert.equal(h.acquisitions.length, 5);
  await h.advance(1); await failed;
  assert.equal(h.acquisitions.length, 6); assert.equal(h.timers.size, 0); assert.equal(h.peers.length, 0);
  h.service.close();
});

for (const name of ['NotFoundError', 'OverconstrainedError']) test(`${name} on combined capture falls back to microphone without retrying camera`, async () => {
  const h = harness();
  h.devices.acquire = constraints => {
    if (constraints.video) throw new DOMException('camera unavailable', name);
    return new Stream([new Track('audio')]);
  };
  const stream = await h.service.start({ video: true });
  assert.equal(h.acquisitions.length, 2); assert.equal(h.timers.size, 0);
  assert.equal(stream.getAudioTracks()[0].readyState, 'live'); h.service.close();
});

for (const name of ['NotAllowedError', 'SecurityError']) test(`${name} is never retried or followed by an automatic permission fallback`, async () => {
  for (const video of [true, false]) {
    const h = harness(); h.devices.acquire = () => { throw new DOMException('denied', name); };
    await assert.rejects(h.service.start({ video }));
    assert.equal(h.acquisitions.length, 1); assert.equal(h.timers.size, 0);
    h.service.close();
  }
});

test('audio/video repairs share transient retries; a failed camera toggle preserves microphone and reports video off', async () => {
  const h = harness(); const stream = await h.service.start(); stream.getAudioTracks()[0].stop();
  let attempts = 0;
  h.devices.acquire = () => {
    if (++attempts === 1) throw new DOMException('device releasing', 'AbortError');
    return new Stream([new Track('audio')]);
  };
  const repairs = [h.service.repairAudio(), h.service.repairAudio()]; await settle(); await h.advance(150); await Promise.all(repairs);
  assert.equal(attempts, 2); const mic = stream.getAudioTracks()[0];
  h.devices.acquire = () => { throw new DOMException('camera busy', 'NotReadableError'); };
  const cameraFailed = assert.rejects(h.service.toggleVideo(true), { name: 'NotReadableError' });
  await settle(); await h.advance(450); await cameraFailed;
  assert.equal(mic.readyState, 'live');
  const data = new Transport('student'); h.peers[0].emit('connection', data); data.opened();
  assert.deepEqual(data.sent.find(message => message.type === 'video-state'), { type: 'video-state', enabled: false });
  h.service.close();
});

test('camera repair retries share acquisition with a concurrent enable', async () => {
  const h = harness(); const stream = await h.service.start({ video: true }); stream.getVideoTracks()[0].stop();
  let attempts = 0;
  h.devices.acquire = () => {
    if (++attempts === 1) throw new DOMException('camera releasing', 'NotReadableError');
    return new Stream([new Track('video')]);
  };
  const repairs = [h.service.repairVideo(true), h.service.repairVideo(true), h.service.toggleVideo(true)];
  await settle(); await h.advance(150); await Promise.all(repairs);
  assert.equal(attempts, 2); assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  assert.equal(stream.getVideoTracks()[0].readyState, 'live'); h.service.close();
});

test('close/restart cancels a delayed retry before another device request or microphone fallback', async () => {
  const h = harness(); h.devices.acquire = () => { throw new DOMException('device busy', 'NotReadableError'); };
  const canceled = assert.rejects(h.service.start({ video: true }), /Call closed/); await settle();
  h.service.close(); h.devices.acquire = undefined;
  const stream = await h.service.start(); await h.advance(900); await canceled;
  assert.equal(h.acquisitions.length, 2); assert.equal(h.peers.length, 1);
  assert.equal(stream.getAudioTracks()[0].readyState, 'live'); h.service.close();
});

test('initial camera enable, forced repair and restored combined capture use identical camera constraints', async () => {
  const h = harness(); await h.service.start();
  await h.service.toggleVideo(true); const initial = h.acquisitions.at(-1).video;
  await h.service.repairVideo(true); assert.deepEqual(h.acquisitions.at(-1).video, initial);
  h.service.close(); await h.service.start({ video: true });
  assert.deepEqual(h.acquisitions.at(-1).video, initial);
  assert.equal(initial.deviceId, undefined);
  assert.deepEqual(initial.facingMode, { ideal: 'user' }); h.service.close();
});

test('NotFoundError during forced camera repair is attempted once and preserves the existing camera and microphone', async () => {
  const h = harness(); const stream = await h.service.start({ video: true });
  const camera = stream.getVideoTracks()[0]; const mic = stream.getAudioTracks()[0];
  h.devices.acquire = () => { throw new DOMException('Requested device not found', 'NotFoundError'); };
  await assert.rejects(h.service.repairVideo(true), { name: 'NotFoundError' });
  assert.equal(h.acquisitions.length, 2); assert.equal(h.timers.size, 0);
  assert.equal(stream.getVideoTracks()[0], camera); assert.equal(camera.readyState, 'live');
  assert.equal(mic.readyState, 'live'); h.service.close();
});
