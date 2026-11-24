import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const out = fileURLToPath(new URL('../out/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
let server, browser, origin, revision = 0;

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(out, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!path.startsWith(out.endsWith(sep) ? out : out + sep)) { response.writeHead(403).end(); return; }
      let body = await readFile(path);
      if (pathname === '/sw.js') body = Buffer.concat([body, Buffer.from('\n// Test release ' + revision)]);
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => sessionStorage.setItem('pwa-loads', String(Number(sessionStorage.getItem('pwa-loads') ?? 0) + 1)));
  const open = async () => {
    const page = await context.newPage();
    await page.goto(origin + '/#dang-nhap');
    await page.getByRole('heading', { name: 'Đăng nhập', exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    return page;
  };
  return { page: await open(), open };
}
async function release(page) {
  revision++;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
}
async function waiting(page) {
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  // Cover at least one automatic retry before asserting that a reload was deferred.
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pwa-loads')), '1');
}
async function reloaded(page) {
  await page.waitForFunction(() => sessionStorage.getItem('pwa-loads') === '2');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

test('a new worker reloads an idle page once without showing an update prompt', async t => {
  const { page } = await fixture(t);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pwa-loads')), '1', 'First installation does not reload');
  await release(page);
  await reloaded(page);
  await page.getByRole('heading', { name: 'Đăng nhập', exact: true }).waitFor();
  assert.equal(await page.getByText('Có phiên bản ShareBill mới.', { exact: false }).count(), 0);
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pwa-loads')), '2', 'No reload loop');
});

test('an update preserves entered text and applies automatically after leaving the form', async t => {
  const { page } = await fixture(t);
  await page.getByLabel('Email', { exact: true }).fill('keep-my-input@example.test');
  await page.getByRole('heading', { name: 'Đăng nhập', exact: true }).click();
  await release(page);
  await waiting(page);
  assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'keep-my-input@example.test');
  await page.getByRole('link', { name: 'Chưa có tài khoản? Đăng ký', exact: true }).click();
  await reloaded(page);
  await page.getByRole('heading', { name: 'Tạo tài khoản', exact: true }).waitFor();
});

test('an update waits for a saving operation and an open dialog to finish', async t => {
  const { page } = await fixture(t);
  await page.locator('.workspace').evaluate(node => node.dataset.pwaBusy = 'true');
  await release(page);
  await waiting(page);
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.textContent = 'Reviewing a payment';
    document.body.append(dialog);
    dialog.showModal();
    document.querySelector('.workspace').removeAttribute('data-pwa-busy');
  });
  await waiting(page);
  await page.evaluate(() => document.querySelector('dialog').remove());
  await reloaded(page);
});

test('an idle tab cannot activate an update while another tab has unsaved input', async t => {
  const { page, open } = await fixture(t);
  const editing = await open();
  await editing.getByLabel('Email', { exact: true }).fill('second-tab@example.test');
  await editing.getByRole('heading', { name: 'Đăng nhập', exact: true }).click();
  await page.bringToFront();
  await release(page);
  await waiting(page);
  assert.equal(await editing.getByLabel('Email', { exact: true }).inputValue(), 'second-tab@example.test');
  await editing.getByRole('link', { name: 'Chưa có tài khoản? Đăng ký', exact: true }).click();
  await editing.bringToFront();
  await reloaded(editing);
  await page.bringToFront();
  await reloaded(page);
});
