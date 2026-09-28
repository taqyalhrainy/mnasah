import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();

try {
  const suffix = Date.now();
  await page.goto('http://127.0.0.1:8787/students');
  await page.locator('.auth-form .text-button').click();
  await page.locator('input[name="name"]').fill('Student Smoke Check');
  await page.locator('input[name="email"]').fill(`student-smoke-${suffix}@local.test`);
  await page.locator('input[name="password"]').fill('Smoke-password-12345');
  await page.locator('.auth-form .primary-button').click();
  await page.locator('.category-card').first().waitFor();
  assert.equal(await page.locator('.category-card').count(), 6);
  assert.equal(await page.locator('.notice.error').count(), 0);
  console.log('New student account loaded all six curriculum categories without API errors.');
} finally {
  await browser.close();
}
