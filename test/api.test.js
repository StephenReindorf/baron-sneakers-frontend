process.env.DEV_MEMORY_DB = 'true';
process.env.DEV_ADMIN_EMAIL = 'admin@test.local';
process.env.DEV_ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { app, products, expireHolds, totpCode, schedule } = require('../server');
const mfa = () => totpCode(process.env.ADMIN_TOTP_SECRET);

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

function remember(response, jar) {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function call(method, url, body, jar = new Map()) {
  const mutating = !['GET', 'HEAD'].includes(method);
  if (mutating && !jar.has('baron.csrf')) {
    const boot = await fetch(base + '/api/arrival');
    remember(boot, jar);
  }
  const headers = { 'Content-Type': 'application/json' };
  if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  if (mutating) headers['x-csrf-token'] = jar.get('baron.csrf') || '';
  const response = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  remember(response, jar);
  return { status: response.status, body: await response.json().catch(() => ({})), jar };
}

async function uploadProduct(method, url, fields, image, jar) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, key === 'sizes' ? JSON.stringify(value) : String(value));
  }
  if (image) form.append('image', new Blob([image.bytes], { type: image.type }), image.name);
  const headers = {
    Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    'x-csrf-token': jar.get('baron.csrf')
  };
  const response = await fetch(base + url, { method, headers, body: form });
  remember(response, jar);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const order = (overrides = {}) => ({
  type: 'retail', items: [{ id: 1, size: 42, qty: 1, price: 1 }], name: 'Ama', phone: '0244000001',
  location: 'Osu', pay: 'MoMo', accepted: true, idempotencyKey: crypto.randomUUID(), ...overrides
});
const stock = (id, size) => products.find((product) => product.id === id).sizes[size];

let admin;
test('admin can sign in with email, password and a six-digit code', async () => {
  assert.equal((await call('POST', '/api/admin/login', { email: 'admin@test.local', password: 'wrong', totp: mfa() })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { email: 'admin@test.local', password: 'test-password', totp: '000000' })).status, 401);
  const response = await call('POST', '/api/admin/login', { email: 'admin@test.local', password: 'test-password', totp: mfa() });
  assert.equal(response.status, 200);
  admin = response.jar;
});

test('product photos are resized, stripped, converted to WebP and cleaned up', async () => {
  const fields = { name: 'Image Test', brand: 'Test', colorway: 'Triple Black', primaryColor: 'Black', accentColor: '', costCfa: 10000, sizes: { 42: 1 }, fit: '', shift: 0, onRequest: false };
  const source = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: '#ffffff' }
  }).withMetadata({ exif: { IFD0: { Copyright: 'Should be stripped' } } }).png().toBuffer();
  assert.notEqual((await sharp(source).metadata()).exif, undefined);
  const created = await uploadProduct('POST', '/api/admin/products', fields, { bytes: source, type: 'image/png', name: 'shoe.png' }, admin);
  assert.equal(created.status, 201);
  assert.match(created.body.img, /\.webp$/);
  const firstPath = path.join(__dirname, '..', created.body.img);
  const metadata = await sharp(await fs.promises.readFile(firstPath)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.exif, undefined);

  const replacement = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#000000' }
  }).jpeg().toBuffer();
  const updated = await uploadProduct('PATCH', `/api/admin/products/${created.body.id}`, fields, { bytes: replacement, type: 'image/jpeg', name: 'replacement.jpg' }, admin);
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.img, created.body.img);
  assert.equal(fs.existsSync(firstPath), false);

  const replacementPath = path.join(__dirname, '..', updated.body.img);
  assert.equal(fs.existsSync(replacementPath), true);
  assert.equal((await call('DELETE', `/api/admin/products/${created.body.id}`, null, admin)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(replacementPath), false);
});

test('server source and config files are not served', async () => {
  for (const file of ['/server.js', '/package.json', '/.env', '/db/schema.sql']) {
    const response = await fetch(base + file);
    assert.doesNotMatch(await response.text(), /require\(|"dependencies"|DATABASE_URL|CREATE TABLE/);
  }
});

test('wholesale products require an approved session', async () => {
  assert.equal((await call('GET', '/api/wholesale/products')).status, 403);
  const login = await call('POST', '/api/wholesale/login', { phone: '0244000009', accessCode: 'WHOLESALE-DEV' });
  const response = await call('GET', '/api/wholesale/products', null, login.jar);
  assert.equal(response.status, 200);
  assert.ok(response.body.every((product) => product.wholesale && product.retail === undefined && product.cost_cfa === undefined));
});

test('public products never expose cost', async () => {
  const { body } = await call('GET', '/api/products');
  assert.ok(body.every((product) => product.cost_cfa === undefined && product.wholesale === undefined));
  assert.ok(body.every((product) => product.colorway && product.primary_color));
  assert.ok(body.some((product) => product.accent_color));
  assert.ok(body.some((product) => product.accent_color === null));
});

test('admin products require valid, distinct canonical colours', async () => {
  const base = {
    name: 'Colour Test', brand: 'Nike', colorway: 'Invisible', primaryColor: 'Invisible',
    accentColor: '', costCfa: 10000, sizes: { 42: 1 }
  };
  assert.equal((await call('POST', '/api/admin/products', base, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/products', { ...base, primaryColor: 'Black', accentColor: 'Neon' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/products', { ...base, primaryColor: 'Black', accentColor: 'Black' }, admin)).status, 400);
});

test('order total is recomputed on the server and idempotent', async () => {
  const before = stock(1, 42);
  const payload = order();
  const first = await call('POST', '/api/orders', payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.total, 360);
  assert.equal(stock(1, 42), before - 1);
  const again = await call('POST', '/api/orders', payload);
  assert.equal(again.body.ref, first.body.ref);
  assert.equal(stock(1, 42), before - 1);
  const saved = (await call('GET', '/api/admin/orders', null, admin)).body.find((item) => item.ref === first.body.ref);
  assert.equal(saved.items[0].colorway, 'Grey / White');
});

test('order text is sanitized before going into WhatsApp', async () => {
  const response = await call('POST', '/api/orders', order({ name: 'Ama\nTotal: GHS 1', phone: '0244000002' }));
  const text = decodeURIComponent(new URL(response.body.wa_url).searchParams.get('text'));
  assert.match(text, /Name: Ama Total: GHS 1/);
  assert.match(text, /New Balance 9060 — Grey \/ White/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('Total:')).length, 1);
});

test('a phone or IP cannot hold more than two unpaid orders', async () => {
  const response = await call('POST', '/api/orders', order({ phone: '0244000003' }));
  assert.equal(response.status, 429);
});

test('tracking uses one generic error and hides expired orders as expired', async () => {
  const placed = await call('GET', '/api/admin/orders', null, admin);
  const ref = placed.body[0].ref;
  assert.equal((await call('POST', '/api/track', { ref, last4: '9999' })).status, 400);
  assert.equal((await call('POST', '/api/track', { ref: 'BRN-000000', last4: '0001' })).body.error, (await call('POST', '/api/track', { ref, last4: '9999' })).body.error);
  const open = await call('POST', '/api/track', { ref, last4: '0001' });
  assert.equal(open.body.stage, 0);
  assert.equal(open.body.arrival, null);

  const before = stock(1, 42);
  expireHolds(Date.now() + 2 * 60 * 60 * 1000);
  assert.equal(stock(1, 42), before + 2);
  const tracked = await call('POST', '/api/track', { ref, last4: '0001' });
  assert.equal(tracked.body.status, 'expired');
  assert.equal((await call('PATCH', `/api/admin/orders/${ref}`, { action: 'paid', transactionId: 'LATE-1' }, admin)).status, 409);
});

test('admin endpoints require a session', async () => {
  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
  assert.equal((await call('PATCH', '/api/admin/settings', { rate: 1 })).status, 401);
});

test('payment needs a unique transaction ID and only paid orders ship', async () => {
  const first = await call('POST', '/api/orders', order({ phone: '0244000004' }));
  const second = await call('POST', '/api/orders', order({ phone: '0244000005' }));
  assert.equal((await call('PATCH', `/api/admin/orders/${first.body.ref}`, { action: 'ship' }, admin)).status, 409);
  assert.equal((await call('PATCH', `/api/admin/orders/${first.body.ref}`, { action: 'paid', transactionId: 'MOMO-123' }, admin)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/orders/${second.body.ref}`, { action: 'paid', transactionId: 'momo-123' }, admin)).status, 409);
  assert.equal((await call('PATCH', `/api/admin/orders/${first.body.ref}`, { action: 'paid', transactionId: 'MOMO-456' }, admin)).status, 409);
  assert.equal((await call('PATCH', `/api/admin/orders/${first.body.ref}`, { action: 'ship' }, admin)).status, 200);
  const paid = (await call('GET', '/api/admin/orders', null, admin)).body.find((item) => item.ref === first.body.ref);
  const plan = schedule(new Date(paid.paidAt));
  assert.equal(paid.dispatchDate, plan.dispatch);
  assert.equal(paid.arrivalDate, plan.arrival);
  assert.equal((await call('POST', '/api/track', { ref: first.body.ref, last4: '0004' })).body.arrival, plan.arrival);

  const before = stock(1, 42);
  assert.equal((await call('PATCH', `/api/admin/orders/${second.body.ref}`, { action: 'cancel' }, admin)).status, 200);
  assert.equal(stock(1, 42), before + 1);
  assert.equal((await call('PATCH', `/api/admin/orders/${second.body.ref}`, { action: 'paid', transactionId: 'MOMO-789' }, admin)).status, 409);
});

test('holds start at 30 minutes and can be extended only up to 60', async () => {
  const placed = await call('POST', '/api/orders', order({ phone: '0244000006' }));
  const listed = (await call('GET', '/api/admin/orders', null, admin)).body.find((item) => item.ref === placed.body.ref);
  assert.equal(listed.holdExpires - listed.createdAt, 30 * 60 * 1000);
  const path = `/api/admin/orders/${placed.body.ref}`;
  assert.equal((await call('PATCH', path, { action: 'extend' }, admin)).status, 200);
  assert.equal((await call('PATCH', path, { action: 'extend' }, admin)).status, 200);
  assert.equal((await call('PATCH', path, { action: 'extend' }, admin)).status, 409);
});

test('wholesale orders need ten pairs and use the signed-in phone', async () => {
  const login = await call('POST', '/api/wholesale/login', { phone: '0244000010', accessCode: 'WHOLESALE-DEV' });
  const small = await call('POST', '/api/orders', order({ type: 'wholesale', phone: undefined, items: [{ id: 2, size: 42, qty: 2 }] }), login.jar);
  assert.equal(small.status, 400);
  const items = [{ id: 2, size: 40, qty: 4 }, { id: 2, size: 41, qty: 4 }, { id: 2, size: 42, qty: 2 }];
  const big = await call('POST', '/api/orders', order({ type: 'wholesale', phone: undefined, items }), login.jar);
  assert.equal(big.status, 201);
  assert.equal(big.body.total, 2335);
});

test('settings changes and paid marks are written to the audit log', async () => {
  assert.equal((await call('PATCH', '/api/admin/settings', { rate: 21.5, holidays: ['2026-12-25'] }, admin)).status, 200);
  assert.equal((await call('PATCH', '/api/admin/settings', { rate: 21.5, holidays: ['tomorrow'] }, admin)).status, 400);
  const { body } = await call('GET', '/api/admin/audit', null, admin);
  const actions = body.map((entry) => entry.action);
  assert.ok(actions.includes('settings_updated') && actions.includes('order_paid') && actions.includes('login'));
});

test('state-changing requests without the page token are rejected', async () => {
  const response = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
  const wholesale = await fetch(base + '/wholesale.html');
  assert.doesNotMatch(await wholesale.text(), /WHOLESALE-DEV/);
});

test('a filled honeypot is rejected and does not take stock', async () => {
  const before = stock(1, 42);
  const response = await call('POST', '/api/orders', order({ phone: '0244000007', hp: 'https://spam.example' }));
  assert.equal(response.status, 400);
  assert.equal(stock(1, 42), before);
});

test('admin routes can be limited to an allowlist', async () => {
  process.env.ADMIN_IP_ALLOWLIST = '203.0.113.5';
  try {
    assert.equal((await call('GET', '/api/admin/orders', null, admin)).status, 403);
  } finally {
    delete process.env.ADMIN_IP_ALLOWLIST;
  }
  assert.equal((await call('GET', '/api/admin/orders', null, admin)).status, 200);
});

test('five failed admin sign-ins lock the account', async () => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await call('POST', '/api/admin/login', { email: 'intruder@test.local', password: 'nope', totp: '000000' });
    assert.equal(response.status, 401);
  }
  const locked = await call('POST', '/api/admin/login', { email: 'intruder@test.local', password: 'nope', totp: '000000' });
  assert.equal(locked.status, 429);
});
