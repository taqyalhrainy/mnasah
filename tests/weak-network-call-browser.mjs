import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.testConnections = []; window.captureCount = 0; window.captureLog = [];
    const Original = window.RTCPeerConnection;
    window.networkTestPhase = 'normal';
    window.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); window.testConnections.push(this); }
      async getStats(...args) {
        const report = await super.getStats(...args);
        if (window.networkTestPhase === 'normal' || !this.getSenders().some(sender => sender.track?.kind === 'audio')) return report;
        // Inject congestion telemetry, retaining REAL media/encoding/audio stats.
        // HTTP/CDP shaping is not a reliable UDP impairment on Windows loopback.
        const simulated = new Map(report), severe = window.networkTestPhase === 'severe';
        for (const [id, row] of report) if (row.type === 'candidate-pair' && row.state === 'succeeded') simulated.set(id, { ...row, availableOutgoingBitrate: severe ? 60000 : 120000, currentRoundTripTime: .7 });
        const tick = Math.floor(performance.now() / 2000);
        simulated.set('simulated-receiver', { id: 'simulated-receiver', type: 'inbound-rtp', kind: 'video', packetsReceived: tick * 100, packetsLost: tick * (severe ? 30 : 12) });
        return simulated;
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.captureCount++; window.captureLog.push({ constraints: args[0], stack: new Error().stack }); return capture(...args); };
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const teacher = await context.newPage(), student = await context.newPage(), errors = [];
  for (const page of [teacher, student]) page.on('pageerror', error => errors.push(error.message));
  const room = `weak-${Date.now()}`;
  await teacher.goto(`${base}/video-test?room=${room}&role=teacher`);
  await student.goto(`${base}/video-test?room=${room}&role=student`);
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, null, { timeout: 30000 });
    await page.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  }
  const snapshot = page => page.evaluate(async () => {
    const pc = window.testConnections.find(pc => pc.connectionState === 'connected' && pc.getSenders().some(sender => sender.track?.kind === 'audio'));
    if (!pc) throw new Error('No connected media transport');
    const stats = [...(await pc.getStats()).values()];
    const incoming = stats.find(row => row.type === 'inbound-rtp' && row.kind === 'audio');
    const audio = pc.getSenders().find(sender => sender.track?.kind === 'audio');
    const video = pc.getSenders().find(sender => sender.track?.kind === 'video');
    return { incoming: incoming?.packetsReceived || 0, samples: incoming?.totalSamplesReceived || 0, concealed: incoming?.concealedSamples || 0, lost: stats.filter(row => row.type === 'inbound-rtp').reduce((sum, row) => sum + Math.max(0, row.packetsLost || 0), 0), network: stats.filter(row => row.type === 'candidate-pair' && row.state === 'succeeded').map(row => ({ bandwidth: row.availableOutgoingBitrate, rtt: row.currentRoundTripTime })), audio: audio?.getParameters().encodings[0], video: video?.getParameters().encodings[0], capture: window.captureLog.filter(entry => entry.constraints.audio).length, mediaConnections: window.testConnections.filter(pc => pc.getSenders().some(sender => sender.track?.kind === 'audio')).length, live: audio?.track?.readyState, sdp: pc.localDescription.sdp };
  });
  await teacher.waitForTimeout(2500);
  const before = await Promise.all([snapshot(teacher), snapshot(student)]);
  for (const state of before) { assert.equal(state.audio.maxBitrate, 32000); assert.match(state.sdp, /useinbandfec=1/); assert.match(state.sdp, /usedtx=1/); }
  await student.evaluate(() => { window.networkTestPhase = 'weak'; });
  for (const page of [teacher, student]) await page.waitForFunction(() => window.testConnections.some(pc => pc.getSenders().some(sender => sender.track?.kind === 'video' && sender.getParameters().encodings[0]?.maxBitrate <= 55000)), null, { timeout: 20000 });
  await student.evaluate(() => { window.networkTestPhase = 'severe'; });
  for (const page of [teacher, student]) await page.waitForFunction(() => window.testConnections.some(pc => pc.getSenders().some(sender => sender.track?.kind === 'video' && sender.getParameters().encodings[0]?.active === false)), null, { timeout: 20000 });
  await student.waitForTimeout(12000);
  const weak = await Promise.all([snapshot(teacher), snapshot(student)]);
  console.log('Real WebRTC under simulated congestion telemetry:', JSON.stringify(weak.map((state, index) => ({ receivedAudioPackets: state.incoming - before[index].incoming, decodedSamples: state.samples - before[index].samples, concealedSamples: state.concealed - before[index].concealed, videoCap: state.video.maxBitrate, videoSending: state.video.active, microphoneCaptures: state.capture }))));
  for (let index = 0; index < weak.length; index++) {
    assert.ok(weak[index].incoming > before[index].incoming + 30, `audio must continue in direction ${index}`);
    assert.ok(weak[index].samples > before[index].samples, `audio decoding continues in direction ${index}`);
    assert.equal(weak[index].live, 'live'); assert.equal(weak[index].capture, before[index].capture);
    assert.equal(weak[index].mediaConnections, before[index].mediaConnections, 'do not reconnect just to change quality');
  }
  await student.evaluate(() => { window.networkTestPhase = 'normal'; });
  for (const page of [teacher, student]) {
    // Resume at least the 12fps profile; do not force full quality when the
    // browser still reports a <350kbps available budget on this test machine.
    // Full-quality recovery with a known healthy budget is covered by unit tests.
    try { await page.waitForFunction(() => window.testConnections.some(pc => pc.getSenders().some(sender => sender.track?.kind === 'video' && sender.getParameters().encodings[0]?.maxBitrate >= 140000 && sender.getParameters().encodings[0].active)), null, { timeout: 65000 }); }
    catch (error) { const state = await snapshot(page); console.log('Recovery diagnostic', { video: state.video, network: state.network, live: state.live }); throw error; }
  }
  const restored = await Promise.all([snapshot(teacher), snapshot(student)]);
  for (let index = 0; index < restored.length; index++) { assert.equal(restored[index].capture, before[index].capture); assert.equal(restored[index].mediaConnections, before[index].mediaConnections); }
  assert.deepEqual(errors, []);
  console.log('Congestion telemetry on one peer reduced BOTH senders; real audio kept decoding while video paused, then video recovered without microphone or connection restart.');
} finally {
  await browser.close();
  await new Promise(resolve => io.close(() => { httpServer.closeAllConnections(); httpServer.close(resolve); }));
}
