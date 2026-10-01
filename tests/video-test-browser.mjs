import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
const teacher = await context.newPage();
const student = await context.newPage();
const errors = [];
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';
teacher.on('pageerror', error => errors.push(error.message));
student.on('pageerror', error => errors.push(error.message));

try {
  const room = `browser-check-${Date.now()}`;
  await teacher.goto(`${baseUrl}/video-test?room=${room}&role=teacher`);
  await student.goto(`${baseUrl}/video-test?room=${room}&role=student`);
  await teacher.locator('.video-test-page').waitFor();
  await student.locator('.video-test-page').waitFor();
  await teacher.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 20000 });
  await student.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 20000 });

  await teacher.getByTitle('المحادثة').click();
  await student.getByTitle('المحادثة').click();
  await teacher.getByLabel('رسالة جديدة').fill('أ');
  await student.locator('.call-typing-indicator').waitFor({ timeout: 10000 });
  assert.equal(await student.locator('.call-typing-indicator span').count(), 3);
  await student.locator('.call-typing-indicator').waitFor({ state: 'detached', timeout: 5000 });
  await teacher.getByTitle('المحادثة').click();
  await student.getByTitle('المحادثة').click();

  await teacher.locator('.call-toolbar .tool-button').nth(3).click();
  await teacher.locator('.whiteboard-canvas').waitFor();
  await student.locator('.whiteboard-canvas').waitFor();
  for (const page of [teacher, student]) {
    await page.evaluate(() => {
      window.videoStreamsBeforeDrawing = [...document.querySelectorAll('video')].map(video => video.srcObject);
    });
  }

  const board = await teacher.locator('.whiteboard-canvas').boundingBox();
  assert.ok(board);
  await teacher.mouse.move(board.x + 30, board.y + board.height / 2);
  await teacher.mouse.down();
  const teacherDrawing = teacher.mouse.move(board.x + board.width - 30, board.y + board.height / 2 + 40, { steps: 600 });
  await student.waitForFunction(() => (document.querySelector('.whiteboard-canvas path')?.getAttribute('d')?.includes('L') ?? false), undefined, { timeout: 10000 });
  await teacherDrawing;
  await teacher.mouse.up();
  await student.locator('.whiteboard-canvas path').waitFor();

  const studentBoard = await student.locator('.whiteboard-canvas').boundingBox();
  assert.ok(studentBoard);
  await student.mouse.move(studentBoard.x + 40, studentBoard.y + 80);
  await student.mouse.down();
  const studentDrawing = student.mouse.move(studentBoard.x + studentBoard.width - 40, studentBoard.y + 130, { steps: 600 });
  await teacher.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas path').length >= 2
    && (document.querySelectorAll('.whiteboard-canvas path')[1]?.getAttribute('d')?.includes('L') ?? false), undefined, { timeout: 10000 });
  await studentDrawing;
  await student.mouse.up();

  for (const page of [teacher, student]) {
    assert.equal(await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')];
      return videos.every((video, index) => video.srcObject === window.videoStreamsBeforeDrawing[index]
        && [...video.srcObject.getTracks()].every(track => track.readyState === 'live'));
    }), true, 'drawing must not detach or stop the camera and microphone streams');
  }

  async function leaveAndReturn(leaver, waitingParticipant) {
    await waitingParticipant.evaluate(() => { window.remoteStreamBeforeReturn = document.querySelectorAll('video')[0]?.srcObject; });
    await leaver.locator('.call-toolbar .danger').click();
    await leaver.locator('.session-controls .primary-button').click();
    await leaver.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 30000 });
    await waitingParticipant.waitForFunction(() => {
      const remote = document.querySelectorAll('video')[0]?.srcObject;
      return remote && remote !== window.remoteStreamBeforeReturn && [...remote.getTracks()].every(track => track.readyState === 'live');
    }, undefined, { timeout: 30000 });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) await leaveAndReturn(teacher, student);
  for (let attempt = 0; attempt < 3; attempt += 1) await leaveAndReturn(student, teacher);

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Direct video route, whiteboard stability, and repeated teacher/student leave-and-return checks passed.');
} finally {
  await browser.close();
}
