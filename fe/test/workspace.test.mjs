import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, request } from 'playwright';
import { runSmoke, smokeConfig } from '../../scripts/smoke.mjs';

const web = process.env.SHAREBILL_TEST_WEB_URL ?? 'http://localhost:3000';
const apiOrigin = process.env.SHAREBILL_TEST_API_URL ?? 'http://localhost:3001';
const api = apiOrigin + '/api/v1/';
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

async function fixture(t, sharingMode = 'per-expense') {
  const session = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'An E2E',
  } });
  const trip = await call('trips', session, { method: 'POST', body: { name: 'Đà Lạt E2E', ...(sharingMode && { sharingMode }), ownerName: 'An' } });
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

async function privateRecords(page, rows) {
  return page.evaluate(async rows => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return [];
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data', rows ? 'readwrite' : 'readonly'), store = tx.objectStore('data');
        for (const row of rows ?? []) store.put(row);
        const read = store.getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, rows);
}

async function waitForPrivateRecord(page, kind = 'overview', amount) {
  await page.waitForFunction(async ({ kind, amount }) => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return false;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data'), read = tx.objectStore('data').getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result.some(row => row.kind === kind && (amount === undefined || row.value.amount === amount))); };
      };
    });
  }, { kind, amount });
}

test('responsive screens keep primary actions and navigation reachable while scrolling', async t => {
  const { page, trip, session, screen, create } = await fixture(t);
  await call('trips/' + trip.id, session, { method: 'PATCH', version: 1, body: { startDate: '2026-11-18', endDate: '2026-12-02' } });
  for (let index = 0; index < 12; index++) await create('Khoản chi ' + index, 'food');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(screen('chi-tieu'));
    await heading(page, 'Chi tiêu');
    await page.getByText('Khoản chi 11', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Expense overflow at ' + width);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const title = await page.locator('.page-title').boundingBox();
    const header = await page.locator('.app-header').boundingBox();
    assert.ok(Math.abs(title.y - header.y - header.height) < 2, 'Sticky title at ' + width);
    const add = page.getByRole('link', { name: 'Thêm khoản chi', exact: true });
    assert.ok((await add.boundingBox()).y >= header.height, 'Add action remains visible at ' + width);
    await add.click();
    await heading(page, 'Thêm khoản chi');
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    const payer = await page.getByRole('group', { name: 'Ai đã trả tiền?' }).boundingBox();
    const invoices = await page.getByRole('region', { name: 'Ảnh hóa đơn của khoản chi', exact: true }).boundingBox();
    assert.ok(payer.y < invoices.y, 'Payer comes before optional invoices');
    const save = await page.getByRole('button', { name: /Lưu khoản chi/ }).boundingBox();
    assert.ok(save.y > 0 && save.y + save.height <= 844, 'Save stays in viewport at ' + width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Form overflow at ' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, title] of [['tong-quan', 'Tổng quan'], ['so-du', 'Số dư & quyết toán'], ['thanh-vien', 'Thành viên & phân quyền'], ['quyet-toan', 'Lịch sử chuyển tiền']]) {
    await page.goto(screen(route));
    await heading(page, title);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Screen overflow: ' + route);
  }
  await page.goto(screen('thanh-vien'));
  await heading(page, 'Thành viên & phân quyền');
  const members = await page.getByRole('heading', { name: 'Danh sách thành viên' }).boundingBox();
  const qr = await page.getByRole('region', { name: 'QR nhận tiền của bạn', exact: true }).boundingBox();
  assert.ok(members.y < qr.y, 'Member list comes before QR settings');
  await page.goto(screen('chi-tieu'));
  await heading(page, 'Chi tiêu');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const more = page.getByRole('button', { name: 'Thêm mục điều hướng', exact: true });
  await more.click();
  const menu = page.getByRole('dialog', { name: 'Mục khác trong chuyến đi', exact: true });
  await menu.getByRole('link', { name: 'Lịch trình', exact: true }).click();
  await heading(page, 'Lịch trình chuyến đi');
  assert.equal(await menu.count(), 0);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  const dayStrip = page.locator('.itinerary-days');
  await dayStrip.getByRole('button').first().waitFor();
  assert.ok((await dayStrip.boundingBox()).height < 80, 'Long trips keep dates in one row');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await dayStrip.getByRole('button').last().click();
  assert.equal(await dayStrip.getByRole('button').last().getAttribute('aria-pressed'), 'true');
  await more.click();
  await menu.getByRole('link', { name: 'Cài đặt chuyến đi', exact: true }).click();
  await heading(page, 'Cài đặt chuyến đi');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await more.click();
  await page.goBack();
  await heading(page, 'Lịch trình chuyến đi');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Back closes the navigation dialog');
  await more.focus();
  await page.keyboard.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await more.focus();
  await page.keyboard.press('Enter');
  await menu.getByRole('link', { name: 'Tài khoản', exact: true }).click();
  await heading(page, 'Tài khoản');
  await menu.waitFor({ state: 'detached' });
  await page.goto(screen('loi-moi'));
  await heading(page, 'Mời bạn vào chuyến đi');
  assert.equal(await page.getByRole('navigation', { name: 'Điều hướng chính', exact: true }).getByRole('link', { name: 'Thành viên', exact: true }).getAttribute('aria-current'), 'page');

  const { trip: currentTrip } = await call('trips/' + trip.id + '/overview', session);
  const longName = 'Chuyến đi cùng gia đình và bạn bè '.repeat(3).slice(0, 100);
  await call('trips/' + trip.id, session, { method: 'PATCH', version: currentTrip.version, body: { name: longName } });
  for (const width of [320, 960, 1280]) {
    await page.setViewportSize({ width, height: 568 });
    await page.goto(screen('chi-tieu'));
    await page.getByText('Khoản chi 11', { exact: true }).waitFor();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const title = await page.locator('.page-title').boundingBox();
    const header = await page.locator('.app-header').boundingBox();
    assert.ok(Math.abs(title.y - header.y - header.height) < 2, 'Long trip names keep sticky actions clear at ' + width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('link', { name: 'Thêm khoản chi', exact: true }).click();
    await heading(page, 'Thêm khoản chi');
    const save = await page.getByRole('button', { name: /Lưu khoản chi/ }).boundingBox();
    assert.ok(save.y > 0 && save.y + save.height <= 568, 'Save remains reachable on short screens at ' + width);
  }
});

// Stub only image transport; QR attachment, settlement creation, permissions and balances use the real API/Firestore emulator.
async function paymentImageTransport(context, root, actor, qrPayload) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(apiOrigin).hostname));
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  const require = createRequire(new URL('../../be/package.json', import.meta.url));
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const sharp = require('sharp');
  fixtureApp ??= initializeApp({ projectId: 'demo-sharebill' }, 'browser-fixtures');
  const store = getFirestore(fixtureApp), tripId = root.split('/')[1];
  const qr = createRequire(new URL('../package.json', import.meta.url))('qrcode');
  // Also exercise decoding a QR inside a tall bank screenshot after JPEG normalization.
  const buffer = qrPayload ? await sharp({ create: { width: 600, height: 1300, channels: 3, background: '#e6f6f1' } })
    .composite([{ input: await qr.toBuffer(qrPayload, { width: 360, margin: 4 }), left: 120, top: 500 }]).jpeg({ quality: 82 }).toBuffer()
    : await sharp({ create: { width: 280, height: 280, channels: 3, background: '#e6f6f1' } }).png().toBuffer();
  const contentType = qrPayload ? 'image/jpeg' : 'image/png';
  const imageUrl = 'data:' + contentType + ';base64,' + buffer.toString('base64'), intents = new Map();
  await context.route('**/' + root + '/receipts/upload-intents', async route => {
    const key = route.request().headers()['idempotency-key'];
    if (!intents.has(key)) intents.set(key, randomUUID());
    const id = intents.get(key);
    await route.fulfill({ json: { data: { id, version: 1, expiresAt: new Date(Date.now() + 900000).toISOString(),
      upload: { url: 'https://payment-images.example.test/upload', fields: { key: id } } } } });
  });
  await context.route('https://payment-images.example.test/upload', route => route.fulfill({ status: 204 }));
  await context.route('**/' + root + '/receipts/*/finalize', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2), attempt = randomUUID(), now = Timestamp.now();
    await store.doc(root + '/receipts/' + id).set({ schemaVersion: 1, tripId, uploaderUid: actor.user.uid, status: 'ready',
      declaredContentType: contentType, maxBytes: 5242880, expiresAt: Timestamp.fromMillis(Date.now() + 900000),
      stagingPath: `receipt-staging/${tripId}/${actor.user.uid}/${id}/original`, stagingGeneration: '1',
      processedPath: `receipt-processed/${tripId}/${id}/${attempt}.jpg`, processedGeneration: '2',
      bytes: buffer.length, width: qrPayload ? 600 : 280, height: qrPayload ? 1300 : 280, attachedExpenseId: null, attachedSettlementId: null, attachedParticipantId: null,
      processingLeaseUntil: null, processingAttemptId: attempt, processingOperationKey: randomUUID(), processingRequestHash: 'a'.repeat(64),
      processingBaseVersion: 1, version: 3, createdAt: now, updatedAt: now, discardedAt: null, cleanupAfter: null, storageDeletedAt: null });
    await route.fulfill({ json: { data: { id, version: 3 } } });
  });
  await context.route('**/' + root + '/receipts/*/view-url', route => route.fulfill({ json: { data: { url: imageUrl } } }));
  return { name: qrPayload ? 'chuyen-khoan.jpg' : 'chuyen-khoan.png', mimeType: contentType, buffer };
}

test('itinerary day links survive reload and support undated trips, long ranges and invalid dates', async t => {
  const { page, session, trip, screen } = await fixture(t);
  await page.setViewportSize({ width: 320, height: 568 });
  const path = 'trips/' + trip.id + '/itinerary';
  const activity = (title, day) => ({ action: 'add-activity', title, day, time: '08:00', place: '', note: '' });
  await call(path, session, { method: 'POST', version: 1, body: activity('Hoạt động sau', '2026-12-03') });
  await call(path, session, { method: 'POST', version: 2, body: activity('Hoạt động trước', '2026-12-01') });
  await page.goto(screen('lich-trinh'));
  await page.getByRole('heading', { name: 'Hoạt động trước', exact: true }).waitFor();
  const picker = page.getByLabel('Ngày xem lịch trình', { exact: true });
  assert.equal(await picker.inputValue(), '2026-12-01', 'Undated trips start with the earliest activity');
  const earlier = await call(path, session, { method: 'POST', version: 3, body: activity('Ngày thêm từ máy khác', '2026-11-30') });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const earlierDay = page.locator('.itinerary-days').getByRole('button', { name: '30/11/2026', exact: true });
  await earlierDay.waitFor();
  assert.equal(await picker.inputValue(), '2026-12-01', 'A remote activity does not move the day being viewed');
  await call(path, session, { method: 'POST', version: 4, body: { action: 'remove-activity', id: earlier.id } });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await earlierDay.waitFor({ state: 'detached' });
  await picker.fill('2026-12-06');
  await page.waitForURL('**day=2026-12-06');
  assert.equal(await picker.evaluate(input => document.activeElement === input), true, 'Changing only the day keeps keyboard focus in the date input');
  await page.reload();
  await heading(page, 'Lịch trình chuyến đi');
  await picker.waitFor();
  assert.equal(await picker.inputValue(), '2026-12-06');
  await page.getByRole('button', { name: 'Thêm hoạt động', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Thêm hoạt động', exact: true });
  assert.equal(await form.getByLabel('Ngày', { exact: true }).inputValue(), '2026-12-06');
  await form.getByLabel('Hoạt động', { exact: true }).fill('Đi chơi ngày đã chọn');
  await form.getByLabel('Giờ', { exact: true }).fill('09:30');
  await form.getByRole('button', { name: 'Lưu hoạt động', exact: true }).click();
  await page.getByRole('heading', { name: 'Đi chơi ngày đã chọn', exact: true }).waitFor();
  const stored = await call(path, session);
  assert.equal(stored.activities.find(item => item.title === 'Đi chơi ngày đã chọn').day, '2026-12-06');
  await page.goto(screen('lich-trinh') + '?day=2026-02-31');
  await picker.waitFor();
  assert.equal(await picker.inputValue(), '2026-12-01', 'Invalid calendar dates fall back safely');
  await page.getByRole('heading', { name: 'Hoạt động trước', exact: true }).waitFor();
  await call('trips/' + trip.id, session, { method: 'PATCH', version: 1,
    body: { startDate: '2026-12-01', endDate: '2026-12-30' } });
  await page.goto(screen('lich-trinh') + '?day=2026-12-30');
  await page.reload();
  await picker.waitFor();
  assert.equal(await picker.inputValue(), '2026-12-30');
  assert.ok(await page.locator('.itinerary-days button').count() >= 14, 'Long trip dates are loaded');
  const box = await picker.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, 'The date picker stays reachable without horizontal scrolling');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await picker.fill('2026-12-03');
  await page.getByRole('heading', { name: 'Hoạt động sau', exact: true }).waitFor();
});

test('itinerary edits survive competing changes and deletion requires reviewing the latest activity', async t => {
  const { page, session, trip, screen } = await fixture(t);
  const path = 'trips/' + trip.id + '/itinerary';
  const fields = { title: 'Hoạt động ban đầu', day: '2026-12-01', time: '08:00', place: 'Đà Lạt', note: '' };
  const added = await call(path, session, { method: 'POST', version: 1, body: { action: 'add-activity', ...fields } });
  await page.goto(screen('lich-trinh'));
  await page.getByRole('button', { name: 'Sửa Hoạt động ban đầu', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Sửa hoạt động', exact: true });
  await editing.getByLabel('Hoạt động', { exact: true }).fill('Giữ bản đang nhập');
  await editing.getByLabel('Giờ', { exact: true }).fill('09:30');
  await call(path, session, { method: 'POST', version: 2, body: { action: 'add-activity', ...fields, title: 'Hoạt động từ máy khác' } });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await editing.getByRole('region', { name: 'Xung đột lịch trình', exact: true }).waitFor();
  assert.equal(await editing.getByLabel('Hoạt động', { exact: true }).inputValue(), 'Giữ bản đang nhập');
  assert.equal(await editing.getByLabel('Giờ', { exact: true }).inputValue(), '09:30');
  assert.equal(await editing.getByRole('button', { name: 'Lưu hoạt động', exact: true }).isDisabled(), true);
  await editing.getByRole('button', { name: 'Áp bản nhập lên lịch mới', exact: true }).click();
  await editing.getByRole('button', { name: 'Lưu hoạt động', exact: true }).click();
  await page.getByRole('heading', { name: 'Giữ bản đang nhập', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Xóa Giữ bản đang nhập', exact: true }).click();
  const removing = page.getByRole('dialog', { name: 'Xóa hoạt động?', exact: true });
  await call(path, session, { method: 'POST', version: 4,
    body: { action: 'edit-activity', id: added.id, ...fields, title: 'Tên vừa được đổi trên máy khác', time: '10:30' } });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await removing.getByRole('region', { name: 'Thay đổi trước khi xóa', exact: true }).waitFor();
  assert.equal(await removing.getByRole('button', { name: 'Xóa hoạt động', exact: true }).isDisabled(), true);
  await removing.getByText(/Tên vừa được đổi trên máy khác/).waitFor();
  await removing.getByRole('button', { name: 'Kiểm tra hoạt động mới nhất', exact: true }).click();
  await removing.getByText(/Tên vừa được đổi trên máy khác/).waitFor();
  await removing.getByRole('button', { name: 'Xóa hoạt động', exact: true }).click();
  await removing.waitFor({ state: 'detached' });
  const saved = await call(path, session);
  assert.equal(saved.activities.some(item => item.id === added.id), false);
  assert.equal(saved.activities.some(item => item.title === 'Hoạt động từ máy khác'), true);
  const other = saved.activities.find(item => item.title === 'Hoạt động từ máy khác');
  await page.getByRole('button', { name: 'Xóa Hoạt động từ máy khác', exact: true }).click();
  await call(path, session, { method: 'POST', version: saved.version, body: { action: 'remove-activity', id: other.id } });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await removing.getByText('Hoạt động này đã được gỡ khỏi lịch trình.', { exact: true }).waitFor();
  assert.equal(await removing.getByRole('button', { name: 'Xóa hoạt động', exact: true }).isDisabled(), true);
});

test('itinerary keeps the schedule visible but locks writes while refreshing or retrying an error', async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  const path = 'trips/' + trip.id + '/itinerary';
  await call(path, session, { method: 'POST', version: 1,
    body: { action: 'add-activity', title: 'Lịch trình đã tải', day: '2026-12-01', time: '08:00', place: '', note: '' } });
  await page.goto(screen('lich-trinh'));
  await page.getByRole('heading', { name: 'Lịch trình đã tải', exact: true }).waitFor();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let writes = 0;
  await context.route('**/api/v1/' + path, async route => {
    if (route.request().method() !== 'GET') { writes++; await route.continue(); return; }
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEMPORARY_FAILURE', message: 'Chưa tải lại được lịch trình.' } }) });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('status').filter({ hasText: 'Đang cập nhật lịch trình…' }).waitFor();
  const add = page.getByRole('button', { name: 'Thêm hoạt động', exact: true });
  assert.equal(await add.isDisabled(), true);
  assert.equal(await page.getByRole('heading', { name: 'Lịch trình đã tải', exact: true }).isVisible(), true);
  release();
  await page.getByRole('alert').filter({ hasText: 'Chưa tải lại được lịch trình.' }).waitFor();
  assert.equal(await add.isDisabled(), true);
  const edit = page.getByRole('button', { name: 'Sửa Lịch trình đã tải', exact: true });
  assert.equal(await edit.isDisabled(), true);
  await add.evaluate(button => button.click());
  assert.equal(writes, 0);
  await context.unroute('**/api/v1/' + path);
  await page.getByRole('button', { name: 'Tải lại', exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('.page-title button')?.disabled);
  assert.equal(await add.isEnabled(), true);
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Sửa hoạt động', exact: true });
  await dialog.waitFor();
  await dialog.getByLabel('Hoạt động', { exact: true }).fill('Giữ khi tải lại lỗi');
  await context.route('**/api/v1/' + path, route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'TEMPORARY_FAILURE', message: 'Chưa tải lại được lịch trình.' } }) }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await dialog.getByRole('alert').filter({ hasText: 'Chưa tải lại được lịch trình.' }).waitFor();
  assert.equal(await dialog.getByLabel('Hoạt động', { exact: true }).inputValue(), 'Giữ khi tải lại lỗi');
  assert.equal(await dialog.getByRole('button', { name: 'Lưu hoạt động', exact: true }).isDisabled(), true);
});

test('password recovery sends one request, keeps account identity and prevents duplicate login submissions', async t => {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(apiOrigin).hostname), 'Password recovery integration requires the local Auth Emulator');
  const email = randomUUID() + '@example.test';
  const password = 'Recovery-Fixture-123!';
  const nextPassword = 'Recovered-Fixture-456!';
  const session = await call('auth/register', null, { method: 'POST', body: { email, password, displayName: 'Recovery fixture' } });
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(web + '/#dang-nhap');
  await page.getByRole('link', { name: 'Quên mật khẩu?', exact: true }).click();
  await heading(page, 'Quên mật khẩu');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  let requests = 0, releaseReset, resetStarted;
  const resetGate = new Promise(resolve => { releaseReset = resolve; });
  const resetRequest = new Promise(resolve => { resetStarted = resolve; });
  await context.route('**/api/v1/auth/password-reset', async route => {
    requests++; resetStarted(); await resetGate; await route.continue();
  });
  await page.getByLabel('Email đăng ký', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Gửi hướng dẫn', exact: true }).click();
  await resetRequest;
  assert.equal(await page.getByLabel('Email đăng ký', { exact: true }).isDisabled(), true);
  const sending = page.getByRole('button', { name: 'Đang gửi yêu cầu…', exact: true });
  assert.equal(await sending.isDisabled(), true);
  await sending.evaluate(button => button.click());
  assert.equal(requests, 1);
  releaseReset();
  await page.getByRole('status').filter({ hasText: 'Nếu email này đã được đăng ký' }).waitFor();
  assert.equal(requests, 1);

  const response = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-sharebill/oobCodes');
  const { oobCodes } = await response.json();
  const code = oobCodes.find(item => item.email === email && item.requestType === 'PASSWORD_RESET');
  assert.ok(code);
  const changed = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: code.oobCode, newPassword: nextPassword }),
  });
  assert.equal(changed.status, 200);
  await page.getByRole('link', { name: 'Về đăng nhập', exact: true }).click();
  await heading(page, 'Đăng nhập');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(nextPassword);
  let releaseLogin, loginStarted, logins = 0;
  const loginGate = new Promise(resolve => { releaseLogin = resolve; });
  const loginRequest = new Promise(resolve => { loginStarted = resolve; });
  await context.route('**/api/v1/auth/login', async route => {
    logins++; loginStarted(); await loginGate; await route.continue();
  });
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await loginRequest;
  assert.equal(await page.getByLabel('Mật khẩu', { exact: true }).isDisabled(), true);
  const loggingIn = page.getByRole('button', { name: 'Đang đăng nhập…', exact: true });
  assert.equal(await loggingIn.isDisabled(), true);
  await loggingIn.evaluate(button => button.click());
  releaseLogin();
  await heading(page, 'Chuyến đi của tôi');
  assert.equal(logins, 1);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('sharebill-live-session-v1')).user.uid), session.user.uid);
});

test('a temporary refresh outage keeps the session and recovers when the user retries', async t => {
  const { page, context, session, screen } = await fixture(t);
  await page.goto(screen('tong-quan'));
  await heading(page, 'Tổng quan');
  await context.route('**/api/v1/auth/refresh', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'AUTH_UNAVAILABLE', message: 'Không thể kết nối dịch vụ đăng nhập.' } }) }));
  await page.evaluate(() => {
    const key = 'sharebill-live-session-v1';
    const saved = JSON.parse(sessionStorage.getItem(key));
    sessionStorage.setItem(key, JSON.stringify({ ...saved, expiresAt: 0 }));
  });
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Không thể kết nối dịch vụ đăng nhập.' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Đăng nhập', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('sharebill-live-session-v1')).user.uid), session.user.uid);
  await context.unroute('**/api/v1/auth/refresh');
  await page.getByRole('button', { name: 'Tải lại', exact: true }).first().click();
  await heading(page, 'Tổng quan');
  await page.getByRole('heading', { name: 'Đà Lạt E2E', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('sharebill-live-session-v1')).expiresAt > Date.now()));
});

test('switching accounts ignores an old overview and never upgrades the old trip using the new login', async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  const other = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Other account',
  } });
  const ownTrip = await call('trips', other, { method: 'POST', body: { name: 'Chuyến của tài khoản mới', ownerName: 'Other' } });
  const oldOverview = await call('trips/' + trip.id + '/overview', session);
  delete oldOverview.trip.sharingMode;
  let release, started, delivered;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  const completed = new Promise(resolve => { delivered = resolve; });
  let unwantedUpgrades = 0;
  await context.route('**/api/v1/trips/' + trip.id + '/share-equally', async route => {
    unwantedUpgrades++;
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN' } }) });
  });
  await context.route('**/api/v1/trips/' + trip.id + '/overview', async route => {
    started();
    await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: oldOverview }) });
    delivered();
  });
  t.after(() => release());
  await page.goto(screen('tong-quan'));
  await requested;
  await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
  await heading(page, 'Tài khoản');
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await heading(page, 'Đăng nhập');
  await page.getByLabel('Email', { exact: true }).fill(other.user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('BrowserFixture-123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await heading(page, 'Chuyến đi của tôi');
  await page.getByRole('button').filter({ hasText: 'Chuyến của tài khoản mới' }).click();
  await heading(page, 'Tổng quan');
  await page.getByRole('heading', { name: 'Chuyến của tài khoản mới', exact: true }).waitFor();
  const oldReply = page.waitForResponse(response => response.url().endsWith('/trips/' + trip.id + '/overview'));
  release();
  await Promise.all([completed, oldReply.then(response => response.finished())]);
  // A second UI turn lets callbacks from the delivered reply finish without a timed sleep.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(unwantedUpgrades, 0);
  assert.equal(await page.getByRole('heading', { name: 'Đà Lạt E2E', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('sharebill-live-session-v1')).user.uid), other.user.uid);
  assert.equal((await call('trips/' + ownTrip.id + '/overview', other)).trip.totalExpenseMinor, 0);
});

test('blocked browser storage still allows login and retries an uncertain expense without duplication', async t => {
  const email = randomUUID() + '@example.test';
  const account = await call('auth/register', null, { method: 'POST', body: {
    email, password: 'BrowserFixture-123!', displayName: 'Storage fixture',
  } });
  const trip = await call('trips', account, { method: 'POST', body: { name: 'Thiết bị chặn lưu trữ', ownerName: 'Storage' } });
  const context = await browser.newContext();
  t.after(async () => { await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); });
  await context.addInitScript(() => {
    for (const name of ['sessionStorage', 'localStorage']) Object.defineProperty(window, name, {
      configurable: true, get: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(web + '/#dang-nhap');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('BrowserFixture-123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await heading(page, 'Chuyến đi của tôi');
  await page.getByRole('button').filter({ hasText: 'Thiết bị chặn lưu trữ' }).click();
  await heading(page, 'Tổng quan');
  await page.evaluate(id => { window.location.hash = 'chuyen/' + id + '/them-khoan-chi'; }, trip.id);
  await heading(page, 'Thêm khoản chi');
  const keys = [];
  await context.route('**/api/v1/trips/' + trip.id + '/expenses', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch();
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.getByLabel('Tên khoản chi', { exact: true }).fill('Khoản chi cần giữ khóa');
  await page.getByLabel('Số tiền đã trả', { exact: true }).fill('123000');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await page.getByRole('alert').filter({ hasText: 'Kết nối với máy chủ bị gián đoạn' }).waitFor();
  await page.getByText('Tab này chỉ theo dõi thao tác trong bộ nhớ. Hãy giữ tab mở khi đang chờ kết quả.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản chi cần giữ khóa');
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  const expenses = await call('trips/' + trip.id + '/expenses', account);
  assert.equal(expenses.items.filter(item => item.title === 'Khoản chi cần giữ khóa').length, 1);
  assert.equal((await call('trips/' + trip.id + '/overview', account)).trip.totalExpenseMinor, 123000);
  await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
  await heading(page, 'Tài khoản');
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await heading(page, 'Đăng nhập');
  assert.deepEqual(errors, []);
});

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
  const config = smokeConfig(['--api-url', apiOrigin, '--web-url', web, '--environment', 'local',
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

test('offline group drafts retain equal sharing and use current membership after reconnecting', async t => {
  const { context, page, screen, expenses, session, trip } = await fixture(t, 'group-equal');
  const root = 'trips/' + trip.id;
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Bình ngoại tuyến',
  } });
  const invitation = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invitation.token } });
  await call(expenses, session, { method: 'POST', body: {
    title: 'Chi chung trước khi mất mạng', amountMinor: 150000, payerParticipantId: trip.ownerParticipantId,
    occurredOn: '2026-11-25', category: 'food', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  await page.goto(web + '/#tai-khoan');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await heading(page, 'Chia đều cho cả nhóm');
  // Wait until the trusted snapshot is available, including privacy-filtered identities.
  await page.waitForFunction(async () => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return false;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data'), read = tx.objectStore('data').getAll();
        read.onsuccess = () => resolve(read.result.some(row => row.kind === 'overview' && row.value.trip.equalParticipantIds?.length === 2));
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
  if (process.env.SHAREBILL_PWA_TEST === '1') await page.reload();
  else {
    await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
    await heading(page, 'Tài khoản');
    await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('them-khoan-chi'));
  }
  await heading(page, 'Thêm khoản chi');
  await heading(page, 'Chia đều cho cả nhóm');
  assert.equal(await page.getByRole('group', { name: 'Chia cho ai?', exact: true }).count(), 0);
  await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('so-du'));
  await heading(page, 'Tổng chi chia đều cho 2 thành viên');
  await page.locator('.balance-hero').getByText('75.000đ', { exact: true }).waitFor();
  await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('them-khoan-chi'));
  await heading(page, 'Chia đều cho cả nhóm');
  await page.getByLabel('Tên khoản chi').fill('Nháp nhóm ngoại tuyến');
  await page.getByLabel('Số tiền đã trả').fill('100000');
  assert.equal(await page.getByRole('button', { name: /Lưu khoản chi/ }).isDisabled(), true);
  const third = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Chi vừa tham gia',
  } });
  await call('invites/accept', third, { method: 'POST', body: { token: invitation.token } });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('radio', { name: 'Chi vừa tham gia', exact: true }).waitFor();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Lưu khoản chi'))?.disabled);
  assert.equal((await call(expenses, session)).items.length, 1, 'Reconnect never submits a draft automatically');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Nháp nhóm ngoại tuyến');
  const expenseId = page.url().split('/').at(-1);
  const saved = await call(expenses + '/' + expenseId, session);
  assert.equal(saved.amountMinor, 100000);
  assert.equal(saved.shares.length, 3);
  assert.deepEqual(saved.shares.map(row => row.amountMinor).sort(), [33333, 33333, 33334]);
  const overview = await call(root + '/overview', session);
  assert.equal(overview.trip.sharingMode, 'group-equal');
  assert.equal(overview.trip.totalExpenseMinor, 250000);
  assert.equal(overview.balances.reduce((sum, row) => sum + row.netMinor, 0), 0);
});

test('offline snapshots without a sharing mode require a fresh connection instead of guessing the split', async t => {
  const { context, page, screen } = await fixture(t, 'group-equal');
  await page.goto(web + '/#tai-khoan');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.goto(screen('tong-quan'));
  await heading(page, 'Tổng quan');
  await page.waitForFunction(async () => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return false;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data');
        const read = tx.objectStore('data').getAll();
        read.onsuccess = () => resolve(read.result.some(row => row.kind === 'overview'));
        tx.oncomplete = () => db.close();
      };
    });
  });
  if (process.env.SHAREBILL_PWA_TEST === '1') await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  // Recreate the snapshot format written by app versions before equal-group metadata was saved.
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:')).name;
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data');
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          if (entry.value.kind === 'overview') {
            const row = entry.value;
            delete row.value.trip.sharingMode; delete row.value.trip.equalParticipantIds;
            entry.update(row);
          }
          entry.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  if (process.env.SHAREBILL_PWA_TEST === '1') await page.reload();
  else {
    await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
    await heading(page, 'Tài khoản');
    await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('tong-quan'));
  }
  await heading(page, 'Chưa có dữ liệu ngoại tuyến cho chuyến đi');
  assert.equal(await page.getByRole('heading', { name: 'Tổng quan', exact: true }).count(), 0);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await heading(page, 'Tổng quan');
  await page.getByText('1 thành viên', { exact: true }).waitFor();
});

test('corrupt or expired private snapshots are discarded and recover after reconnecting', async t => {
  const { page, context, screen } = await fixture(t, 'group-equal');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(web + '/#tai-khoan');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.goto(screen('tong-quan'));
  await heading(page, 'Tổng quan');
  await waitForPrivateRecord(page);
  const original = (await privateRecords(page)).find(row => row.kind === 'overview');
  assert.ok(original);
  if (process.env.SHAREBILL_PWA_TEST === '1') await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  for (const corruption of ['malformed', 'expired', 'future', 'inconsistent-money']) {
    const row = structuredClone(original);
    if (corruption === 'malformed') row.value.participants = null;
    if (corruption === 'expired') row.at = Date.now() - 24 * 60 * 60_000;
    if (corruption === 'future') row.at = Date.now() + 24 * 60 * 60_000;
    if (corruption === 'inconsistent-money') row.value.balances[0].netMinor = 999;
    await privateRecords(page, [row]);
    if (process.env.SHAREBILL_PWA_TEST === '1') await page.reload();
    else {
      await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
      await heading(page, 'Tài khoản');
      await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('tong-quan'));
    }
    await heading(page, 'Chưa có dữ liệu ngoại tuyến cho chuyến đi');
    assert.equal((await privateRecords(page)).some(row => row.kind === 'overview'), false, corruption + ' cache must be discarded');
  }
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await heading(page, 'Tổng quan');
  await waitForPrivateRecord(page);
  assert.deepEqual(errors, []);
});

test('a corrupt saved draft cannot break the expense form or prevent a new draft', async t => {
  const { page, screen, session, trip } = await fixture(t, 'group-equal');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(web + '/#tai-khoan');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.goto(screen('tong-quan'));
  await heading(page, 'Tổng quan');
  await waitForPrivateRecord(page);
  await privateRecords(page, [{ uid: session.user.uid, tripId: trip.id, kind: 'expense-new', at: Date.now(), value: { fields: null } }]);
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  // The invalid read is removed before the user starts a replacement draft.
  await page.waitForFunction(async () => {
    const name = (await indexedDB.databases()).find(db => db.name.startsWith('sharebill-private-v1:'))?.name;
    if (!name) return false;
    return new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('data'), read = tx.objectStore('data').getAll();
        tx.oncomplete = () => { db.close(); resolve(!read.result.some(row => row.kind === 'expense-new')); };
      };
    });
  });
  assert.equal(await page.getByRole('button', { name: 'Tiếp tục bản nháp', exact: true }).count(), 0);
  await page.getByLabel('Tên khoản chi', { exact: true }).fill('Bản nháp mới hợp lệ');
  await page.getByLabel('Số tiền đã trả', { exact: true }).fill('50000');
  await waitForPrivateRecord(page, 'expense-new', '50000');
  await page.evaluate(() => { window.location.hash = 'tai-khoan'; });
  await heading(page, 'Tài khoản');
  await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('them-khoan-chi'));
  await heading(page, 'Bản nháp trên thiết bị');
  await page.getByRole('button', { name: 'Tiếp tục bản nháp', exact: true }).click();
  assert.equal(await page.getByLabel('Tên khoản chi', { exact: true }).inputValue(), 'Bản nháp mới hợp lệ');
  assert.equal(await page.getByLabel('Số tiền đã trả', { exact: true }).inputValue(), '50000');
  assert.deepEqual(errors, []);
});

test('a stalled private store warns about drafts but never traps a saved expense in the saving state', async t => {
  const { page, screen, session, expenses } = await fixture(t, 'group-equal');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(web + '/#tai-khoan');
  await page.getByLabel('Tin cậy thiết bị này').check();
  await page.evaluate(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: () => ({}) } });
  });
  await page.evaluate(url => { window.location.hash = new URL(url).hash; }, screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByLabel('Tên khoản chi', { exact: true }).fill('Lưu khi bộ nhớ bị kẹt');
  await page.getByLabel('Số tiền đã trả', { exact: true }).fill('75000');
  await page.getByText('Thiết bị chưa lưu hoặc đọc được bản nháp. Bản nhập vẫn ở tab này; hãy giữ tab mở tới khi lưu khoản chi thành công.', { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Lưu khi bộ nhớ bị kẹt');
  const saved = (await call(expenses, session)).items;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amountMinor, 75000);
  assert.deepEqual(errors, []);
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
    await page.getByRole('button', { name: 'Chuyển trả', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Người chuyển', { exact: true }).selectOption(peers[0].id);
    await dialog.getByLabel('Người nhận', { exact: true }).selectOption(trip.ownerParticipantId);
    const amount = dialog.getByLabel('Số tiền đã chuyển (VND)', { exact: true });
    const current = await overview(), fromBalance = current.balances.find(row => row.participantId === peers[0].id), toBalance = current.balances.find(row => row.participantId === trip.ownerParticipantId);
    const due = Math.min(-fromBalance.netMinor, toBalance.netMinor);
    await dialog.getByRole('region', { name: 'Số tiền cần chuyển cho người nhận', exact: true }).getByText(format(due), { exact: true }).waitFor();
    assert.equal(await amount.inputValue(), new Intl.NumberFormat('vi-VN').format(due));
    assert.equal(await dialog.getByText(/^Tối đa /).count(), 0);
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
    await page.getByRole('button', { name: 'Xác nhận đã nhận tiền', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Xác nhận thay', exact: true }).count(), 0);
    const pending = (await call(root + '/settlements?status=pending', session)).items[0];
    assert.equal(pending.amountMinor, 10000);
    const pendingSnapshot = await overview();
    await page.getByRole('region', { name: 'Công nợ còn lại của bạn', exact: true })
      .getByText(format(pendingSnapshot.balances.find(row => row.participantId === trip.ownerParticipantId).netMinor), { exact: true }).waitFor();
    await page.getByText('Số tiền ghi nhận cho khoản chuyển này:', { exact: false }).waitFor();
  }
  await recordPartial(true);
  assert.equal((await overview()).balances.find(row => row.participantId === peers[0].id).netMinor, debt.netMinor);
  await page.getByRole('button', { name: 'Xác nhận đã nhận tiền', exact: true }).click();
  await page.getByRole('dialog', { name: 'Xác nhận đã nhận tiền?', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('region', { name: 'Số tiền xác nhận của khoản chuyển', exact: true })
    .getByText('10.000đ', { exact: true }).waitFor();
  assert.equal((await call(root + '/settlements?status=pending', session)).items[0].amountMinor, 10000);
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy hiệu lực', exact: true }).waitFor();
  assert.equal((await call(root + '/settlements?status=confirmed', session)).items[0].confirmationMode, 'recipient');
  await page.getByText('An xác nhận đã nhận', { exact: false }).waitFor();
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
  await page.locator('.transfer-card .tag').filter({ hasText: /^Đã hủy$/ }).waitFor();
  assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 0);
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
  await page.getByText('Đã hủy', { exact: true }).waitFor();
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

test('single-person and unlinked balances guide users to add people, resplit old expenses and link accounts', { timeout: 90000 }, async t => {
  const { page, session, trip, screen, expenses } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  const root = 'trips/' + trip.id;
  const expense = await call(expenses, session, { method: 'POST', body: {
    title: 'Tiền chuyến đi chưa chia', category: 'food', amountMinor: 1550000, payerParticipantId: trip.ownerParticipantId,
    occurredOn: '2026-11-18', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Bình E2E',
  } });
  const invitation = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invitation.token } });
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => memberContext.close());
  await memberContext.addInitScript(session => {
    sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session));
  }, { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(screen('so-du'));
  await memberPage.getByText('Chưa liên kết', { exact: true }).waitFor();
  await memberPage.getByText(/Hiện chuyến chỉ có 1 người chia tiền/).waitFor();
  await memberPage.getByText('Tài khoản chưa liên kết với người chia tiền.', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: 'Ghi nhận đã chuyển', exact: true }).count(), 0);
  assert.equal(await memberPage.getByRole('link', { name: 'Thêm người chia tiền', exact: true }).count(), 0);
  await memberPage.getByRole('link', { name: 'Xem tài khoản trong chuyến', exact: true }).click();
  await heading(memberPage, 'Thành viên & phân quyền');
  assert.equal(await memberPage.getByRole('button', { name: 'Tài khoản truy cập', exact: true }).getAttribute('aria-pressed'), 'true');
  await memberPage.getByText('Bình E2E (bạn)', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: /Quản lý tài khoản/ }).count(), 0);

  await page.goto(screen('so-du'));
  const transferSection = page.getByRole('region', { name: 'Số tiền cần chuyển', exact: true });
  await transferSection.getByText(/Toàn bộ/).getByText('1.550.000đ', { exact: true }).waitFor();
  await transferSection.getByText(/Toàn bộ/).getByText('0đ', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Thêm người chia tiền', exact: true }).click();
  await page.getByRole('dialog', { name: 'Thêm người chia tiền', exact: true }).getByLabel('Tên hiển thị').fill('Bình');
  await page.getByRole('button', { name: 'Thêm thành viên', exact: true }).click();
  await page.getByRole('button', { name: 'Quản lý Bình', exact: true }).waitFor();
  const participant = (await call(root + '/overview', session)).participants.find(row => row.displayName === 'Bình');
  assert.equal((await call(expenses + '/' + expense.id, session)).shares.length, 1);
  await page.goto(screen('so-du'));
  await transferSection.getByRole('heading', { name: 'Chưa có khoản cần chuyển theo phần chia đã lưu', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ghi nhận đã chuyển', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Xem và sửa khoản chi', exact: true }).click();
  await page.getByRole('link').filter({ hasText: 'Tiền chuyến đi chưa chia' }).click();
  await page.getByRole('link', { name: 'Sửa khoản chi', exact: true }).click();
  await heading(page, 'Sửa khoản chi');
  assert.equal(await page.getByLabel('Phần chia dự kiến của Bình', { exact: true }).getByRole('checkbox').isChecked(), false);
  await page.getByRole('button', { name: 'Chọn tất cả', exact: true }).click();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Tiền chuyến đi chưa chia');
  const resplit = await call(expenses + '/' + expense.id, session);
  assert.equal(resplit.shares.length, 2);
  assert.ok(resplit.shares.every(row => row.amountMinor === 775000));
  await page.getByRole('link', { name: 'Xem số tiền còn cần trả / được nhận', exact: true }).click();
  await transferSection.getByText('775.000đ', { exact: true }).waitFor();
  assert.match(await transferSection.locator('.transfer-names').innerText(), /^Bình\s+An$/);
  await transferSection.getByRole('button', { name: 'Ghi nhận thay', exact: true }).waitFor();
  const transferY = (await transferSection.boundingBox()).y;
  assert.ok(transferY < (await page.getByRole('heading', { name: 'Số tiền của từng thành viên', exact: true }).boundingBox()).y);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await page.goto(screen('thanh-vien/tai-khoan'));
  await page.getByRole('button', { name: 'Quản lý tài khoản Bình E2E', exact: true }).click();
  await page.getByRole('button', { name: 'Liên kết người chia tiền', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Người chia tiền', { exact: true }).selectOption(participant.id);
  await dialog.getByLabel('Lý do', { exact: true }).fill('Gắn đúng tên để xem số tiền cần trả');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Thành viên · Chia tiền với tên Bình', { exact: true }).waitFor();
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('Bạn cần trả', { exact: true }).waitFor();
  await memberPage.locator('.balance-hero').getByText('775.000đ', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('link', { name: 'Xem tài khoản trong chuyến', exact: true }).count(), 0);
  await memberPage.getByRole('region', { name: 'Số tiền cần chuyển', exact: true }).getByRole('button', { name: 'Chuyển khoản', exact: true }).waitFor();
});

test('linked users with zero assigned costs are distinguished from settled users and duplicate names stay separate', async t => {
  const { page, session, trip, screen, expenses } = await fixture(t);
  const root = 'trips/' + trip.id;
  const aaa = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'aaa' } });
  const duplicate = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'An' } });
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'aaa',
  } });
  const invitation = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invitation.token } });
  await call(root + '/memberships/' + member.user.uid + '/link', session, { method: 'POST', version: 1,
    body: { participantId: aaa.id, reason: 'Liên kết tài khoản trước khi chia lại' } });
  const expense = await call(expenses, session, { method: 'POST', body: {
    title: 'Khoản cũ 2.100.000đ', category: 'food', amountMinor: 2100000, payerParticipantId: trip.ownerParticipantId,
    occurredOn: '2026-11-18', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => memberContext.close());
  await memberContext.addInitScript(session => {
    sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session));
  }, { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('Bạn chưa có chi phí phải chịu', { exact: true }).waitFor();
  await memberPage.locator('.balance-hero').getByText('0đ', { exact: true }).waitFor();
  await memberPage.getByRole('region', { name: 'Số dư của aaa', exact: true }).getByText('Chưa có chi phí phải chịu', { exact: true }).waitFor();
  await memberPage.getByRole('heading', { name: 'Chưa có khoản cần chuyển theo phần chia đã lưu', exact: true }).waitFor();
  assert.equal(await memberPage.getByText('Mọi người đã cân bằng.', { exact: true }).count(), 0);
  await memberPage.getByRole('link', { name: 'Xem khoản chi để chia lại', exact: true }).click();
  await memberPage.getByRole('link').filter({ hasText: 'Khoản cũ 2.100.000đ' }).click();
  await heading(memberPage, 'Khoản cũ 2.100.000đ');
  assert.equal(await memberPage.getByRole('link', { name: 'Sửa khoản chi', exact: true }).count(), 0);

  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByLabel('Phần chia dự kiến của aaa', { exact: true }).getByRole('checkbox').check();
  const duplicateBox = page.getByLabel('Phần chia dự kiến của An · ' + duplicate.id.slice(-4), { exact: true }).getByRole('checkbox');
  assert.equal(await duplicateBox.isChecked(), false);
  await page.getByLabel('Phần chia dự kiến của aaa', { exact: true }).getByText('1.050.000đ', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Khoản cũ 2.100.000đ');
  const saved = await call(expenses + '/' + expense.id, session);
  assert.deepEqual(saved.shares.map(row => row.participantId).sort(), [trip.ownerParticipantId, aaa.id].sort());
  assert.ok(saved.shares.every(row => row.amountMinor === 1050000));
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('Bạn cần trả', { exact: true }).waitFor();
  await memberPage.locator('.balance-hero').getByText('1.050.000đ', { exact: true }).waitFor();
  const transfer = memberPage.getByRole('region', { name: 'Số tiền cần chuyển', exact: true });
  await transfer.getByText('1.050.000đ', { exact: true }).waitFor();
  assert.match(await transfer.locator('.transfer-names').innerText(), new RegExp('^aaa\\s+An · ' + trip.ownerParticipantId.slice(-4) + '$'));
  assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('joining a group automatically shares old and new totals without linking or choosing expense participants', { timeout: 90000 }, async t => {
  const { page, session, trip, screen } = await fixture(t, null);
  const root = 'trips/' + trip.id;
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Chi chung trước khi aaa vào');
  await page.getByLabel('Số tiền đã trả').fill('2.100.000');
  await page.getByRole('heading', { name: 'Chia đều cho cả nhóm', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Chọn tất cả', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Nhập từng phần', exact: true }).count(), 0);
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Chi chung trước khi aaa vào');
  await heading(page, 'Chi chung của nhóm');
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'aaa',
  } });
  const invite = await call(root + '/invites', session, { method: 'POST', body: {} });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  await context.addInitScript(session => sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session)), { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const memberPage = await context.newPage();
  await memberPage.goto(web + '/#tham-gia/' + invite.token);
  await memberPage.getByText(/Vào nhóm là tự chia đều tổng chi/).waitFor();
  await memberPage.getByRole('button', { name: 'Tham gia chuyến đi', exact: true }).click();
  await heading(memberPage, 'Tổng quan');
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('Bạn cần trả', { exact: true }).waitFor();
  await memberPage.locator('.balance-hero').getByText('1.050.000đ', { exact: true }).waitFor();
  await memberPage.getByRole('heading', { name: 'Tổng chi chia đều cho 2 thành viên', exact: true }).waitFor();
  await memberPage.getByRole('region', { name: 'Số tiền cần chuyển', exact: true }).getByText('1.050.000đ', { exact: true }).waitFor();
  assert.equal(await memberPage.getByText('Chưa liên kết', { exact: true }).count(), 0);
  await memberPage.goto(screen('thanh-vien'));
  await memberPage.getByText('aaa (bạn)', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: 'Tài khoản truy cập', exact: true }).count(), 0);
  assert.equal(await memberPage.getByRole('button', { name: 'Thêm người', exact: true }).count(), 0);
  const third = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'bbb',
  } });
  await call('invites/accept', third, { method: 'POST', body: { token: invite.token } });
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('700.000đ', { exact: true }).waitFor();
  await memberPage.goto(screen('them-khoan-chi'));
  await heading(memberPage, 'Thêm khoản chi');
  await memberPage.getByLabel('Tên khoản chi').fill('aaa ứng thêm');
  await memberPage.getByLabel('Số tiền đã trả').fill('300.000');
  await memberPage.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(memberPage, 'aaa ứng thêm');
  await memberPage.getByRole('link', { name: 'Xem số tiền còn cần trả / được nhận', exact: true }).click();
  await memberPage.locator('.balance-hero').getByText('500.000đ', { exact: true }).waitFor();
  const aaa = page.getByRole('region', { name: 'Số dư của aaa', exact: true });
  await page.goto(screen('so-du'));
  await aaa.locator('dl > div').filter({ hasText: 'Phải chịu' }).getByText('800.000đ', { exact: true }).waitFor();
  await aaa.locator('dl > div').filter({ hasText: 'Đã ứng' }).getByText('300.000đ', { exact: true }).waitFor();
  assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('group expense edits preserve financial history after a payer leaves and restoring access redistributes the total', { timeout: 90000 }, async t => {
  const { page, session, trip, screen, expenses } = await fixture(t, null);
  const root = 'trips/' + trip.id;
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Bình',
  } });
  const invite = await call(root + '/invites', session, { method: 'POST', body: {} });
  const joined = await call('invites/accept', member, { method: 'POST', body: { token: invite.token } });
  const expense = await call(expenses, session, { method: 'POST', body: {
    title: 'Bình ứng trước khi rời nhóm', category: 'other', amountMinor: 200000,
    payerParticipantId: joined.participantId, occurredOn: '2026-11-19', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  await page.goto(screen('thanh-vien'));
  await page.getByRole('button', { name: 'Quản lý tài khoản Bình', exact: true }).click();
  await page.getByRole('button', { name: 'Gỡ quyền truy cập', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText(/Tổng chi sẽ chia lại cho những người còn trong nhóm/).waitFor();
  await dialog.getByLabel('Lý do').fill('Bình rời nhóm');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Đã gỡ quyền · Không còn tính vào số người chia', { exact: true }).waitFor();
  const before = await call(root + '/overview', session);
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Đổi tên sau khi Bình rời nhóm');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Đổi tên sau khi Bình rời nhóm');
  const metadata = await call(expenses + '/' + expense.id, session);
  assert.deepEqual(metadata.shares, expense.shares);
  assert.deepEqual((await call(root + '/overview', session)).balances, before.balances);
  assert.equal((await call(root + '/overview', session)).trip.ledgerVersion, before.trip.ledgerVersion);
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByLabel('Số tiền đã trả').fill('300.000');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Đổi tên sau khi Bình rời nhóm');
  const edited = await call(root + '/overview', session);
  assert.equal(edited.balances.find(row => row.participantId === joined.participantId).paidMinor, 300000);
  assert.equal(edited.balances.find(row => row.participantId === trip.ownerParticipantId).owedMinor, 300000);
  await page.goto(screen('thanh-vien'));
  await page.getByRole('button', { name: 'Quản lý tài khoản Bình', exact: true }).click();
  await page.getByRole('button', { name: 'Khôi phục quyền truy cập', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText(/cùng chia toàn bộ tổng chi/).waitFor();
  await dialog.getByLabel('Lý do').fill('Bình vào lại');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Thành viên · Tự chia đều tổng chi', { exact: true }).waitFor();
  const restored = await call(root + '/overview', session);
  assert.ok(restored.balances.every(row => row.owedMinor === 150000));
  assert.equal(restored.balances.find(row => row.participantId === joined.participantId).netMinor, 150000);
  const payment = await call(root + '/settlements', session, { method: 'POST', body: {
    fromParticipantId: trip.ownerParticipantId, toParticipantId: joined.participantId, amountMinor: 150000,
    occurredOn: '2026-11-19', note: null, basedOnLedgerVersion: restored.trip.ledgerVersion,
  } });
  await call(root + '/settlements/' + payment.id + '/confirm', session, { method: 'POST', version: payment.version,
    body: { basedOnLedgerVersion: restored.trip.ledgerVersion } });
  const balanced = await call(root + '/overview', session);
  await call(root + '/archive', session, { method: 'POST', version: balanced.trip.version, body: {} });
  await page.goto(screen('thanh-vien'));
  await page.reload();
  await page.getByText('Thành viên · Giữ phần chia lúc chốt', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Quản lý tài khoản Bình', exact: true }).click();
  await page.getByRole('button', { name: 'Gỡ quyền truy cập', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText(/Phần chia và số dư lúc chốt được giữ nguyên/).waitFor();
  await dialog.getByLabel('Lý do').fill('Thu hồi truy cập sau khi chốt');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('Đã gỡ quyền · Giữ phần chia lúc chốt', { exact: true }).waitFor();
  assert.deepEqual((await call(root + '/overview', session)).balances, balanced.balances);
  await page.goto(screen('so-du'));
  await page.getByRole('heading', { name: 'Tổng chi chia đều cho 2 thành viên', exact: true }).waitFor();
});

test('existing groups automatically upgrade old costs and hide unused manual duplicate names', async t => {
  const { page, session, trip, screen, expenses } = await fixture(t);
  const root = 'trips/' + trip.id;
  const expense = await call(expenses, session, { method: 'POST', body: {
    title: 'Khoản cũ cần tự chia', category: 'other', amountMinor: 240000, payerParticipantId: trip.ownerParticipantId,
    occurredOn: '2026-11-19', splitMethod: 'exact', split: { shares: [{ participantId: trip.ownerParticipantId, amountMinor: 240000 }] },
  } });
  await call(root + '/participants', session, { method: 'POST', body: { displayName: 'An' } });
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'aaa',
  } });
  const invite = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invite.token } });
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  const require = createRequire(new URL('../../be/package.json', import.meta.url));
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  fixtureApp ??= initializeApp({ projectId: 'demo-sharebill' }, 'browser-fixtures');
  await getFirestore(fixtureApp).doc(root).update({ sharingMode: FieldValue.delete() });
  await page.goto(screen('so-du'));
  await heading(page, 'Tổng chi chia đều cho 2 thành viên');
  await page.getByRole('region', { name: 'Số dư của aaa', exact: true }).getByText('120.000đ', { exact: true }).first().waitFor();
  await page.getByRole('region', { name: 'Số tiền cần chuyển', exact: true }).getByText('120.000đ', { exact: true }).waitFor();
  assert.equal(await page.locator('.balance-member').count(), 2);
  const overview = await call(root + '/overview', session);
  assert.equal(overview.trip.sharingMode, 'group-equal');
  assert.equal(overview.trip.equalParticipantIds.length, 2);
  assert.equal(overview.participants.length, 3);
  await page.goto(screen('sua-khoan-chi/' + expense.id));
  await heading(page, 'Sửa khoản chi');
  await page.getByLabel('Tên khoản chi').fill('Đổi tên khoản cũ chia chính xác');
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Đổi tên khoản cũ chia chính xác');
  const saved = await call(expenses + '/' + expense.id, session);
  assert.equal(saved.splitMethod, 'exact');
  assert.deepEqual(saved.shares, expense.shares);
  assert.equal((await call(root + '/overview', session)).trip.ledgerVersion, overview.trip.ledgerVersion);
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
  assert.equal(await page.getByRole('button', { name: 'Chuyển trả', exact: true }).count(), 0);
  await page.goto(screen('tong-quan'));
  await page.getByText('Chưa đủ dữ liệu', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('Các thành viên đã cân bằng.', { exact: true }).count(), 0);
  await page.goto(screen('cai-dat'));
  assert.equal(await page.getByRole('button', { name: 'Chốt chuyến đi', exact: true }).count(), 0);
  await page.goto(screen('thanh-vien'));
  await heading(page, 'Thành viên & phân quyền');
  assert.equal(await page.getByText('NaNđ', { exact: false }).count(), 0);
});

test('expense detail always shows invoices and can add an invoice to an existing group expense', async t => {
  const { page, context, session, trip, screen, expenses } = await fixture(t, 'group-equal');
  const root = 'trips/' + trip.id;
  const saved = await call(expenses, session, { method: 'POST', body: {
    title: 'Vé chưa có hóa đơn', amountMinor: 700000, payerParticipantId: trip.ownerParticipantId,
    occurredOn: '2026-11-25', category: 'tickets', splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId] },
  } });
  const original = await call(expenses + '/' + saved.id, session);
  const uploaded = { ...await paymentImageTransport(context, root, session), name: 'hoa-don-ve.png' };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(screen('khoan-chi/' + saved.id));
  await heading(page, 'Vé chưa có hóa đơn');
  const invoices = page.getByRole('region', { name: 'Ảnh hóa đơn của khoản chi', exact: true });
  await invoices.getByText('Khoản chi này chưa có ảnh hóa đơn.', { exact: true }).waitFor();
  assert.equal(await invoices.getByText('0/3 ảnh', { exact: true }).isVisible(), true);
  const add = invoices.getByRole('link', { name: 'Thêm ảnh hóa đơn', exact: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Empty invoice overflow at ' + width);
    assert.ok((await invoices.boundingBox()).y < (await page.getByRole('button', { name: 'Chia sẻ QR qua Zalo', exact: true }).boundingBox()).y);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await add.click();
  await heading(page, 'Sửa khoản chi');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), invoices.getByRole('button', { name: 'Tải ảnh hóa đơn', exact: true }).click()]);
  await chooser.setFiles(uploaded);
  await invoices.getByRole('button', { name: 'Xem ảnh ' + uploaded.name, exact: true }).waitFor();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Vé chưa có hóa đơn');
  await invoices.getByRole('button', { name: 'Xem ảnh Hóa đơn 1', exact: true }).waitFor();
  const updated = await call(expenses + '/' + saved.id, session);
  assert.equal(updated.receiptIds.length, 1);
  for (const key of ['title', 'amountMinor', 'payerParticipantId', 'splitMethod', 'shares']) assert.deepEqual(updated[key], original[key]);
  assert.equal(await invoices.getByText('1/3 ảnh', { exact: true }).isVisible(), true);
  assert.equal(await invoices.getByRole('link', { name: 'Thêm ảnh hóa đơn', exact: true }).count(), 0);
  assert.equal(await invoices.getByRole('link', { name: 'Quản lý ảnh hóa đơn', exact: true }).isVisible(), true);
  await page.reload();
  await invoices.getByRole('button', { name: 'Xem ảnh Hóa đơn 1', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Ảnh hóa đơn', exact: true });
  await viewer.getByAltText('Hóa đơn 1', { exact: true }).evaluate(element => element.decode());
  assert.equal(await viewer.getByRole('link', { name: 'Mở ảnh để lưu hoặc phóng to', exact: true }).isVisible(), true);
  await viewer.getByRole('button', { name: 'Đóng', exact: true }).click();
  await invoices.getByRole('link', { name: 'Quản lý ảnh hóa đơn', exact: true }).click();
  await heading(page, 'Sửa khoản chi');
  await invoices.getByRole('button', { name: 'Bỏ ảnh Hóa đơn 1', exact: true }).click();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Vé chưa có hóa đơn');
  await invoices.getByText('Khoản chi này chưa có ảnh hóa đơn.', { exact: true }).waitFor();
  assert.equal((await call(expenses + '/' + saved.id, session)).receiptIds.length, 0);
});

test('expense invoices are visible on create and shared with members outside the expense split', async t => {
  const { page, context: ownerContext, session, trip, screen, expenses } = await fixture(t);
  const root = 'trips/' + trip.id;
  const uploaded = { ...await paymentImageTransport(ownerContext, root, session), name: 'hoa-don-an-trua.png' };
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Thành viên xem hóa đơn',
  } });
  const invitation = await call(root + '/invites', session, { method: 'POST', body: {} });
  await call('invites/accept', member, { method: 'POST', body: { token: invitation.token } });
  await page.goto(screen('them-khoan-chi'));
  await heading(page, 'Thêm khoản chi');
  const invoices = page.getByRole('region', { name: 'Ảnh hóa đơn của khoản chi', exact: true });
  assert.equal(await invoices.getByRole('button', { name: 'Tải ảnh hóa đơn', exact: true }).isVisible(), true);
  assert.equal(await page.locator('details.optional-fields').evaluate(element => element.open), false);
  await page.getByLabel('Tên khoản chi').fill('Ăn trưa có hóa đơn');
  await page.getByLabel('Số tiền đã trả').fill('360000');
  await invoices.getByLabel('Tệp ảnh hóa đơn', { exact: true }).setInputFiles(uploaded);
  await invoices.getByAltText(uploaded.name, { exact: true }).waitFor();
  await invoices.getByRole('button', { name: 'Xem ảnh ' + uploaded.name, exact: true }).click();
  await page.getByRole('dialog').getByAltText(uploaded.name, { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: /Lưu khoản chi/ }).click();
  await heading(page, 'Ăn trưa có hóa đơn');
  const expenseId = page.url().split('/').at(-1);
  const saved = await call(expenses + '/' + expenseId, session);
  assert.equal(saved.receiptIds.length, 1);
  assert.deepEqual(saved.shares.map(row => row.participantId), [trip.ownerParticipantId]);
  await page.reload();
  await invoices.getByAltText('Hóa đơn 1', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Sửa khoản chi', exact: true }).click();
  await heading(page, 'Sửa khoản chi');
  await invoices.getByAltText('Hóa đơn 1', { exact: true }).waitFor();
  if (process.env.SHAREBILL_INVOICE_FORM_SCREENSHOT) await page.screenshot({ path: process.env.SHAREBILL_INVOICE_FORM_SCREENSHOT, fullPage: true });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  await context.addInitScript(session => {
    sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session));
  }, { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  await paymentImageTransport(context, root, member);
  const memberPage = await context.newPage();
  await memberPage.goto(screen('khoan-chi/' + expenseId));
  await heading(memberPage, 'Ăn trưa có hóa đơn');
  const shared = memberPage.getByRole('region', { name: 'Ảnh hóa đơn của khoản chi', exact: true });
  await shared.getByRole('button', { name: 'Xem ảnh Hóa đơn 1', exact: true }).click();
  const viewer = memberPage.getByRole('dialog', { name: 'Ảnh hóa đơn', exact: true });
  const image = viewer.getByAltText('Hóa đơn 1', { exact: true });
  await image.evaluate(element => element.decode());
  assert.equal(await image.evaluate(element => element.naturalWidth > 0), true);
  assert.equal(await viewer.getByRole('link', { name: 'Mở ảnh để lưu hoặc phóng to', exact: true }).isVisible(), true);
  assert.equal(await memberPage.getByRole('link', { name: 'Sửa khoản chi', exact: true }).count(), 0);
  assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await viewer.getByRole('button', { name: 'Đóng', exact: true }).click();
  if (process.env.SHAREBILL_INVOICE_DETAIL_SCREENSHOT) await memberPage.screenshot({ path: process.env.SHAREBILL_INVOICE_DETAIL_SCREENSHOT, fullPage: true });
  await memberPage.reload();
  await shared.getByAltText('Hóa đơn 1', { exact: true }).waitFor();
});

test('invitation QR opens the right trip and supports native sharing, clipboard and Zalo fallbacks', { timeout: 90000 }, async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  await context.addInitScript(() => {
    window.__inviteShares = []; window.__shareMode = 'success'; window.__clipboardFails = false;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => window.__shareMode !== 'unsupported' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
      if (window.__shareMode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
      if (window.__shareMode === 'error') throw new DOMException('Denied', 'NotAllowedError');
      window.__inviteShares.push({ title: data.title, text: data.text, url: data.url,
        file: data.files?.[0] && { name: data.files[0].name, type: data.files[0].type, size: data.files[0].size } });
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { if (window.__clipboardFails) throw new Error('Denied'); window.__inviteCopiedText = text; },
      write: async items => {
        if (window.__clipboardFails) throw new Error('Denied');
        const blob = await items[0].getType('image/png');
        window.__inviteCopiedImage = { type: blob.type, size: blob.size };
      },
    } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(screen('loi-moi'));
  await heading(page, 'Mời bạn vào chuyến đi');
  assert.equal(await page.getByRole('heading', { name: 'QR tham gia chuyến đi', exact: true }).count(), 0);
  await page.getByRole('combobox', { name: /Thời hạn/ }).selectOption('1');
  await page.getByLabel('Số lượt tham gia', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Tạo liên kết', exact: true }).click();
  const image = page.getByAltText('QR mời tham gia chuyến đi ' + trip.name, { exact: true });
  await image.waitFor();
  const inviteUrl = await page.getByLabel('Đường dẫn tham gia', { exact: true }).inputValue();
  assert.equal(new URL(inviteUrl).origin, new URL(web).origin);
  assert.match(new URL(inviteUrl).hash, /^#tham-gia\/[A-Za-z0-9_-]{43}$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Tải ảnh gửi Zalo', exact: true }).click()]);
  const bytes = await readFile(await download.path());
  const sharp = createRequire(new URL('../../be/package.json', import.meta.url))('sharp');
  const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const jsQR = createRequire(new URL('../package.json', import.meta.url))('jsqr');
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height);
  assert.equal(decoded?.data, inviteUrl, 'Downloaded invitation QR encodes the entire URL, including its fragment token');
  assert.equal(pixels.info.width, 900); assert.equal(pixels.info.height, 1120);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Invitation overflow at ' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chia sẻ liên kết qua Zalo', exact: true }).click();
  await page.getByText('Đã mở chia sẻ liên kết.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__inviteShares[0].url), inviteUrl);
  await page.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  await page.getByText('Đã mở chia sẻ ảnh.', { exact: false }).waitFor();
  const shared = await page.evaluate(() => window.__inviteShares[1]);
  assert.equal(shared.title, 'ShareBill · Mời vào chuyến đi');
  assert.equal(shared.file.type, 'image/png'); assert.equal(shared.file.size, bytes.length);
  assert.ok(shared.text.includes(inviteUrl));
  await page.getByRole('button', { name: 'Sao chép liên kết', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__inviteCopiedText), inviteUrl);
  await page.getByRole('button', { name: 'Sao chép ảnh', exact: true }).click();
  await page.getByText('Đã sao chép ảnh.', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__inviteCopiedImage), { type: 'image/png', size: bytes.length });
  await page.getByRole('button', { name: 'Sao chép nội dung gửi nhóm', exact: true }).click();
  assert.ok((await page.evaluate(() => window.__inviteCopiedText)).includes(inviteUrl));
  assert.equal(await page.getByRole('link', { name: 'Mở Zalo Web', exact: true }).getAttribute('href'), 'https://chat.zalo.me/');
  await page.evaluate(() => { window.__shareMode = 'unsupported'; });
  await page.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  await page.getByText('Thiết bị chưa hỗ trợ chia sẻ ảnh trực tiếp.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Chia sẻ liên kết qua Zalo', exact: true }).click();
  await page.getByText('Thiết bị chưa hỗ trợ chia sẻ liên kết trực tiếp.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__inviteShares.length), 2);
  await page.evaluate(() => { window.__shareMode = 'error'; });
  await page.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  await page.getByText('Chưa chia sẻ được ảnh.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Chia sẻ liên kết qua Zalo', exact: true }).click();
  await page.getByText('Chưa chia sẻ được liên kết.', { exact: false }).waitFor();
  await page.evaluate(() => { window.__shareMode = 'cancel'; });
  await page.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  assert.equal(await page.getByText('Chưa chia sẻ được ảnh.', { exact: false }).count(), 0);
  await page.getByRole('button', { name: 'Chia sẻ liên kết qua Zalo', exact: true }).click();
  assert.equal(await page.getByText('Chưa chia sẻ được liên kết.', { exact: false }).count(), 0);
  await page.evaluate(() => { window.__clipboardFails = true; });
  await page.getByRole('button', { name: 'Sao chép ảnh', exact: true }).click();
  await page.getByText('Chưa sao chép được ảnh.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Sao chép nội dung gửi nhóm', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: /Nội dung gửi nhóm Zalo/ }).inputValue(), shared.text);
  await page.getByRole('button', { name: 'Sao chép liên kết', exact: true }).click();
  await page.getByText('Chọn đường dẫn bên trên để sao chép', { exact: false }).waitFor();

  // Opening the decoded QR in a different account goes through preview and acceptance.
  const member = await call('auth/register', null, { method: 'POST', body: {
    email: randomUUID() + '@example.test', password: 'BrowserFixture-123!', displayName: 'Bạn quét QR',
  } });
  const memberContext = await browser.newContext();
  t.after(() => memberContext.close());
  await memberContext.addInitScript(session => sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session)),
    { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(decoded.data);
  await heading(memberPage, 'Lời mời tham gia');
  await memberPage.getByRole('button', { name: 'Tham gia chuyến đi', exact: true }).click();
  await heading(memberPage, 'Tổng quan');
  assert.ok((await call('trips/' + trip.id + '/members', session)).memberships.some(item => item.uid === member.user.uid && item.status === 'active'));

  // Creating another link must replace both the displayed QR and its downloaded payload.
  await page.getByRole('button', { name: 'Tạo liên kết', exact: true }).click();
  await page.waitForFunction(previous => document.querySelector('input[readonly]')?.value !== previous, inviteUrl);
  const secondUrl = await page.getByLabel('Đường dẫn tham gia', { exact: true }).inputValue();
  await image.waitFor();
  const src = await image.getAttribute('src');
  const secondPixels = await sharp(Buffer.from(src.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(jsQR(new Uint8ClampedArray(secondPixels.data), secondPixels.info.width, secondPixels.info.height)?.data, secondUrl);
  if (process.env.SHAREBILL_INVITE_QR_SCREENSHOT) await page.screenshot({ path: process.env.SHAREBILL_INVITE_QR_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: 'Thu hồi', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Thu hồi lời mời?', exact: true }).getByRole('button', { name: 'Thu hồi liên kết', exact: true }).click();
  await image.waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Đường dẫn tham gia', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).count(), 0);
});

test('shares named bank QR images using remaining debt with native sharing and Zalo download fallback', { timeout: 90000 }, async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  const root = 'trips/' + trip.id;
  const binh = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'Bình' } });
  const chi = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'Chi' } });
  const ids = [trip.ownerParticipantId, binh.id, chi.id];
  const bill = await call(root + '/expenses', session, { method: 'POST', body: { title: 'Ăn tối chia nhóm', amountMinor: 450000,
    payerParticipantId: trip.ownerParticipantId, occurredOn: '2026-11-23', category: 'food', splitMethod: 'equal', split: { participantIds: ids } } });
  await call(root + '/expenses', session, { method: 'POST', body: { title: 'Bình ứng tiền xe', amountMinor: 60000,
    payerParticipantId: binh.id, occurredOn: '2026-11-23', category: 'transport', splitMethod: 'equal', split: { participantIds: ids } } });
  let overview = await call(root + '/overview', session);
  const paid = await call(root + '/settlements', session, { method: 'POST', body: { fromParticipantId: binh.id,
    toParticipantId: trip.ownerParticipantId, amountMinor: 10000, occurredOn: '2026-11-23', basedOnLedgerVersion: overview.trip.ledgerVersion } });
  await call(root + '/settlements/' + paid.id + '/confirm', session, { method: 'POST', version: 1, body: { basedOnLedgerVersion: overview.trip.ledgerVersion } });
  overview = await call(root + '/overview', session);
  const pending = await call(root + '/settlements', session, { method: 'POST', body: { fromParticipantId: chi.id,
    toParticipantId: trip.ownerParticipantId, amountMinor: 40000, occurredOn: '2026-11-23', basedOnLedgerVersion: overview.trip.ledgerVersion } });
  const qrPayload = '00020101021238590010A0000007270129000697044101156607040600001290208QRIBFTTA5204999953037045405100005802VN62180814SHAREBILL TEST630403F2';
  const qrImage = await paymentImageTransport(context, root, session, qrPayload);
  await page.goto(screen('thanh-vien'));
  await page.getByRole('button', { name: 'Thêm QR nhận tiền', exact: true }).click();
  await page.getByLabel('Ảnh QR nhận tiền', { exact: true }).setInputFiles(qrImage);
  await page.getByRole('button', { name: 'Lưu QR nhận tiền', exact: true }).click();
  await page.getByRole('button', { name: 'Đổi QR nhận tiền', exact: true }).waitFor();
  await context.addInitScript(() => {
    window.__shareCalls = 0; window.__canShareImages = true;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => window.__canShareImages });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
      window.__shareCalls++;
      const file = data.files[0], hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      window.__sharedQr = { text: data.text, name: file.name, type: file.type,
        hash: Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, '0')).join('') };
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedQrText = text; } } });
  });
  await page.reload(); // Hash navigation alone does not install the new document's share mocks.
  assert.equal(await page.evaluate(() => window.__canShareImages), true);
  await page.setViewportSize({ width: 390, height: 844 });
  const writes = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/settlements(?:\/|$)/.test(new URL(request.url()).pathname)) writes.push(request.url()); });
  await page.goto(screen('khoan-chi/' + bill.id));
  await heading(page, 'Ăn tối chia nhóm');
  await page.getByRole('button', { name: 'Chia sẻ QR qua Zalo', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'QR trả tiền cho từng người', exact: true });
  const waiting = dialog.getByRole('region', { name: 'Khoản cần trả của Chi', exact: true });
  await waiting.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  assert.equal(await waiting.getByRole('button', { name: 'Tạo QR cho Chi', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Tạo QR cho Bình', exact: true }).click();
  const download = dialog.getByRole('link', { name: 'Tải ảnh gửi Zalo', exact: true });
  await download.waitFor();
  assert.match(await download.getAttribute('download'), /Binh-100000\.png$/);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const bytes = await readFile(await file.path());
  const sharp = createRequire(new URL('../../be/package.json', import.meta.url))('sharp');
  const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const jsQR = createRequire(new URL('../package.json', import.meta.url))('jsqr');
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height);
  assert.equal(pixels.info.width, 900); assert.equal(pixels.info.height, 1400);
  assert.ok(decoded?.data.includes('00069704410115660704060000129'));
  assert.ok(decoded.data.includes('5406100000'), 'Uses 100000 remaining after Bình paid/advanced, rather than the original 150000 bill share');
  await dialog.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  await dialog.getByText('Đã mở chia sẻ ảnh.', { exact: false }).waitFor();
  const shared = await page.evaluate(() => window.__sharedQr);
  assert.equal(shared.type, 'image/png');
  assert.equal(shared.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.match(shared.text, /Bình chuyển 100\.000đ cho An/);
  assert.match(shared.text, /Bill: Ăn tối chia nhóm/);
  assert.ok(!/token=|signature=|Bearer /.test(shared.text));
  await dialog.getByRole('button', { name: 'Sao chép nội dung gửi nhóm', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copiedQrText), shared.text);
  await page.evaluate(() => { window.__canShareImages = false; });
  await dialog.getByRole('button', { name: 'Chia sẻ ảnh', exact: true }).click();
  await dialog.getByText('Thiết bị chưa hỗ trợ chia sẻ ảnh trực tiếp.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__shareCalls), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(writes.length, 0, 'Sharing does not create or confirm settlements');
  assert.equal((await call(root + '/settlements?status=pending', session)).items[0].id, pending.id);
  if (process.env.SHAREBILL_SHARED_QR_IMAGE) await writeFile(process.env.SHAREBILL_SHARED_QR_IMAGE, bytes);
  if (process.env.SHAREBILL_QR_SHARE_SCREENSHOT) await page.screenshot({ path: process.env.SHAREBILL_QR_SHARE_SCREENSHOT });
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.goto(screen('so-du'));
  await page.getByRole('button', { name: 'Chia sẻ QR qua Zalo', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Tạo QR cho Bình', exact: true }).waitFor();
});

test('two accounts upload QR and transfer evidence, confirm repayment and archive a balanced trip', async t => {
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

  const ownerImage = await paymentImageTransport(ownerContext, root, session);
  await page.goto(screen('thanh-vien'));
  await page.getByRole('button', { name: 'Thêm QR nhận tiền', exact: true }).click();
  await page.getByLabel('Ảnh QR nhận tiền', { exact: true }).setInputFiles(ownerImage);
  await page.getByAltText('Ảnh QR nhận tiền', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Lưu QR nhận tiền', exact: true }).click();
  await page.getByRole('button', { name: 'Đổi QR nhận tiền', exact: true }).waitFor();
  const withQr = await call(root + '/overview', session);
  assert.ok(withQr.participants.find(row => row.id === trip.ownerParticipantId).paymentQrReceiptId);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  await context.addInitScript(session => {
    sessionStorage.setItem('sharebill-live-session-v1', JSON.stringify(session));
  }, { ...member, expiresAt: Date.now() + member.expiresIn * 1000 });
  const qrPayload = '00020101021238590010A0000007270129000697044101156607040600001290208QRIBFTTA5204999953037045405100005802VN62180814SHAREBILL TEST630403F2';
  const proofImage = { ...await paymentImageTransport(context, root, member, qrPayload), name: 'anh-chuyen-khoan_1795400045434_411230764244363938_'.repeat(12) + '.jpg' };
  const memberPage = await context.newPage();
  await memberPage.goto(screen('so-du'));
  await heading(memberPage, 'Số dư & quyết toán');
  await memberPage.getByRole('button', { name: 'Chuyển khoản', exact: true }).click();
  let transferDialog = memberPage.getByRole('dialog');
  await transferDialog.getByAltText('QR nhận tiền của An', { exact: true }).waitFor();
  const downloadQr = transferDialog.getByRole('link', { name: 'Tải QR có sẵn số tiền', exact: true });
  await downloadQr.waitFor();
  assert.equal(await downloadQr.getAttribute('download'), 'sharebill-120000.png');
  const [downloaded] = await Promise.all([memberPage.waitForEvent('download'), downloadQr.click()]);
  const requireImages = createRequire(new URL('../package.json', import.meta.url));
  const sharp = createRequire(new URL('../../be/package.json', import.meta.url))('sharp');
  const decodedImage = await sharp(await readFile(await downloaded.path())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decodedQr = requireImages('jsqr')(new Uint8ClampedArray(decodedImage.data), decodedImage.info.width, decodedImage.info.height);
  assert.ok(decodedQr?.data.includes('00069704410115660704060000129'), 'Saved QR keeps the bank and account');
  assert.ok(decodedQr.data.includes('5406120000'), 'Saved QR contains the exact amount due');
  assert.ok(!decodedQr.data.includes('540510000'), 'Saved QR replaces the old QR amount');
  // A fresh view that cannot decode the source must show the original without claiming an embedded amount.
  await context.route('**/' + root + '/receipts/*/view-url', route => route.fulfill({ json: { data: { url: 'data:image/png;base64,invalid' } } }));
  await transferDialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await memberPage.getByRole('button', { name: 'Chuyển khoản', exact: true }).click();
  await transferDialog.getByText('Chưa tạo được QR có sẵn số tiền từ ảnh này.', { exact: false }).waitFor();
  assert.equal(await transferDialog.getByRole('link', { name: 'Tải QR có sẵn số tiền', exact: true }).count(), 0);
  await context.unroute('**/' + root + '/receipts/*/view-url');
  await paymentImageTransport(context, root, member, qrPayload);
  await transferDialog.getByRole('button', { name: 'Thử tạo QR lại', exact: true }).click();
  await downloadQr.waitFor();
  const dueSummary = transferDialog.getByRole('region', { name: 'Số tiền cần chuyển cho người nhận', exact: true });
  await dueSummary.getByText('120.000đ', { exact: true }).waitFor();
  assert.equal(await transferDialog.getByLabel('Số tiền đã chuyển (VND)', { exact: true }).inputValue(), '120.000');
  assert.ok((await dueSummary.boundingBox()).y < (await transferDialog.getByAltText('QR nhận tiền của An', { exact: true }).boundingBox()).y);
  const sendReport = transferDialog.getByRole('button', { name: 'Gửi báo đã chuyển khoản', exact: true });
  assert.equal(await sendReport.isDisabled(), true);
  await transferDialog.getByLabel('Ảnh chuyển khoản', { exact: true }).setInputFiles(proofImage);
  await transferDialog.getByAltText('Ảnh chuyển khoản', { exact: true }).waitFor();
  const footerBox = await sendReport.boundingBox(), dialogBox = await transferDialog.boundingBox();
  assert.ok(footerBox.y >= dialogBox.y && footerBox.y + footerBox.height <= dialogBox.y + dialogBox.height);
  assert.equal(await transferDialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  assert.ok((await transferDialog.getByAltText('Ảnh chuyển khoản', { exact: true }).boundingBox()).height <= 180);
  const amount = transferDialog.getByLabel('Số tiền đã chuyển (VND)', { exact: true });
  await amount.fill('1e3');
  await sendReport.click();
  await transferDialog.getByRole('alert').waitFor();
  await amount.fill('120.000');
  assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SHAREBILL_PAYMENT_SCREENSHOT) await memberPage.screenshot({ path: process.env.SHAREBILL_PAYMENT_SCREENSHOT, fullPage: true });
  await sendReport.click();
  await heading(memberPage, 'Lịch sử chuyển tiền');
  await memberPage.getByText('Chờ xác nhận', { exact: true }).last().waitFor();
  const pending = await call(root + '/overview', session);
  assert.equal(pending.balances.find(row => row.participantId === participant.id).netMinor, -120000);
  const transfer = (await call(root + '/settlements?status=pending', session)).items[0];
  assert.equal(transfer.receiptIds.length, 1);
  assert.equal(await memberPage.getByRole('button', { name: 'Xác nhận đã nhận tiền', exact: true }).count(), 0);
  await memberPage.goto(screen('so-du'));
  await memberPage.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).click();
  await heading(memberPage, 'Lịch sử chuyển tiền');
  await memberPage.goto(screen('so-du'));
  await memberPage.reload();
  await memberPage.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: 'Chuyển khoản', exact: true }).count(), 0);
  await page.goto(screen('so-du'));
  await page.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chuyển trả', exact: true }).click();
  const duplicateDialog = page.getByRole('dialog');
  await duplicateDialog.getByText('Khoản chuyển này đã được ghi nhận và đang chờ xác nhận.', { exact: false }).waitFor();
  assert.equal(await duplicateDialog.getByRole('link', { name: 'Xem và xử lý khoản đang chờ', exact: true }).isVisible(), true);
  assert.equal(await duplicateDialog.getByLabel('Số tiền đã chuyển (VND)', { exact: true }).count(), 0);
  assert.equal(await duplicateDialog.getByLabel('Ảnh chuyển khoản', { exact: true }).count(), 0);
  assert.equal(await duplicateDialog.getByRole('button', { name: 'Ghi nhận', exact: true }).count(), 0);
  await duplicateDialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 1);

  await page.goto(screen('quyet-toan'));
  await page.getByRole('button', { name: 'Xem ảnh chuyển khoản', exact: true }).click();
  await page.getByRole('dialog').getByAltText('Ảnh chuyển khoản 1', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận đã nhận tiền', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByText('An xác nhận đã nhận', { exact: false }).waitFor();
  const confirmed = await call(root + '/overview', session);
  assert.ok(confirmed.balances.every(row => row.netMinor === 0));
  await memberPage.goto(screen('so-du'));
  await memberPage.locator('.balance-hero').getByText('Đã cân bằng', { exact: true }).waitFor();
  assert.equal(await memberPage.getByText('Bạn chưa có chi phí phải chịu', { exact: true }).count(), 0);
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

test('manual transfer recording stays locked after refresh and in another tab until the pending record is cancelled', async t => {
  const { page, context, session, trip, screen } = await fixture(t);
  const root = 'trips/' + trip.id;
  const peer = await call(root + '/participants', session, { method: 'POST', body: { displayName: 'Bình' } });
  await call(root + '/expenses', session, { method: 'POST', body: { title: 'Khoản trả cần chống trùng', category: 'food',
    amountMinor: 200_000, payerParticipantId: trip.ownerParticipantId, occurredOn: '2026-11-20',
    splitMethod: 'equal', split: { participantIds: [trip.ownerParticipantId, peer.id] } } });
  await page.goto(screen('so-du'));
  const staleTab = await context.newPage();
  await staleTab.goto(screen('so-du'));
  await staleTab.getByRole('button', { name: 'Ghi nhận thay', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ghi nhận thay', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ghi nhận', exact: true }).dblclick();
  await heading(page, 'Lịch sử chuyển tiền');
  assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 1);
  await staleTab.getByRole('button', { name: 'Ghi nhận thay', exact: true }).click();
  await staleTab.getByRole('dialog').getByRole('button', { name: 'Ghi nhận', exact: true }).click();
  await staleTab.getByRole('dialog').getByRole('link', { name: 'Xem và xử lý khoản đang chờ', exact: true }).waitFor();
  assert.equal(await staleTab.getByRole('dialog').getByRole('button', { name: 'Ghi nhận', exact: true }).count(), 0);
  assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 1);
  await page.goto(screen('so-du'));
  await page.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ghi nhận thay', exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  const otherTab = await context.newPage();
  await otherTab.goto(screen('so-du'));
  await otherTab.getByRole('link', { name: 'Xem khoản đang chờ', exact: true }).waitFor();
  assert.equal((await call(root + '/settlements?status=pending', session)).items.length, 1);
  await page.goto(screen('quyet-toan'));
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByRole('button', { name: 'Đã hủy', exact: true }).waitFor();
  await page.goto(screen('so-du'));
  await page.getByRole('button', { name: 'Ghi nhận thay', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ghi nhận thay', exact: true }).isEnabled(), true);
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
  const repair = store.doc('maintenanceJobs/projection-repair-' + randomUUID());
  const scheduled = store.doc('maintenanceJobs/scheduled-test-' + randomUUID());
  await job.set({ kind: 'ledger_reconcile', status: 'failed', attempts: 1, lastErrorCode: 'RECONCILE_ISSUES_FOUND',
    resultSummary: { tripsScanned: 3, tripsChecked: 2, tripsWithIssues: 1, issueCount: 2, scanErrors: 1 },
    checkpoint: 'private-reconcile-checkpoint', privateDiff: 'private-reconcile-financial-values',
    updatedAt: Timestamp.now() });
  await repair.set({ kind: 'projection_repair', status: 'succeeded', attempts: 1,
    resultSummary: { changedDocuments: 4 }, backupRef: 'private-repair-backup', reason: 'private-repair-reason', updatedAt: Timestamp.now() });
  await scheduled.set({ kind: 'scheduled_maintenance', status: 'succeeded', attempts: 1,
    resultSummary: { authScanned: 25, authQueued: 2, authProcessed: 2, authErrors: 0,
      ledgerProcessed: 1, ledgerIssues: 0, ledgerScanErrors: 0, ledgerState: 'queued' },
    leaseOwner: 'private-scheduler-lease', updatedAt: Timestamp.now() });
  try {
    await admin.getByRole('link', { name: 'Hệ thống', exact: true }).click();
    await admin.getByText('Đối soát sổ tiền', { exact: false }).waitFor();
    await admin.getByText('Đã kiểm 2/3 chuyến · 1 chuyến cần kiểm tra · 2 sai lệch · 1 lỗi quét', { exact: true }).waitFor();
    await admin.getByText('Sửa số dư từ sổ tiền', { exact: false }).waitFor();
    await admin.getByText('Đã sửa 4 bản ghi số dư, bộ đếm và thông báo cập nhật. Chuyến tiếp tục tạm khóa để kiểm tra.', { exact: true }).waitFor();
    await admin.getByText('Bảo trì định kỳ', { exact: false }).waitFor();
    await admin.getByText('Tài khoản: đã kiểm 25, xử lý 2 tác vụ · 0 lỗi.', { exact: true }).waitFor();
    await admin.getByText('Đối soát: Đang chờ · 1 chuyến trong lượt · 0 sai lệch trong chu kỳ · 0 lỗi quét.', { exact: true }).waitFor();
    assert.equal(await admin.getByText(/private-reconcile/).count(), 0);
    assert.equal(await admin.getByText(/private-repair/).count(), 0);
    assert.equal(await admin.getByText(/private-scheduler/).count(), 0);
  } finally { await Promise.all([job.delete(), repair.delete(), scheduled.delete()]); }
  assert.deepEqual(errors, []);
});
