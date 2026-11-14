import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import { networkRelay } from './helpers/network-relay.mjs';

const relay = await networkRelay();
const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 55295 });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  // Fake-media UI grants camera/mic. Explicit camera grants in this Chrome
  // build interfere with localhost relay permission; grant only the lab LAN.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['local-network-access'], serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.labConnections = []; window.labCaptures = 0;
    for (const method of ['createOffer', 'createAnswer']) {
      const native = RTCPeerConnection.prototype[method];
      RTCPeerConnection.prototype[method] = function (...args) { if (!window.labConnections.includes(this)) window.labConnections.push(this); return native.apply(this, args); };
    }
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => { if (constraints.audio) window.labCaptures++; return capture(constraints); };
  });
  await context.route('**/api/*/video/ice', route => route.fulfill({ json: { ice_servers: relay.iceServers, relay_available: true, ice_transport_policy: 'relay' } }));
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const teacher = await context.newPage(), student = await context.newPage(), pages = [teacher, student], errors = [];
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  const room = `udp-${Date.now()}`;
  await teacher.goto(`http://127.0.0.1:55295/video-test?room=${room}&role=teacher`);
  await student.goto(`http://127.0.0.1:55295/video-test?room=${room}&role=student`);
  for (const page of pages) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, null, { timeout: 30000 });
    await page.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  }
  const snapshot = page => page.evaluate(async () => {
    const media = window.labConnections.filter(pc => pc.getSenders().some(sender => sender.track?.kind === 'audio'));
    const pc = media.findLast(pc => pc.connectionState === 'connected');
    if (!pc) return { connected: false, connections: media.length };
    const report = await pc.getStats(), stats = [...report.values()];
    const audio = stats.find(row => row.type === 'inbound-rtp' && row.kind === 'audio'), video = stats.find(row => row.type === 'inbound-rtp' && row.kind === 'video');
    const transport = stats.find(row => row.type === 'transport' && row.selectedCandidatePairId), pair = report.get(transport?.selectedCandidatePairId);
    return { connected: true, transport: media.indexOf(pc), connections: media.length, candidate: report.get(pair?.localCandidateId)?.candidateType, packets: audio?.packetsReceived || 0, samples: audio?.totalSamplesReceived || 0, concealed: audio?.concealedSamples || 0, frames: video?.framesDecoded || 0, captures: window.labCaptures, video: pc.getSenders().find(sender => sender.track?.kind === 'video')?.getParameters().encodings[0] };
  });
  await student.waitForTimeout(3000);
  const baseline = await Promise.all(pages.map(snapshot));
  console.log('App relay baseline:', JSON.stringify(baseline));
  assert.ok(baseline.every(state => state.connected && state.candidate === 'relay' && state.samples > 0 && state.frames > 0));
  relay.impair({ bytesPerSecond: 22000, loss: .03, latency: 45 });
  await student.waitForTimeout(22000);
  const weak = await Promise.all(pages.map(snapshot));
  const directions = weak.map((state, index) => ({ audioPackets: state.packets - baseline[index].packets, samples: state.samples - baseline[index].samples, concealed: state.concealed - baseline[index].concealed, videoFrames: state.frames - baseline[index].frames, video: state.video }));
  console.log('App actual UDP impairment (176kbps, 3% loss, extra 45ms plus queue):', JSON.stringify({ relay: relay.metrics(), directions }));
  for (let index = 0; index < weak.length; index++) {
    assert.equal(weak[index].connected, true); assert.ok(directions[index].audioPackets > 150);
    assert.ok(directions[index].samples > 48000 * 8); assert.ok(directions[index].videoFrames > 3);
    assert.equal(weak[index].captures, baseline[index].captures);
  }
  assert.ok(relay.metrics().dropped > 0);
  relay.impair({ bytesPerSecond: 22000, loss: 1, latency: 0 });
  await student.waitForTimeout(9500);
  relay.impair({ bytesPerSecond: Infinity, loss: 0, latency: 0 });
  let recovered;
  // Sample counters can advance with concealment during silence/outages. Require
  // actual newly received RTP packets AND decoded video on a connected repair.
  const healthy = states => states.every((state, index) => state.connected && state.transport > weak[index].transport && state.packets > 100 && state.frames > 3);
  for (let attempt = 0; attempt < 30; attempt++) { await student.waitForTimeout(1000); recovered = await Promise.all(pages.map(snapshot)); if (healthy(recovered)) break; }
  console.log('App actual UDP recovery:', JSON.stringify(recovered));
  assert.ok(healthy(recovered), 'app must recover real media automatically after the network returns');
  assert.ok(recovered.every((state, index) => state.captures === baseline[index].captures), 'network repair never reopens the microphone');
  assert.deepEqual(errors, []);
} finally { await browser.close(); relay.close(); await new Promise(resolve => io.close(() => { httpServer.closeAllConnections(); httpServer.close(resolve); })); }
