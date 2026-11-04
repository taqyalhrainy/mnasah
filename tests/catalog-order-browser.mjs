import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
await mkdir('.private/catalog-order', { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(theme => localStorage.setItem('mansah-theme', theme), theme);
    const catalog = {
      groups: ['الأردني', 'البريطاني', 'القرآن'].map((name, index) => ({ id: `g${index}`, name, description: '', icon: '📚' })),
      categories: [
        { id: 'stage-a', parentId: 'g0', name: 'الأساسي', description: '', icon: '📚', levels: ['الأول', 'الثاني'], subjects: ['رياضيات', 'علوم'], levelSubjects: { الأول: ['رياضيات', 'علوم'], الثاني: ['رياضيات', 'علوم'] } },
        { id: 'stage-b', parentId: 'g0', name: 'الثانوي', description: '', icon: '📚', levels: [], subjects: ['رياضيات', 'علوم'], levelSubjects: {} },
      ],
    };
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'owner', name: 'الأدمن', email: 'owner@test.com', role: 'admin', status: 'active', subject: '', bio: '' } } });
      if (path.endsWith('/catalog')) {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          if (body.action === 'reorder-groups') catalog.groups = body.ids.map(id => catalog.groups.find(row => row.id === id));
          if (body.action === 'reorder') catalog.categories = [...catalog.categories.filter(row => row.parentId !== body.parentId), ...body.ids.map(id => catalog.categories.find(row => row.id === id))];
          if (body.action === 'save') catalog.categories = catalog.categories.map(row => row.id === body.id ? { ...row, ...body } : row);
        }
        return route.fulfill({ json: catalog });
      }
      return route.fulfill({ json: { bookings: [], slots: [], events: [], users: [] } });
    });
    const cards = page.locator('.catalog-preview-card');
    const names = () => cards.locator(':scope > strong').allTextContents();
    const openCatalog = async () => {
      await page.goto(base + '/owner', { waitUntil: 'domcontentloaded' });
      await page.locator('.nav-list').getByRole('button', { name: 'التصنيفات والمواد', exact: true }).click();
      await cards.first().waitFor();
    };
    await openCatalog();
    await page.getByLabel('موضع بطاقة الأردني', { exact: true }).selectOption('2');
    await page.getByRole('status').filter({ hasText: 'تم حفظ ترتيب البطاقات.' }).waitFor();
    assert.deepEqual(await names(), ['البريطاني', 'القرآن', 'الأردني']);
    await openCatalog();
    assert.deepEqual(await names(), ['البريطاني', 'القرآن', 'الأردني'], 'order persists after navigation');
    await page.getByRole('button', { name: 'اسحب بطاقة الأردني', exact: true }).dragTo(cards.filter({ hasText: 'البريطاني' }));
    await page.waitForTimeout(200);
    assert.deepEqual(await names(), ['الأردني', 'البريطاني', 'القرآن']);
    await cards.filter({ hasText: 'الأردني' }).click();
    await page.getByRole('button', { name: 'تحريك الأساسي للأسفل', exact: true }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await names(), ['الثانوي', 'الأساسي']);
    await cards.filter({ hasText: 'الأساسي' }).click();
    await page.getByLabel('موضع بطاقة الأول', { exact: true }).selectOption('1');
    await page.waitForTimeout(100);
    assert.deepEqual(await names(), ['الثاني', 'الأول']);
    await cards.filter({ hasText: 'الثاني' }).click();
    await page.getByRole('button', { name: 'تحريك رياضيات للأسفل', exact: true }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await names(), ['علوم', 'رياضيات']);
    assert.deepEqual(catalog.categories.find(row => row.id === 'stage-a').levelSubjects.الأول, ['رياضيات', 'علوم'], 'other grades remain unchanged');
    await page.screenshot({ path: `.private/catalog-order/${theme}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel('موضع بطاقة علوم', { exact: true }).selectOption('1');
    await page.waitForTimeout(100);
    assert.deepEqual(await names(), ['رياضيات', 'علوم']);
    await page.screenshot({ path: `.private/catalog-order/${theme}-mobile.png`, fullPage: true });
    await context.close(); console.log(`${theme}: catalog drag, position, arrows and nested order passed`);
  }
} finally { await browser.close(); }
