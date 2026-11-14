import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/services/adaptiveCallQuality.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
const create = new Function('module', 'exports', 'window', 'Date', `${built.outputFiles[0].text}; return module.exports;`);
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function setup({ screen = false, reject = false, expectsMedia, onStall } = {}) {
  let clock = 100000, polling;
  const changes = [], feedback = [];
  const window = { setInterval(fn) { polling = fn; return 1; }, clearInterval() { polling = undefined; } };
  const { AdaptiveCallQuality, speechSdp } = create({ exports: {} }, {}, window, class extends Date { static now() { return clock; } });
  function sender(kind) {
    let params = { encodings: [{ active: true }] };
    return {
      track: { kind, enabled: false, readyState: 'live' }, calls: [],
      getParameters: () => structuredClone(params),
      async setParameters(value) {
        this.calls.push(structuredClone(value));
        if (reject && value.encodings[0].priority) throw new Error('Optional knobs unsupported');
        params = structuredClone(value);
      },
    };
  }
  const audio = sender('audio'), video = sender('video'), screenVideo = sender('video');
  let bandwidth = 800000, loss = 0, received = 1000, lost = 200, concealed = 0, samples = 480000, rtt = .03;
  const connection = {
    getSenders: () => [audio, video],
    getStats: async () => new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: bandwidth, currentRoundTripTime: rtt }],
      ['unused', { id: 'unused', type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 1 }],
      ['remote', { id: 'remote', type: 'remote-inbound-rtp', fractionLost: loss }],
      ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', packetsReceived: received, packetsLost: lost, concealedSamples: concealed, totalSamplesReceived: samples }],
    ]),
  };
  const quality = new AdaptiveCallQuality({ connection, screen: () => screen ? { getSenders: () => [screenVideo] } : undefined, expectsMedia, onStall, onReceiveQuality: level => feedback.push(level), onChange: level => changes.push(level) });
  return { quality, speechSdp, changes, feedback, audio, video, screenVideo, connection,
    set(values) { ({ bandwidth = bandwidth, loss = loss, received = received, lost = lost, concealed = concealed, samples = samples, rtt = rtt } = values); },
    async tick(count = 1) { for (let i = 0; i < count; i++) { clock += 2000; received += 100; samples += 96000; polling?.(); await settle(); } },
    hasTimer: () => !!polling,
  };
}

test('speech has priority, bounded bitrate and mono SDP with FEC; video/media sections remain intact', async () => {
  const h = setup(); h.quality.start(); await settle();
  assert.equal(h.audio.getParameters().encodings[0].maxBitrate, 32000);
  assert.equal(h.audio.getParameters().encodings[0].priority, 'high');
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 420000);
  assert.equal(h.audio.track.enabled, false, 'never unmute the user');
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0;stereo=1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
  const tuned = h.speechSdp(sdp);
  assert.match(tuned, /minptime=10;useinbandfec=1;stereo=0;usedtx=1;sprop-stereo=0;maxaveragebitrate=32000/);
  assert.equal(tuned.split('m=video')[1], sdp.split('m=video')[1]);
  assert.equal(h.speechSdp(tuned), tuned);
  h.quality.stop();
});

test('bandwidth loss preserves low-rate video and voice, then recovers gradually', async () => {
  const h = setup({ screen: true }); h.quality.start(); await settle();
  h.set({ bandwidth: 240000 }); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 70000);
  assert.equal(h.screenVideo.getParameters().encodings[0].maxBitrate, 120000);
  h.set({ bandwidth: 60000 }); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxFramerate, 4);
  assert.equal(h.screenVideo.getParameters().encodings[0].active, true);
  assert.equal(h.audio.getParameters().encodings[0].active, true);
  assert.equal(h.audio.track.readyState, 'live');
  h.set({ bandwidth: 800000 }); await h.tick(7);
  assert.equal(h.video.getParameters().encodings[0].active, true);
  await h.tick(); assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 27500);
  await h.tick(16); assert.equal(h.video.getParameters().encodings[0].maxBitrate, 210000);
  assert.deepEqual(h.changes, [1, 3, 2, 1, 0]);
  h.quality.stop(); assert.equal(h.hasTimer(), false);
});

test('incoming loss uses recent deltas and tells the other side to reduce its upload', async () => {
  const h = setup(); h.quality.start(); await settle(); await h.tick();
  assert.equal(h.feedback.at(-1), 0, 'historical losses must not poison the entire call');
  h.set({ lost: 230 }); await h.tick();
  assert.equal(h.feedback.at(-1), 3);
  assert.equal(h.video.getParameters().encodings[0].active, true);
  await h.tick(8); assert.equal(h.feedback.at(-1), 2);
  h.quality.stop();
});

test('a weak receiver limits the strong sender; invalid feedback is ignored and stale feedback expires', async () => {
  const h = setup(); h.quality.start(); await settle();
  h.quality.remoteReceiveQuality(2); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 55000);
  for (const invalid of [99, -1, '3', NaN, 1.5, null]) h.quality.remoteReceiveQuality(invalid);
  await h.tick(); assert.equal(h.video.getParameters().encodings[0].maxBitrate, 55000);
  await h.tick(7); assert.equal(h.video.getParameters().encodings[0].maxBitrate, 420000);
  h.quality.stop();
});

test('Safari optional-parameter rejection falls back to portable bitrate/active controls', async () => {
  const h = setup({ reject: true }); h.quality.start(); await settle();
  assert.equal(h.audio.getParameters().encodings[0].maxBitrate, 32000);
  h.set({ loss: .2 }); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 28000);
  assert.equal(h.audio.getParameters().encodings[0].active, true);
  h.quality.stop();
});

test('late statistics after leaving cannot change a retired sender', async () => {
  const h = setup(); let finish;
  h.connection.getStats = () => new Promise(resolve => { finish = resolve; });
  h.quality.start(); h.quality.stop();
  finish(new Map()); await settle();
  assert.equal(h.video.calls.length, 0); assert.equal(h.audio.calls.length, 0);
  h.quality.remoteReceiveQuality(3); await h.tick(); assert.equal(h.video.calls.length, 0);
});

test('clean audio allows a recovery probe instead of trapping video at its lowest rate', async () => {
  const h = setup(); h.set({ bandwidth: 60000 }); h.quality.start(); await settle();
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 28000);
  await h.tick(8); assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 55000);
  await h.tick(); assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.audio.getParameters().encodings[0].active, true);
  h.quality.stop();
});

test('unavailable statistics still apply a safe baseline bitrate and audio priority', async () => {
  const h = setup(); h.connection.getStats = async () => { throw new Error('Stats unavailable'); };
  h.quality.start(); await settle();
  assert.equal(h.audio.getParameters().encodings[0].priority, 'high');
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 420000);
  h.quality.stop();
});

test('a demand-limited encoder cannot be trapped in low quality by its own low bandwidth estimate', async () => {
  const h = setup(); const original = h.connection.getStats;
  h.connection.getStats = async () => { const stats = await original(); stats.set('outgoing', { type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none' }); return stats; };
  h.set({ bandwidth: 60000 }); h.quality.start(); await settle();
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 420000);
  h.set({ loss: .2 }); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 28000, 'real loss still overrides the encoder heuristic');
  h.set({ loss: 0 }); await h.tick(24);
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.video.getParameters().encodings[0].maxBitrate, 420000);
  h.quality.stop();
});

test('only persistent severe AUDIO damage suspends video, and three good audio samples restore it', async () => {
  const h = setup(); const original = h.connection.getStats;
  h.connection.getStats = async () => { const stats = await original(); stats.get('remote').kind = 'audio'; return stats; };
  h.quality.start(); await settle(); h.set({ loss: .4 });
  await h.tick(2); assert.equal(h.video.getParameters().encodings[0].active, true);
  await h.tick(); assert.equal(h.video.getParameters().encodings[0].active, false);
  assert.equal(h.audio.getParameters().encodings[0].active, true);
  assert.equal(h.audio.getParameters().encodings[0].maxBitrate, 24000);
  h.set({ loss: 0 }); await h.tick(3);
  assert.equal(h.video.getParameters().encodings[0].active, true);
  assert.equal(h.audio.track.enabled, false);
  h.quality.stop();
});

test('an authenticated peer can request temporary audio protection without stopping microphone capture', async () => {
  const h = setup(); h.quality.start(); await settle();
  h.quality.remoteReceiveQuality(3, true); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].active, false);
  assert.equal(h.audio.getParameters().encodings[0].active, true);
  h.quality.remoteReceiveQuality(2, false); await h.tick();
  assert.equal(h.video.getParameters().encodings[0].active, true);
  h.quality.stop();
});

test('stalled RTP triggers repair only while the remote participant expects media', async () => {
  let expected = 'audio', repairs = 0;
  const h = setup({ expectsMedia: () => expected, onStall: () => repairs++ });
  const original = h.connection.getStats;
  h.connection.getStats = async () => { const stats = await original(); stats.get('audio').packetsReceived = 100; return stats; };
  h.quality.start(); await settle();
  await h.tick(3); assert.equal(repairs, 0);
  await h.tick(); assert.equal(repairs, 1);
  expected = null; await h.tick(8); assert.equal(repairs, 1, 'intentional mute is not an RTP failure');
  h.quality.stop();
});

test('a connected transport with no incoming RTP at all still requests recovery', async () => {
  let repairs = 0;
  const h = setup({ expectsMedia: () => 'audio', onStall: () => repairs++ });
  h.connection.getStats = async () => new Map();
  h.quality.start(); await settle(); await h.tick(4);
  assert.equal(repairs, 1);
  h.quality.stop();
});
