import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import { networkRelay } from './helpers/network-relay.mjs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const externalIce = process.env.CALL_LAB_ICE_FILE ? JSON.parse(await (await import('node:fs/promises')).readFile(process.env.CALL_LAB_ICE_FILE, 'utf8')) : null;
const relay = externalIce ? { iceServers: externalIce, impair() {}, metrics: () => ({}), close() {} } : await networkRelay();
const room = `udp-${Date.now()}`, start = Date.now() + 60000;
const users = [{ id: 'teacher', role: 'teachers', name: 'Teacher', status: 'active' }, { id: 'student', role: 'students', name: 'Student', status: 'active' }];
const database = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: Date.now() + 3600000 })), slots: [{ id: 'slot', teacher_id: 'teacher', start, minutes: 60, subject: 'رياضيات', price: 1000 }], bookings: [{ id: 'booking', slot_id: 'slot', teacher_id: 'teacher', student_id: 'student', status: 'confirmed', start, minutes: 60, subject: 'رياضيات', paid: 1, room }] });
const files = new Map();
const attachmentStore = { async write(id, name, source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); files.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([files.get(id)]), async remove(id) { files.delete(id); } };
const { httpServer, io } = await startPlatformServer({ database, attachmentStore, port: 55295 });
// Both simulated devices stay foreground-active; two backgrounded tabs in one
// Chrome instance are not representative of two people using separate phones.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  // Fake-media UI grants camera/mic. Explicit camera grants in this Chrome
  // build interfere with localhost relay permission; grant only the lab LAN.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['local-network-access'], serviceWorkers: 'block' });
  await context.addCookies(users.map(user => ({ name: `mansah_session_${user.role}`, value: user.id, url: 'http://127.0.0.1:55295' })));
  await context.addInitScript(() => {
    window.labConnections = []; window.labCaptures = 0; window.labCameraCaptures = 0; window.labTotals = new Map();
    const dataSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (...args) { if (!window.labDropData) return dataSend.apply(this, args); };
    setInterval(async () => {
      for (const pc of window.labConnections) {
        if (pc.connectionState === 'closed') continue;
        const report = await pc.getStats().catch(() => null); if (!report) continue;
        for (const row of report.values()) if (row.type === 'inbound-rtp') {
          const key = `${window.labConnections.indexOf(pc)}:${row.id}`, before = window.labTotals.get(key) || {};
          const next = { kind: row.kind };
          for (const field of ['packetsReceived', 'totalSamplesReceived', 'concealedSamples', 'framesDecoded']) next[field] = Math.max(before[field] || 0, row[field] || 0);
          window.labTotals.set(key, next);
        }
      }
    }, 1000);
    for (const method of ['createOffer', 'createAnswer']) {
      const native = RTCPeerConnection.prototype[method];
      RTCPeerConnection.prototype[method] = function (...args) { if (!window.labConnections.includes(this)) window.labConnections.push(this); return native.apply(this, args); };
    }
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    // Test networking with deterministic moving video, independent of Chrome's
    // flaky shared fake-camera driver on Windows. Native camera permission and
    // capture/reentry remain covered by classroom-mobile-browser.mjs.
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.audio) window.labCaptures++;
      const stream = constraints.audio ? await capture({ ...constraints, video: false }) : new MediaStream();
      if (constraints.video) {
        window.labCameraCaptures++;
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let frame = 0;
        const paint = () => { ctx.fillStyle = '#243c64'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#f3cf48'; ctx.beginPath(); ctx.arc(80 + frame++ % 480, 180, 40, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = '36px sans-serif'; ctx.fillText(String(frame), 30, 60); };
        paint(); const timer = setInterval(paint, 50), track = canvas.captureStream(20).getVideoTracks()[0], end = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); end(); }; stream.addTrack(track);
      }
      return stream;
    };
  });
  await context.route('**/api/*/video/ice', route => route.fulfill({ json: { ice_servers: relay.iceServers, relay_available: true, ice_transport_policy: 'relay' } }));
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const teacher = await context.newPage(), student = await context.newPage(), pages = [teacher, student], errors = [];
  for (const page of pages) {
    page.on('pageerror', error => { errors.push(error.message); console.log('Classroom browser error:', error.message); });
    page.on('requestfailed', req => { if (/127\.0\.0\.1/.test(req.url())) console.log('Classroom local request failed:', req.url().slice(0, 180), req.failure()?.errorText); });
  }
  await teacher.goto('http://127.0.0.1:55295/teachers?view=rooms', { waitUntil: 'domcontentloaded' });
  await student.goto('http://127.0.0.1:55295/students?view=rooms', { waitUntil: 'domcontentloaded' });
  for (const page of pages) await page.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
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
    const total = field => [...window.labTotals.values()].filter(row => row.kind === (field === 'framesDecoded' ? 'video' : 'audio')).reduce((sum, row) => sum + row[field], 0);
    const sender = pc.getSenders().find(sender => sender.track?.kind === 'video'), sent = stats.find(row => row.type === 'outbound-rtp' && row.kind === 'video');
    return { connected: true, transport: media.indexOf(pc), connections: media.length, candidate: report.get(pair?.localCandidateId)?.candidateType, packets: audio?.packetsReceived || 0, samples: audio?.totalSamplesReceived || 0, concealed: audio?.concealedSamples || 0, frames: video?.framesDecoded || 0, totalPackets: total('packetsReceived'), totalSamples: total('totalSamplesReceived'), totalConcealed: total('concealedSamples'), totalFrames: total('framesDecoded'), captures: window.labCaptures, video: sender?.getParameters().encodings[0], camera: { enabled: sender?.track?.enabled, ready: sender?.track?.readyState, framesEncoded: sent?.framesEncoded, captures: window.labCameraCaptures }, cameraUi: [...document.querySelectorAll('.participant-tile')].map(tile => ({ placeholder: !!tile.querySelector('.camera-placeholder'), paused: tile.querySelector('video')?.paused, time: tile.querySelector('video')?.currentTime })) };
  });
  await student.waitForTimeout(3000);
  const baseline = await Promise.all(pages.map(snapshot));
  console.log('App relay baseline:', JSON.stringify(baseline));
  assert.ok(baseline.every(state => state.connected && state.candidate === 'relay' && state.samples > 0 && state.frames > 0));
  await teacher.getByTitle('اللوح المشترك', { exact: true }).click();
  for (const page of pages) await page.locator('.whiteboard-canvas').waitFor();
  const draw = async (page, fraction) => {
    await page.locator('[data-whiteboard-tool=draw]').click();
    const box = await page.locator('.whiteboard-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * fraction); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * fraction + 30, { steps: 12 }); await page.mouse.up();
  };
  await draw(teacher, .3); await student.locator('.whiteboard-canvas path').first().waitFor();
  await draw(student, .6); await teacher.locator('.whiteboard-canvas path').nth(1).waitFor();
  relay.impair({ bytesPerSecond: 22000, loss: .03, latency: 45 });
  if (!externalIce) for (const page of pages) {
    const network = await context.newCDPSession(page);
    await network.send('Network.enable');
    // Model ongoing lesson transfers independently of cold application install
    // assets. WebRTC UDP loss/rate are controlled by the real relay above.
    await network.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: 'http://127.0.0.1:55295/api/*/bookings/*/files*', latency: 90, downloadThroughput: 22000, uploadThroughput: 22000 }] });
  }
  const picture = await teacher.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
    const ctx = canvas.getContext('2d'); let seed = 997;
    for (let y = 0; y < 450; y += 4) for (let x = 0; x < 800; x += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; ctx.fillStyle = `#${(seed & 0xffffff).toString(16).padStart(6, '0')}`; ctx.fillRect(x, y, 4, 4); }
    return canvas.toDataURL('image/jpeg', .75).split(',')[1];
  });
  await teacher.locator('.whiteboard-tools input[type=file]').setInputFiles({ name: 'lesson.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(picture, 'base64') });
  await student.locator('.whiteboard-board-image').waitFor({ timeout: 45000 });
  assert.match(await student.locator('.whiteboard-board-image').getAttribute('src'), /\/api\/students\/bookings\/booking\/files\//, 'board image bytes use private HTTP storage rather than the call data channel');
  const smallImage = await student.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24; canvas.getContext('2d').fillRect(0, 0, 24, 24); return canvas.toDataURL('image/png').split(',')[1]; });
  await student.locator('.whiteboard-tools input[type=file]').setInputFiles({ name: 'student.png', mimeType: 'image/png', buffer: Buffer.from(smallImage, 'base64') });
  await teacher.locator('.whiteboard-board-image').nth(1).waitFor({ timeout: 15000 });
  assert.match(await teacher.locator('.whiteboard-board-image').nth(1).getAttribute('src'), /\/api\/teachers\/bookings\/booking\/files\//);
  await teacher.locator('[data-whiteboard-tool=text]').click();
  const textBox = await teacher.locator('.whiteboard-canvas').boundingBox();
  await teacher.mouse.click(textBox.x + 40, textBox.y + 40);
  await teacher.locator('.whiteboard-text-editor').fill('الدرس مستمر');
  await teacher.locator('[data-whiteboard-tool=draw]').click();
  await student.locator('.whiteboard-text-content').filter({ hasText: 'الدرس مستمر' }).waitFor({ timeout: 15000 }).catch(async error => {
    console.log('Text synchronization diagnostic:', JSON.stringify(await Promise.all(pages.map(page => page.evaluate(() => ({ text: [...document.querySelectorAll('.whiteboard-text-content,.whiteboard-text-editor')].map(node => node.value || node.textContent), images: document.querySelectorAll('.whiteboard-board-image').length, status: document.querySelector('.call-status')?.textContent }))))));
    throw error;
  });
  const saving = student.waitForEvent('download'); await student.getByTitle('تنزيل اللوح', { exact: true }).click();
  const saved = await saving, png = await (await import('node:fs/promises')).readFile(await saved.path());
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10], 'student can export authenticated board images as PNG');
  // Stall only the RTC data channel while keeping real media flowing. Final
  // ink, PDF page changes and annotations must still arrive via the backup.
  for (const page of pages) await page.evaluate(() => { window.labDropData = true; });
  await draw(student, .8); await teacher.locator('.whiteboard-canvas path').nth(2).waitFor({ timeout: 15000 }).catch(async error => {
    console.log('Ink diagnostic:', JSON.stringify(await Promise.all(pages.map(page => page.evaluate(() => ({ paths: document.querySelectorAll('.whiteboard-canvas path').length, text: document.body.innerText.slice(-700) })))))); throw error;
  });
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.pdf', mimeType: 'application/pdf', buffer: pdfPages() });
  await student.locator('.document-page img').waitFor({ timeout: 30000 }).catch(async error => {
    console.log('Document diagnostic:', JSON.stringify({ errors, pages: await Promise.all(pages.map(page => page.evaluate(() => ({ text: document.body.innerText.slice(-1400), image: document.querySelector('.document-page img')?.getAttribute('src'), ready: document.querySelector('.document-page img')?.naturalWidth })))) }));
    throw error;
  });
  await teacher.getByTitle('الصفحة التالية', { exact: true }).click();
  await student.waitForFunction(() => document.querySelector('.document-page-picker button')?.textContent?.includes('2 / 3'), null, { timeout: 30000 });
  await teacher.getByTitle('قلم', { exact: true }).click();
  const sheet = await teacher.locator('.document-page-canvas').boundingBox();
  await teacher.mouse.move(sheet.x + sheet.width * .4, sheet.y + sheet.height * .4); await teacher.mouse.down();
  await teacher.mouse.move(sheet.x + sheet.width * .6, sheet.y + sheet.height * .5, { steps: 12 }); await teacher.mouse.up();
  await student.locator('.document-page svg path').waitFor({ timeout: 15000 });
  for (const page of pages) await page.evaluate(() => { window.labDropData = false; });
  console.log('Two-way board drawing, text, private image sharing, PDF pages and annotation passed, including a stalled RTC data channel.');
  await student.waitForTimeout(22000);
  const weak = await Promise.all(pages.map(snapshot));
  const directions = weak.map((state, index) => ({ audioPackets: state.totalPackets - baseline[index].totalPackets, samples: state.totalSamples - baseline[index].totalSamples, concealed: state.totalConcealed - baseline[index].totalConcealed, videoFrames: state.totalFrames - baseline[index].totalFrames, transport: state.transport, video: state.video }));
  console.log(externalIce ? 'App hosted relay media and collaboration:' : 'App actual UDP impairment (176kbps, 3% loss, extra 45ms plus queue):', JSON.stringify({ relay: relay.metrics(), directions, camera: weak.map(state => ({ source: state.camera, ui: state.cameraUi })) }));
  for (let index = 0; index < weak.length; index++) {
    assert.equal(weak[index].connected, true); assert.ok(directions[index].audioPackets > 150);
    assert.ok(directions[index].samples > 48000 * 8); assert.ok(directions[index].videoFrames > 3);
    assert.equal(weak[index].captures, baseline[index].captures);
  }
  if (!externalIce) {
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
  }
  for (const page of pages) {
    assert.match(await page.locator('.document-page-picker button').innerText(), /2 \/ 3/);
    assert.equal(await page.locator('.document-page svg path').count(), 1, 'annotations survive media repair');
  }
  // The teacher's mode change now reaches its peer immediately via the backup.
  // Verify both documents before either participant switches back to the board.
  for (const page of pages) {
    await page.getByTitle('اللوح المشترك', { exact: true }).click();
    assert.equal(await page.locator('.whiteboard-board-image').count(), 2, 'both participants board images survive media repair');
    assert.equal(await page.locator('.whiteboard-canvas path').count(), 3, 'both participants drawing survives media repair');
    assert.equal(await page.locator('.whiteboard-text-content').filter({ hasText: 'الدرس مستمر' }).count(), 1, 'shared text survives media repair');
  }
  assert.deepEqual(errors, []);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) console.log('Classroom failure state:', JSON.stringify({ url: page.url(), text: await page.locator('body').innerText().catch(() => ''), connections: await page.evaluate(() => (window.labConnections || []).map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState }))).catch(() => []) }));
  throw error;
} finally { await browser.close(); relay.close(); await new Promise(resolve => io.close(() => { httpServer.closeAllConnections(); httpServer.close(resolve); })); }

function pdfPages() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for (let page = 1; page <= 3; page++) {
    const content = `BT /F1 36 Tf 72 600 Td (Lesson page ${page}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${page * 2 + 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source, 'latin1')); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source, 'latin1'); source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source, 'latin1');
}
