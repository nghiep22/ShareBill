import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, request } from 'playwright';
import { runSmoke, smokeConfig } from '../../scripts/smoke.mjs';

const web = 'http://localhost:3000';
const api = 'http://localhost:3001/api/v1/';
let http, browser;
let fixtureApp;

before(async () => {
  http = await request.newContext({ baseURL: api });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});

after(async () => {
  await browser?.close();
  await http?.dispose();
  if (fixtureApp) {
    const require = createRequire(new URL('../../be/package.json', import.meta.url));
    await require('firebase-admin/app').deleteApp(fixtureApp);
  }
});

async function call(path, session, { method = 'GET', body, version } = {}) {
  const response = await http.fetch(path, {
    method, data: body, headers: {
      ...(session ? { authorization: 'Bearer ' + session.accessToken } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
      ...(version === undefined ? {} : { 'if-match': '"' + version + '"' }),
    },
  });
  const result = await response.json();
  assert.ok(response.ok(), result.error?.code);
  return result.data;
}

async function fixture(t) {
  const session = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'An E2E',
  } });
  const trip = await call('trips', session, { method: 'POST', body: { name: 'Đà Lạt E2E', ownerName: 'An' } });
  const expenses = 'trips/' + trip.id + '/expenses';
  const screen = route => web + '/#chuyen/' + trip.id + '/' + route;
  const context = await browser.newContext();
  t.after(async () => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  });
  await context.addInitScript(session => {
    const key = 'sharebill-live-session-v1';
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(session));
  }, { ...session, expiresAt: Date.now() + session.expiresIn * 1000 });
  const page = await context.newPage();
  const create = (title, category) => call(expenses, session, { method: 'POST', body: {
    title, category, amountMinor: 240000, payerParticipantId: trip.ownerParticipantId, occurredOn: '2026-11-18',
    splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  return { page, context, session, trip, expenses, screen, create };
}

function heading(page, name) {
  return page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout: 10000 });
}

test('authentication has no demo entry point and PWA retires cached preview pages', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  if (process.env.SHAREBILL_PWA_TEST === '1') {
    await page.goto(web + '/release.json');
    await page.evaluate(async () => {
      const cache = await caches.open('sharebill-shell-removed-demo');
      await cache.put('/demo/', new Response('Legacy preview', { headers: { 'content-type': 'text/html' } }));
    });
  }
  await page.goto(web + '/#dang-nhap');
  await heading(page, 'Đăng nhập');
  assert.equal(await page.locator('a[href*="/demo"]').count(), 0);
  assert.equal(await page.getByText(/xem thử|bản mẫu|hồ sơ mẫu/i).count(), 0);
  let authSubmissions = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/auth\/(login|register)$/.test(new URL(request.url()).pathname)) authSubmissions++;
  });
  await page.getByLabel('Email', { exact: true }).fill('visibility-fixture@example.test');
  const password = page.getByLabel('Mật khẩu', { exact: true });
  await password.fill('Visibility-Fixture-123!');
  assert.equal(await password.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Hiện mật khẩu', exact: true }).click();
  assert.equal(await password.getAttribute('type'), 'text');
  assert.equal(await password.inputValue(), 'Visibility-Fixture-123!');
  const hide = page.getByRole('button', { name: 'Ẩn mật khẩu', exact: true });
  assert.equal(await hide.getAttribute('aria-pressed'), 'true');
  await hide.press('Enter');
  assert.equal(await password.getAttribute('type'), 'password');
  assert.equal(authSubmissions, 0);
  await heading(page, 'Đăng nhập');
  await page.getByRole('link', { name: 'Chưa có tài khoản? Đăng ký', exact: true }).click();
  await heading(page, 'Tạo tài khoản');
  assert.equal(await password.getAttribute('type'), 'password');
  assert.equal(await password.inputValue(), '');
  await page.getByLabel('Tên hiển thị').fill('Visibility Fixture');
  await page.getByLabel('Email', { exact: true }).fill('visibility-fixture@example.test');
  await password.fill('Registration-Fixture-123!');
  await page.getByRole('button', { name: 'Hiện mật khẩu', exact: true }).click();
  assert.equal(await password.getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Ẩn mật khẩu', exact: true }).click();
  assert.equal(await password.inputValue(), 'Registration-Fixture-123!');
  assert.equal(authSubmissions, 0);
  assert.equal(await page.getByRole('link', { name: 'Đăng nhập', exact: true }).count(), 1);
  assert.equal(await page.getByText(/xem thử|bản mẫu|hồ sơ mẫu/i).count(), 0);
  if (process.env.SHAREBILL_PWA_TEST === '1') {
    const cachedDemoPages = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      const requests = await Promise.all((await caches.keys()).map(async name => (await caches.open(name)).keys()));
      return requests.flat().filter(request => new URL(request.url).pathname.startsWith('/demo')).length;
    });
    assert.equal(cachedDemoPages, 0);
    await context.setOffline(true);
    await page.goto(web + '/demo/');
    await heading(page, 'Đăng nhập');
    assert.equal(new URL(page.url()).pathname, '/');
  }
});

test('S18 smoke validates the built web/API release and archives its isolated ledger fixture', { skip: process.env.SHAREBILL_PWA_TEST !== '1' }, async () => {
  assert.match(process.env.RELEASE_COMMIT ?? '', /^[a-f0-9]{40}$/i, 'Set RELEASE_COMMIT for the FE build, API runtime and browser suite');
  const email = randomUUID() + '@example.test';
  const password = 'SmokeFixture-' + randomUUID();
  await call('auth/register', null, { method: 'POST', body: { email, password, displayName: 'Release smoke fixture' } });
  const config = smokeConfig(['--api-url', 'http://localhost:3001', '--web-url', web, '--environment', 'local',
    '--project', 'demo-sharebill', '--commit', process.env.RELEASE_COMMIT, '--exercise']);
  const report = await runSmoke(config, { env: { SMOKE_EMAIL: email, SMOKE_PASSWORD: password } });
  if (process.env.SHAREBILL_SMOKE_REPORT) {
    await writeFile(process.env.SHAREBILL_SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  assert.equal(report.passed, true, JSON.stringify(report));
});

test('K01 keeps edits across refresh and applies only the explicitly retained changes', async t => {
  const { page, session, expenses, screen, create } = await fixture(t);
  const expense = await create('Khách sạn gốc', 'stay');
  const path = expenses + '/' + expense.id;
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  const title = page.getByLabel('Tên khoản chi');
  const save = page.getByRole('button', { name: /Lưu khoản chi/ });
  assert.equal(await title.inputValue(), 'Khách sạn gốc');
  await call(path, session, { method: 'PATCH', version: expense.version, body: { note: 'Ghi chú từ phiên khác' } });
  await title.fill('Tên tôi đang sửa');
  await save.click();
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  const conflict = page.getByRole('region', { name: 'Xung đột khoản chi' });
  await conflict.getByText('Ghi chú từ phiên khác', { exact: false }).waitFor();
  assert.equal(await title.inputValue(), 'Tên tôi đang sửa');
  assert.equal(await save.isDisabled(), true);
  assert.equal((await call(path, session)).title, 'Khách sạn gốc');
  await conflict.getByRole('button', { name: 'Áp lại phần tôi đã sửa' }).click();
  await save.click();
  await heading(page, 'Tên tôi đang sửa');
  const saved = await call(path, session);
  assert.equal(saved.title, 'Tên tôi đang sửa');
  assert.equal(saved.note, 'Ghi chú từ phiên khác');
});

test('K02 recovers a committed request after refresh and reuses its key on identical retry', async t => {
  const { context, page, session, expenses, screen } = await fixture(t);
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  const title = 'Nhập lại sau mất phản hồi';
  const keys = [];
  await context.route('**/api/v1/trips/*/expenses', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch();
    if (keys.length === 1) return route.abort();
    return route.fulfill({ response });
  });
  async function enter() {
    await page.getByLabel('Tên khoản chi').fill(title);
    await page.getByLabel('Số tiền đã trả').fill('135000');
    await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  }
  await enter();
  await page.getByText(/Kết nối với máy chủ bị gián đoạn/).waitFor();
  await page.reload();
  await heading(page, 'Thêm khoản chi');
  await page.getByText('1 thao tác chưa rõ kết quả', { exact: true }).click();
  await page.getByRole('button', { name: 'Kiểm tra kết quả' }).click();
  await page.getByRole('link', { name: 'Mở kết quả đã lưu' }).waitFor();
  await enter();
  await heading(page, title);
  assert.ok(keys[0]);
  assert.deepEqual(keys, [keys[0], keys[0]]);
  const saved = (await call(expenses, session)).items.filter(item => item.title === title);
  assert.equal(saved.length, 1);
});

test('K04 and K05 preserve filters after detail, reload and a fresh tab', async t => {
  const { page, context, screen, create } = await fixture(t);
  await create('Khách sạn', 'stay');
  await create('Bữa ăn', 'food');
  await page.goto(screen('chi-tieu'));
  await heading(page, 'Chi tiêu');
  await page.getByLabel('Danh mục').selectOption('food');
  await page.getByRole('link', { name: /Bữa ăn/ }).click();
  await heading(page, 'Bữa ăn');
  const detail = page.url();
  assert.match(detail, /\/khoan-chi\/.+category=food/);
  await page.getByRole('link', { name: 'Quay lại', exact: true }).click();
  await page.reload();
  await heading(page, 'Chi tiêu');
  await page.getByRole('link', { name: /Bữa ăn/ }).waitFor();
  assert.equal(await page.getByLabel('Danh mục').inputValue(), 'food');
  assert.equal(await page.getByRole('link', { name: /Khách sạn/ }).count(), 0);

  const blank = await context.newPage();
  await blank.goto(detail);
  await heading(blank, 'Bữa ăn');
  await blank.getByRole('link', { name: 'Quay lại', exact: true }).click();
  await heading(blank, 'Chi tiêu');
  assert.equal(await blank.getByLabel('Danh mục').inputValue(), 'food');
});

test('trusted devices recover an offline draft and clear private data on sign out', async t => {
  const { context, page, screen, expenses, session } = await fixture(t);
  await page.goto(web + '/#tai-khoan');
  await heading(page, 'Tài khoản');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Nháp riêng tư');
  await page.getByLabel('Số tiền đã trả').fill('105000');
  // Queue a database read after the input's write transaction, without arbitrary timeouts.
  await page.waitForFunction(async () => {
    const databases = await indexedDB.databases();
    const name = databases.find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return false;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data');
        const read = tx.objectStore('data').getAll();
        read.onsuccess = () => resolve(read.result.some(row => row.kind === 'expense-new' && row.value.amount === '105000'));
        tx.oncomplete = () => db.close();
      };
    });
  });
  if (process.env.SHAREBILL_PWA_TEST === '1') {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
  }
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  if (process.env.SHAREBILL_PWA_TEST === '1') {
    await page.reload();
    await heading(page, 'Thêm khoản chi');
  }
  await page.getByRole('button', { name: /Lưu khoản chi/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Lưu khoản chi/ }).isDisabled(), true);
  // Route away and return while the app shell remains available offline.
  await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
  await heading(page, 'Tài khoản');
  await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByRole('button', { name: 'Tiếp tục bản nháp' }).click();
  assert.equal(await page.getByLabel('Tên khoản chi').inputValue(), 'Nháp riêng tư');
  assert.equal(await page.getByLabel('Số tiền đã trả').inputValue(), '105000');
  assert.equal(await page.getByRole('button', { name: /Lưu khoản chi/ }).isDisabled(), true);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Lưu khoản chi'))?.disabled);
  assert.equal((await call(expenses, session)).items.length, 0);
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Nháp riêng tư');
  assert.equal((await call(expenses, session)).items.length, 1);
  await page.goto(web + '/#tai-khoan');
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await page.waitForFunction(async () => {
    const databases = await indexedDB.databases();
    const name = databases.find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return true;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data');
        const read = tx.objectStore('data').count();
        read.onsuccess = () => resolve(read.result === 0);
        tx.oncomplete = () => db.close();
      };
    });
  });
});

test('money screens keep equal shares, remaining debt, partial payments and reversals consistent', { timeout: 90000 }, async t => {
  const { page, session, trip, screen } = await fixture(t);
  const root = 'trips/' + trip.id;
  const peers = [];
  for (const displayName of ['Bình', 'Chi']) peers.push(await call(root + '/participants', session, { method: 'POST', body: { displayName } }));
  const overview = () => call(root + '/overview', session);
  const format = value => new Intl.NumberFormat('vi-VN').format(value) + 'đ';
  async function checkMember(name, id) {
    const snapshot = await overview(), row = snapshot.balances.find(row => row.participantId === id);
    const card = page.getByRole('region', { name: 'Số dư của ' + name, exact: true });
    await card.getByText(format(Math.abs(row.netMinor)), { exact: true }).first().waitFor();
    for (const [label, value] of [['Phải chịu', row.owedMinor], ['Đã ứng', row.paidMinor], ['Đã chuyển', row.sentMinor], ['Đã nhận', row.receivedMinor]]) {
      const cell = card.locator('dl > div').filter({ hasText: label });
      await cell.getByText(format(value), { exact: true }).waitFor();
    }
    assert.equal(await card.locator('dl').isVisible(), true);
    return row;
  }
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Khoản chia đều ba người');
  await page.getByLabel('Số tiền đã trả').fill('100.000');
  for (const name of ['An', 'Bình', 'Chi']) await page.getByLabel('Phần chia dự kiến của ' + name, { exact: true }).getByText('Phải chịu', { exact: true }).waitFor();
  await page.getByText(/chênh lệch tối đa 1đ/).waitFor();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản chia đều ba người');
  await heading(page, 'Mỗi người phải chịu');
  const expense = (await call(root + '/expenses', session)).items[0];
  assert.equal(expense.shares.reduce((sum, row) => sum + row.amountMinor, 0), 100000);
  assert.ok(Math.max(...expense.shares.map(row => row.amountMinor)) - Math.min(...expense.shares.map(row => row.amountMinor)) <= 1);
  for (const [name, id] of [['An', trip.ownerParticipantId], ['Bình', peers[0].id], ['Chi', peers[1].id]]) {
    const row = page.getByLabel('Phần phải chịu của ' + name, { exact: true });
    await row.getByText(format(expense.shares.find(row => row.participantId === id).amountMinor), { exact: true }).waitFor();
  }
  await page.goto(screen('so-du'));
  const debt = await checkMember('Bình', peers[0].id);
  await checkMember('An', trip.ownerParticipantId);
  await checkMember('Chi', peers[1].id);
  async function recordPartial(checkInvalid = false) {
    await page.getByRole('button', { name: 'Ghi khoản chuyển khác', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Người chuyển', { exact: true }).selectOption(peers[0].id);
    await dialog.getByLabel('Người nhận', { exact: true }).selectOption(trip.ownerParticipantId);
    const amount = dialog.getByLabel('Số tiền đã chuyển (VND)', { exact: true });
    if (checkInvalid) {
      await amount.fill('1e3');
      await dialog.getByRole('button', { name: 'Ghi nhận', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 0);
      await amount.fill(String(-debt.netMinor + 1));
      await dialog.getByRole('button', { name: 'Ghi nhận', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 0);
    }
    await amount.fill('10.000');
    await dialog.getByRole('button', { name: 'Ghi nhận', exact: true }).click();
    await heading(page, 'Lịch sử chuyển tiền');
    await page.getByRole('button', { name: 'Xác nhận thay', exact: true }).waitFor();
    const pending = (await call(root + '/settlements?status=pending', session)).items[0];
    assert.equal(pending.amountMinor, 10000);
  }
  await recordPartial(true);
  assert.equal((await overview()).balances.find(row => row.participantId === peers[0].id).netMinor, debt.netMinor);
  await page.getByRole('button', { name: 'Xác nhận thay', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy hiệu lực', exact: true }).waitFor();
  await page.goto(screen('so-du'));
  const afterPayment = await checkMember('Bình', peers[0].id);
  assert.equal(afterPayment.owedMinor, debt.owedMinor);
  assert.equal(afterPayment.netMinor, debt.netMinor + 10000);
  await page.goto(screen('quyet-toan') + '?status=confirmed');
  await page.getByRole('button', { name: 'Hủy hiệu lực', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Lý do', { exact: true }).fill('Đảo khoản chuyển nhập nhầm');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Lý do: Đảo khoản chuyển nhập nhầm', { exact: true }).waitFor();
  await page.goto(screen('so-du'));
  assert.equal((await checkMember('Bình', peers[0].id)).netMinor, debt.netMinor);
  await recordPartial();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Đã hủy', { exact: true }).last().waitFor();
  assert.equal((await overview()).balances.find(row => row.participantId === peers[0].id).netMinor, debt.netMinor);
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByLabel('Số tiền đã trả').fill('120.000');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản chia đều ba người');
  await page.goto(screen('so-du'));
  assert.equal((await checkMember('Bình', peers[0].id)).owedMinor, 40000);
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByRole('button', { name: 'Nhập từng phần', exact: true }).click();
  await page.getByLabel('Phần chia dự kiến của An', { exact: true }).getByRole('checkbox').uncheck();
  await page.getByLabel('Phần chia của Bình', { exact: true }).fill('0');
  await page.getByLabel('Phần chia của Chi', { exact: true }).fill('120.000');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản chia đều ba người');
  const exact = await call(root + '/expenses/' + expense.id, session);
  assert.equal(exact.payerParticipantId, trip.ownerParticipantId);
  assert.equal(exact.shares.some(row => row.participantId === trip.ownerParticipantId), false);
  await page.goto(screen('so-du'));
  assert.equal((await checkMember('Bình', peers[0].id)).owedMinor, 0);
  assert.equal((await checkMember('Chi', peers[1].id)).owedMinor, 120000);
  await page.goto(screen('khoan-chi/' + expense.id));
  await page.getByRole('button', { name: 'Hủy khoản chi', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Lý do hủy').fill('Không còn dùng khoản chi thử nghiệm');
  await dialog.getByRole('button', { name: 'Xác nhận hủy', exact: true }).click();
  await page.getByText(/Khoản chi đã hủy. Các phần chia/).waitFor();
  await page.goto(screen('so-du'));
  assert.equal((await checkMember('Bình', peers[0].id)).netMinor, 0);
  assert.equal((await checkMember('An', trip.ownerParticipantId)).paidMinor, 0);
  await page.getByText('Mọi người đã cân bằng.', { exact: true }).waitFor();
  await page.goto(screen('cai-dat'));
  await page.getByRole('button', { name: 'Chốt chuyến đi', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await heading(page, 'Chuyến đi đã chốt');
  assert.equal((await overview()).trip.status, 'archived');
});

test('incomplete financial snapshots never show a zero debt or enable archive', async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  await call('trips/' + trip.id + '/participants', session, { method: 'POST', body: { displayName: 'Bình' } });
  await context.route('**/api/v1/trips/*/overview', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.balances.pop();
    await route.fulfill({ response, json: body });
  });
  await page.goto(screen('so-du'));
  await page.getByText(/Chưa đủ dữ liệu số dư để kết luận/).waitFor();
  assert.equal(await page.getByText('Mọi người đã cân bằng.', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ghi khoản chuyển khác', exact: true }).count(), 0);
  await page.goto(screen('tong-quan'));
  await page.getByText('Chưa đủ dữ liệu', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('Các thành viên đã cân bằng.', { exact: true }).count(), 0);
  await page.goto(screen('cai-dat'));
  assert.equal(await page.getByRole('button', { name: 'Chốt chuyến đi', exact: true }).count(), 0);
  await page.goto(screen('thanh-vien'));
  await heading(page, 'Thành viên & phân quyền');
  assert.equal(await page.getByText('NaNđ', { exact: false }).count(), 0);
});

test('two accounts record an expense, confirm repayment and archive a balanced trip', async t => {
  const { page, context: ownerContext, session, trip, screen } = await fixture(t);
  const root = 'trips/' + trip.id;
  const participant = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'Bình' } });
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Bình E2E',
  } });
  const invitation = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invitation.token } });
  await call(root + '/memberships/' + member.user.uid + '/link', session, {
    method: 'POST', version: 1, body: { participantId: participant.id, reason: 'Liên kết người chia tiền' },
  });
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Khoản chi để quyết toán');
  await page.getByLabel('Số tiền đã trả').fill('240000');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản chi để quyết toán');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  await context.addInitScript(session => {
    sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session));
  }, { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const memberPage = await context.newPage();
  await memberPage.goto(screen('so-du'));
  await heading(memberPage, 'Số dư & quyết toán');
  await memberPage.getByRole('button', { name: 'Ghi nhận đã chuyển', exact: true }).click();
  await memberPage.getByRole('dialog').getByRole('button', { name: 'Ghi nhận', exact: true }).click();
  await heading(memberPage, 'Lịch sử chuyển tiền');
  await memberPage.getByText('Chờ xác nhận', { exact: true }).last().waitFor();
  const pending = await call(root + '/overview', session);
  assert.equal(pending.balances.find(row => row.participantId === participant.id).netMinor, -120000);

  await page.goto(screen('quyet-toan'));
  await page.getByRole('button', { name: 'Tôi đã nhận tiền', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('An xác nhận đã nhận', { exact: false }).waitFor();
  const confirmed = await call(root + '/overview', session);
  assert.ok(confirmed.balances.every(row => row.netMinor === 0));
  await page.goto(screen('cai-dat'));
  await page.getByRole('button', { name: 'Chốt chuyến đi', exact: true }).click();
  await ownerContext.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const offlineDialog = page.getByRole('dialog');
  await offlineDialog.getByText('Cần kết nối mạng để gửi thao tác. Bạn có thể đóng cửa sổ này.', { exact: true }).waitFor();
  assert.equal(await offlineDialog.locator('.dialog-content').evaluate(element => element.inert), true);
  await offlineDialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  const refreshed = page.waitForResponse(response => response.url().endsWith(root + '/overview') && response.ok());
  await ownerContext.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await refreshed;
  await page.getByRole('button', { name: 'Chốt chuyến đi', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByRole('heading', { name: 'Chuyến đi đã chốt', exact: true }).waitFor();
  assert.equal((await call(root + '/overview', session)).trip.status, 'archived');
  await memberPage.goto(screen('them-khoan-chi'));
  await heading(memberPage, 'Khoản chi chỉ có thể xem');
});

test('a Google operator processes a user ticket through the admin screens', async t => {
  const { page, context, session } = await fixture(t);
  const ticket = await call('support-tickets', session, { method: 'POST', body: {
    category: 'usability', message: 'Cần giúp kiểm tra thao tác thêm khoản chi',
  } });
  const email = randomUUID() + '@example.test';
  const response = await http.post('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo', { data: {
    requestUri: web, returnSecureToken: true, postBody: new URLSearchParams({
      providerId: 'google.com', id_token: JSON.stringify({ sub: randomUUID(), email, email_verified: true, name: 'Operator E2E' }),
    }).toString(),
  } });
  const operator = await response.json();
  assert.equal(response.status(), 200);
  await call('me/bootstrap', { accessToken: operator.idToken }, { method: 'POST', body: {} });
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  const require = createRequire(new URL('../../be/package.json', import.meta.url));
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  fixtureApp ??= initializeApp({ projectId: 'demo-sharebill' }, 'browser-fixtures');
  await getFirestore(fixtureApp).doc('platformAdmins/' + operator.localId).set({
    uid: operator.localId, role: 'platform_admin', status: 'active', version: 1, grantedBy: 'e2e-fixture', grantedAt: Timestamp.now(),
  });
  const admin = await context.newPage();
  const errors = [];
  admin.on('pageerror', error => errors.push(error.message));
  admin.on('response', async response => {
    if (response.url().includes('/api/admin/v1/') && !response.ok()) {
      errors.push(response.status() + ' ' + response.url() + ' ' + await response.text());
    }
  });
  await admin.goto(web + '/admin/');
  const popupPromise = admin.waitForEvent('popup');
  await admin.getByRole('button', { name: 'Đăng nhập với Google' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('load');
  await popup.getByText('Sign-in with Google.com', { exact: true }).waitFor();
  await popup.getByText(email, { exact: true }).click();
  try { await heading(admin, 'Tổng quan'); }
  catch (cause) { throw new Error(await admin.locator('main').innerText() + '\n' + errors.join('\n'), { cause }); }
  await admin.getByRole('link', { name: 'Báo lỗi', exact: true }).click();
  await admin.getByRole('link').filter({ hasText: ticket.id }).click();
  await heading(admin, 'Chi tiết báo lỗi');
  await admin.getByRole('button', { name: 'Đang xử lý', exact: true }).click();
  let dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Lý do').fill('Đang kiểm tra thao tác trong chuyến');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await admin.getByRole('button', { name: 'Thêm ghi chú nội bộ', exact: true }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Ghi chú nội bộ', { exact: true }).fill('Nội dung chỉ dành cho operator E2E');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await admin.getByText('Nội dung chỉ dành cho operator E2E', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Đã xử lý', exact: true }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Lý do').fill('Đã kiểm tra xong cách nhập khoản chi');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await admin.getByText('Thao tác · Đã xử lý', { exact: true }).waitFor();
  await page.goto(web + '/#tro-giup/' + ticket.id);
  await heading(page, 'Chi tiết báo lỗi');
  await page.getByText('Đã xử lý', { exact: true }).waitFor();
  assert.equal(await page.getByText('Nội dung chỉ dành cho operator E2E', { exact: true }).count(), 0);
  await admin.getByRole('link', { name: 'Nhật ký', exact: true }).click();
  await admin.getByRole('cell', { name: ticket.id, exact: false }).first().waitFor();
  const store = getFirestore(fixtureApp);
  const job = store.doc('maintenanceJobs/ledger-reconcile-' + randomUUID());
  await job.set({ kind: 'ledger_reconcile', status: 'failed', attempts: 1, lastErrorCode: 'RECONCILE_ISSUES_FOUND',
    resultSummary: { tripsScanned: 3, tripsChecked: 2, tripsWithIssues: 1, issueCount: 2, scanErrors: 1 },
    checkpoint: 'private-reconcile-checkpoint', privateDiff: 'private-reconcile-financial-values',
    updatedAt: Timestamp.now() });
  try {
    await admin.getByRole('link', { name: 'Hệ thống', exact: true }).click();
    await admin.getByText('Đối soát sổ tiền', { exact: false }).waitFor();
    await admin.getByText('Đã kiểm 2/3 chuyến · 1 chuyến cần kiểm tra · 2 sai lệch · 1 lỗi quét', { exact: true }).waitFor();
    assert.equal(await admin.getByText(/private-reconcile/).count(), 0);
  } finally { await job.delete(); }
  assert.deepEqual(errors, []);
});
