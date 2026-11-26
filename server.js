require('dotenv').config();
require('express-async-errors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PRODUCTION = process.env.NODE_ENV === 'production';
const settings = { rate: 21.5, holidays: [] };
const RETAIL_ADD = 100;
const WHOLESALE_ADD = 40;
const MIN_PAIRS = 10;
const HOLD_MINUTES = 30;
const EXTEND_MINUTES = 15;
const MAX_HOLD_MINUTES = 60;
const MAX_OPEN_UNPAID = 2;
const PRODUCT_COLOR_VALUES = {
  Black: '#111', White: '#fff', Grey: '#888', Cream: '#eee5d3', Brown: '#70452f',
  Red: '#c62828', Blue: '#2563a8', Green: '#39734b', Yellow: '#e4b700',
  Orange: '#dc6b25', Pink: '#d77f9f', Purple: '#755296', Metallic: '#aaa',
  Multicolour: 'conic-gradient(#c62828,#e4b700,#39734b,#2563a8,#755296,#c62828)'
};
const PRODUCT_COLORS = new Set(Object.keys(PRODUCT_COLOR_VALUES));
const WA = process.env.WHATSAPP_NUMBER || '233000000000';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const WHOLESALE_CODE = process.env.WHOLESALE_ACCESS_CODE || (PRODUCTION ? null : 'WHOLESALE-DEV');
const memoryMode = process.env.DEV_MEMORY_DB === 'true';
const dbMode = !memoryMode;
const db = dbMode ? require('./db') : null;

if (!memoryMode && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set DEV_MEMORY_DB=true only for local mock development.');
}
if (PRODUCTION) {
  const missing = ['SESSION_SECRET', 'ADMIN_TOTP_SECRET', 'DEV_ADMIN_EMAIL', 'DEV_ADMIN_PASSWORD', 'WHOLESALE_ACCESS_CODE', 'ALLOWED_ORIGIN', 'ADMIN_IP_ALLOWLIST', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
}
if (!process.env.ADMIN_TOTP_SECRET) console.warn('ADMIN_TOTP_SECRET is not set. Admin sign-in is disabled until you add one.');
if (!process.env.SESSION_SECRET || /change-me|replace-with/i.test(process.env.SESSION_SECRET)) console.warn('Set a long random SESSION_SECRET before this shop is reachable from the internet.');

const products = [
  { id: 1, name: 'New Balance 9060', brand: 'New Balance', colorway: 'Grey / White', primary_color: 'Grey', accent_color: 'White', cost_cfa: 12000, sizes: { 41: 2, 42: 3, 43: 1, 44: 0 }, fit: 'Runs small. Most buyers go 2 sizes up.', shift: 2, on_request: false, img: null },
  { id: 2, name: 'Air Force 1 Low', brand: 'Nike', colorway: 'Triple White', primary_color: 'White', accent_color: null, cost_cfa: 9000, sizes: { 40: 4, 41: 4, 42: 5, 43: 3, 44: 2 }, fit: 'True to size.', shift: 0, on_request: false, img: null },
  { id: 3, name: 'Samba OG', brand: 'Adidas', colorway: 'White / Black', primary_color: 'White', accent_color: 'Black', cost_cfa: 10500, sizes: { 40: 1, 41: 2, 42: 2 }, fit: 'True to size.', shift: 0, on_request: false, img: null },
  { id: 4, name: 'Jordan 4 Retro', brand: 'Nike', colorway: 'Black / Red', primary_color: 'Black', accent_color: 'Red', cost_cfa: 21000, sizes: { 42: 1, 43: 1 }, fit: 'True to size.', shift: 0, on_request: true, img: null },
  { id: 5, name: 'Dunk Low', brand: 'Nike', colorway: 'White / Grey', primary_color: 'White', accent_color: 'Grey', cost_cfa: 11000, sizes: { 40: 0, 41: 0, 42: 0 }, fit: null, shift: 0, on_request: false, img: null },
  { id: 6, name: 'GEL-Kayano 14', brand: 'ASICS', colorway: 'Silver / White', primary_color: 'Metallic', accent_color: 'White', cost_cfa: 13500, sizes: { 40: 2, 41: 3, 42: 2, 43: 1 }, fit: 'True to size with a comfortable, roomy toe box.', shift: 0, on_request: false, img: null },
  { id: 7, name: 'Speedcat OG', brand: 'PUMA', colorway: 'Red / White', primary_color: 'Red', accent_color: 'White', cost_cfa: 9500, sizes: { 40: 2, 41: 2, 42: 2, 43: 1 }, fit: 'Slim fit. Consider one size up for wider feet.', shift: 1, on_request: false, img: null },
  { id: 8, name: 'Old Skool', brand: 'Vans', colorway: 'Black / White', primary_color: 'Black', accent_color: 'White', cost_cfa: 8500, sizes: { 40: 2, 41: 3, 42: 2, 43: 1 }, fit: 'True to size.', shift: 0, on_request: false, img: null },
  { id: 9, name: 'XT-6', brand: 'Salomon', colorway: 'Cream / Black', primary_color: 'Cream', accent_color: 'Black', cost_cfa: 17500, sizes: { 41: 1, 42: 2, 43: 2, 44: 1 }, fit: 'True to size with a secure performance fit.', shift: 0, on_request: true, img: null },
  { id: 10, name: 'Air Jordan 1 Low', brand: 'Jordan', colorway: 'White / Black', primary_color: 'White', accent_color: 'Black', cost_cfa: 14500, sizes: { 41: 1, 42: 2, 43: 2, 44: 1 }, fit: 'True to size.', shift: 0, on_request: false, img: null }
];
let nextProductId = products.length + 1;
const orders = [];
const requests = [];
const payments = [];
const auditLog = [];

const pgSession = dbMode ? require('connect-pg-simple')(session) : null;
const sessionStore = dbMode ? new pgSession({ pool: db.getPool(), tableName: 'session', createTableIfMissing: true }) : undefined;

function ms(value) { return value == null ? null : new Date(value).getTime(); }
function dayStr(value) { return value == null ? null : String(value).slice(0, 10); }

function orderWaUrl(order) {
  const text = [
    `Order ${order.ref} (${order.type})`,
    ...(order.items || []).map((line) => `${line.quantity}x ${line.product_name} — ${line.colorway}, size ${line.size}, GHS ${line.unit_price}${line.fit_note ? ` (fit note shown: ${line.fit_note})` : ''}`),
    `Total: GHS ${order.total} (delivery to my address not included)`,
    `Name: ${order.name}`, `Location: ${order.location}`, `Payment: ${order.pay}`
  ].join('\n');
  return `https://wa.me/${WA}?text=${encodeURIComponent(text)}`;
}

async function hydrate() {
  await db.initDb();
  const existing = await db.q(`SELECT COUNT(*)::int AS c FROM products`);
  if (existing.rows[0].c === 0) {
    for (const seed of products) {
      const ins = await db.q(`INSERT INTO products (name, brand, colorway, primary_color, accent_color, cost_cfa, fit, size_shift, on_request) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [seed.name, seed.brand, seed.colorway, seed.primary_color, seed.accent_color, seed.cost_cfa, seed.fit, seed.shift, seed.on_request]);
      const id = Number(ins.rows[0].id);
      for (const [size, quantity] of Object.entries(seed.sizes)) {
        await db.q(`INSERT INTO product_stock (product_id, size, quantity) VALUES ($1,$2,$3)`, [id, Number(size), quantity]);
      }
    }
  }
  const prods = await db.q(`SELECT p.*, COALESCE((SELECT jsonb_object_agg(s.size::text, s.quantity) FROM product_stock s WHERE s.product_id = p.id), '{}'::jsonb) AS sizes FROM products p WHERE p.active ORDER BY p.id`);
  products.length = 0;
  for (const row of prods.rows) {
    products.push({
      id: Number(row.id), dbId: Number(row.id), name: row.name, brand: row.brand, colorway: row.colorway,
      primary_color: row.primary_color, accent_color: row.accent_color, cost_cfa: row.cost_cfa,
      sizes: Object.fromEntries(Object.entries(row.sizes || {}).map(([size, qty]) => [size, Number(qty)])),
      fit: row.fit, shift: row.size_shift, on_request: row.on_request, exclusive: row.exclusive === true,
      img: row.image_data ? `/api/products/${row.id}/image` : (row.image_url || null)
    });
  }
  nextProductId = Math.max(nextProductId, products.reduce((max, p) => Math.max(max, p.id), 0) + 1);

  const ords = await db.q(`SELECT o.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'product_name', i.product_name, 'colorway', i.colorway, 'size', i.size, 'quantity', i.quantity, 'unit_price', i.unit_price, 'fit_note', i.fit_note) ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id), '[]'::jsonb) AS items
    FROM orders o ORDER BY o.id DESC LIMIT 1000`);
  orders.length = 0;
  for (const row of ords.rows.reverse()) {
    const order = {
      ref: row.reference, type: row.type, name: row.name, phone: row.phone, location: row.location,
      pay: row.payment_method, status: row.status, total: Number(row.total), items: row.items || [],
      createdAt: ms(row.created_at), holdExpires: ms(row.hold_expires_at), paidAt: ms(row.paid_at),
      dispatchDate: dayStr(row.dispatch_date), arrivalDate: dayStr(row.arrival_date),
      transactionId: row.transaction_id || null, idempotencyKey: row.idempotency_key, ip: row.ip || null,
      dbId: Number(row.id)
    };
    order.wa_url = orderWaUrl(order);
    orders.push(order);
  }

  const pays = await db.q(`SELECT p.transaction_id, p.recorded_by, p.created_at, o.reference AS order_ref FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.id DESC LIMIT 1000`);
  payments.length = 0;
  for (const row of pays.rows) payments.push({ order_ref: row.order_ref, transaction_id: row.transaction_id, recorded_by: row.recorded_by, created_at: new Date(row.created_at).toISOString() });

  const rate = await db.q(`SELECT value FROM settings WHERE key = 'rate'`);
  if (rate.rows[0]) settings.rate = Number(rate.rows[0].value);
  const hols = await db.q(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM holidays ORDER BY holiday_date`);
  settings.holidays = hols.rows.map((row) => row.d);

  const logs = await db.q(`SELECT actor, action, entity_type, entity_id, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 500`);
  auditLog.length = 0;
  for (const row of logs.rows.reverse()) auditLog.push({ actor: row.actor, action: row.action, entity_type: row.entity_type, entity_id: row.entity_id, metadata: row.metadata, created_at: new Date(row.created_at).toISOString() });
}

async function persistProductStock(productId, sizes) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM product_stock WHERE product_id = $1`, [productId]);
    for (const [size, quantity] of Object.entries(sizes)) {
      await client.query(`INSERT INTO product_stock (product_id, size, quantity) VALUES ($1, $2, $3) ON CONFLICT (product_id, size) DO UPDATE SET quantity = EXCLUDED.quantity`, [productId, Number(size), quantity]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function persistProduct(product) {
  if (product.dbId == null) {
    const ins = await db.q(`INSERT INTO products (name, brand, colorway, primary_color, accent_color, cost_cfa, fit, size_shift, on_request, exclusive) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [product.name, product.brand, product.colorway, product.primary_color, product.accent_color, product.cost_cfa, product.fit, product.shift, product.on_request, product.exclusive === true]);
    product.dbId = Number(ins.rows[0].id);
    product.id = product.dbId;
  } else {
    await db.q(`UPDATE products SET name=$2, brand=$3, colorway=$4, primary_color=$5, accent_color=$6, cost_cfa=$7, fit=$8, size_shift=$9, on_request=$10, exclusive=$11, active=TRUE WHERE id=$1`,
      [product.dbId, product.name, product.brand, product.colorway, product.primary_color, product.accent_color, product.cost_cfa, product.fit, product.shift, product.on_request, product.exclusive === true]);
  }
  await persistProductStock(product.dbId, product.sizes);
  return product.dbId;
}

async function persistProductImage(productId, buffer, mimetype) {
  await db.q(`UPDATE products SET image_data=$2, image_mime=$3, image_url=$4 WHERE id=$1`,
    [productId, buffer, mimetype, `/api/products/${productId}/image`]);
}

async function persistOrderInsert(order) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    for (const line of order.items) {
      const upd = await client.query(`UPDATE product_stock SET quantity = quantity - $1 WHERE product_id = $2 AND size = $3 AND quantity >= $1`, [line.quantity, line.product_id, line.size]);
      if (upd.rowCount === 0) {
        const err = new Error('insufficient');
        err.code = 'INSUFFICIENT_STOCK';
        throw err;
      }
    }
    const ins = await client.query(`INSERT INTO orders (reference, type, name, phone, location, payment_method, status, total, idempotency_key, hold_expires_at, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0),$11) RETURNING id`,
      [order.ref, order.type, order.name, order.phone, order.location, order.pay, order.status, order.total, order.idempotencyKey, order.holdExpires, order.ip]);
    order.dbId = Number(ins.rows[0].id);
    for (const line of order.items) {
      await client.query(`INSERT INTO order_items (order_id, product_id, product_name, colorway, size, quantity, unit_price, fit_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.dbId, line.product_id, line.product_name, line.colorway, line.size, line.quantity, line.unit_price, line.fit_note]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function persistStockDelta(lines, sign) {
  for (const line of lines) {
    await db.q(`UPDATE product_stock SET quantity = quantity + $1 WHERE product_id = $2 AND size = $3`, [sign * line.quantity, line.product_id, line.size]);
  }
}

async function persistOrderState(order) {
  await db.q(`UPDATE orders SET status=$2, hold_expires_at=to_timestamp($3/1000.0), paid_at=$4, transaction_id=$5, dispatch_date=$6, arrival_date=$7, updated_at=now() WHERE id=$1`,
    [order.dbId, order.status, order.holdExpires, order.paidAt ? new Date(order.paidAt).toISOString() : null, order.transactionId || null, order.dispatchDate, order.arrivalDate]);
}

async function persistPayment(order, transactionId, actor) {
  await db.q(`INSERT INTO payments (order_id, transaction_id, recorded_by) VALUES ($1,$2,$3)`, [order.dbId, transactionId, actor]);
}

async function persistSettings(rate, holidays) {
  await db.q(`INSERT INTO settings (key, value) VALUES ('rate', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(rate)]);
  await db.q(`DELETE FROM holidays`);
  for (const date of holidays) await db.q(`INSERT INTO holidays (holiday_date, label) VALUES ($1, '')`, [date]);
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UPLOAD_DIR = path.join(ROOT, 'assets/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => (IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Photos must be JPEG, PNG, or WebP.')))
});

function pricing(costCfa) {
  const costGhs = costCfa / 1000 * settings.rate;
  return {
    retail: Math.ceil((costGhs + RETAIL_ADD) / 10) * 10,
    wholesale: Math.round((costGhs + WHOLESALE_ADD) * 100) / 100
  };
}

function publicProduct(product, wholesale = false) {
  const price = pricing(product.cost_cfa);
  return {
    id: product.id, name: product.name, brand: product.brand, colorway: product.colorway,
    primary_color: product.primary_color, accent_color: product.accent_color, sizes: product.sizes,
    fit: product.fit, shift: product.shift, on_request: product.on_request, img: product.img,
    sold: !Object.values(product.sizes).some((quantity) => quantity > 0),
    exclusive: product.exclusive === true,
    [wholesale ? 'wholesale' : 'retail']: wholesale ? price.wholesale : price.retail
  };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '');
}

function validPhone(phone) {
  return /^(\+?233|0)\d{9}$/.test(normalizePhone(phone));
}

function phoneDigits(phone) {
  const digits = normalizePhone(phone).replace(/\D/g, '');
  return digits.startsWith('0') ? `233${digits.slice(1)}` : digits;
}

function clean(text, max) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function audit(actor, action, entityType, entityId, metadata = {}) {
  const entry = { actor, action, entity_type: entityType, entity_id: entityId == null ? null : String(entityId), metadata, created_at: new Date().toISOString() };
  auditLog.push(entry);
  if (dbMode) db.q(`INSERT INTO audit_logs (actor, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`, [entry.actor, entry.action, entry.entity_type, entry.entity_id, JSON.stringify(entry.metadata)]).catch((error) => console.error('audit write failed:', error.message));
}

function totpCode(secret, time = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(secret || '').toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i += 1) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Math.floor(time / 30000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function validTotp(code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const secret = process.env.ADMIN_TOTP_SECRET;
  if (!secret) return false;
  return [-1, 0, 1].some((window) => totpCode(secret, Date.now() + window * 30000) === code);
}

const loginFailures = new Map();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

function locked(scope, id) {
  const entry = loginFailures.get(`${scope}:${id}`);
  return Boolean(entry && entry.lockedUntil > Date.now());
}

function recordFailure(scope, id) {
  if (!id) return false;
  const key = `${scope}:${id}`;
  const entry = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > Date.now()) return true;
  entry.count += 1;
  entry.lockedUntil = entry.count >= LOCK_AFTER ? Date.now() + LOCK_MS : 0;
  if (entry.lockedUntil) entry.count = 0;
  loginFailures.set(key, entry);
  if (loginFailures.size > 1000) loginFailures.delete(loginFailures.keys().next().value);
  return entry.lockedUntil > Date.now();
}

function clearFailures(scope, id) {
  loginFailures.delete(`${scope}:${id}`);
}

async function humanOk(req) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return !PRODUCTION;
  const token = String(req.body?.turnstileToken || '');
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: req.ip || '' });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function accraParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return { key: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}

function schedule(from = new Date(), holidays = settings.holidays) {
  const blocked = new Set(holidays.map((date) => String(date).slice(0, 10)));
  const { key, hour } = accraParts(from);
  const cursor = new Date(`${key}T12:00:00Z`);
  const canDispatch = (date) => date.getUTCDay() >= 1 && date.getUTCDay() <= 6 && !blocked.has(date.toISOString().slice(0, 10));
  if (!canDispatch(cursor) || hour >= 17) {
    do cursor.setUTCDate(cursor.getUTCDate() + 1); while (!canDispatch(cursor));
  }
  const dispatch = cursor.toISOString().slice(0, 10);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (blocked.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() + 1);
  return { dispatch, arrival: cursor.toISOString().slice(0, 10) };
}

function nextArrival(from = new Date(), holidays = settings.holidays) {
  return new Date(`${schedule(from, holidays).arrival}T12:00:00Z`);
}

function restock(order) {
  for (const line of order.items) {
    const product = products.find((candidate) => candidate.id === line.product_id);
    if (product) product.sizes[line.size] = (product.sizes[line.size] || 0) + line.quantity;
  }
  if (dbMode && order.dbId != null) {
    persistStockDelta(order.items, 1)
      .then(() => persistOrderState(order))
      .catch((error) => console.error(`restock persist failed for ${order.ref}:`, error.message));
  }
}

function expireHolds(now = Date.now()) {
  for (const order of orders) {
    if (order.status === 'awaiting_payment' && order.holdExpires <= now) {
      order.status = 'expired';
      restock(order);
    }
  }
}

const holdTimer = setInterval(() => expireHolds(), 30 * 1000);
holdTimer.unref();

function adminOrder(order) {
  const { idempotencyKey, wa_url, ip, dbId, ...rest } = order;
  return rest;
}

function parseProductBody(body) {
  const { name, brand, colorway, primaryColor, accentColor, costCfa, fit, shift } = body || {};
  let { sizes } = body || {};
  if (typeof sizes === 'string') {
    try { sizes = JSON.parse(sizes); } catch { sizes = null; }
  }
  if (!clean(name, 100) || !clean(brand, 60) || !clean(colorway, 80) || !Number.isInteger(Number(costCfa)) || Number(costCfa) <= 0 || !sizes || typeof sizes !== 'object') {
    return { error: 'Name, brand, colourway, CFA cost, and stock sizes are required.' };
  }
  if (!PRODUCT_COLORS.has(primaryColor)) return { error: 'Choose a valid primary colour.' };
  if (accentColor && !PRODUCT_COLORS.has(accentColor)) return { error: 'Choose a valid accent colour.' };
  if (accentColor && accentColor === primaryColor) return { error: 'Accent colour must be different from the primary colour.' };
  const normalizedSizes = Object.fromEntries(Object.entries(sizes).filter(([size, quantity]) => /^\d+$/.test(size) && Number(size) >= 30 && Number(size) <= 55 && Number.isInteger(Number(quantity)) && Number(quantity) >= 0).map(([size, quantity]) => [size, Number(quantity)]));
  if (!Object.keys(normalizedSizes).length) return { error: 'Add at least one valid size (EU 30 to 55) and stock quantity.' };
  const shiftNumber = Number(shift);
  return {
    fields: {
      name: clean(name, 100), brand: clean(brand, 60), colorway: clean(colorway, 80),
      primary_color: primaryColor, accent_color: accentColor || null, cost_cfa: Number(costCfa), sizes: normalizedSizes,
      fit: clean(fit, 160) || null, shift: Number.isInteger(shiftNumber) && shiftNumber >= 0 && shiftNumber <= 5 ? shiftNumber : 0,
      on_request: body.onRequest === true || body.onRequest === 'true',
      exclusive: body.exclusive === true || body.exclusive === 'true'
    }
  };
}

async function hasImageSignature(filePath, mimetype) {
  const header = Buffer.alloc(12);
  const handle = await fs.promises.open(filePath, 'r');
  try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
  if (mimetype === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimetype === 'image/png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
}

function removeUpload(file) {
  if (file) fs.rm(file.path, { force: true }, () => {});
}

async function removeProductImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('assets/uploads/')) return Promise.resolve();
  const filePath = path.join(UPLOAD_DIR, path.basename(imageUrl));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) {
        console.error(`Could not remove product image ${path.basename(filePath)}:`, error.message);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function normalizeImage(file) {
  const outputName = `${crypto.randomUUID()}.webp`;
  const outputPath = path.join(UPLOAD_DIR, outputName);
  try {
    await sharp(file.path, {
      failOn: 'warning',
      limitInputPixels: 40_000_000,
      sequentialRead: true
    })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4, smartSubsample: true })
      .toFile(outputPath);
    await fs.promises.rm(file.path, { force: true });
    file.filename = outputName;
    file.path = outputPath;
    file.mimetype = 'image/webp';
  } catch {
    await Promise.allSettled([
      fs.promises.rm(file.path, { force: true }),
      fs.promises.rm(outputPath, { force: true })
    ]);
    throw new Error('The photo could not be processed. Try another JPEG, PNG, or WebP image.');
  }
}

function imageUpload(req, res, next) {
  upload.single('image')(req, res, async (error) => {
    if (error) {
      removeUpload(req.file);
      return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Photos must be 5 MB or smaller.' : error.message });
    }
    try {
      if (req.file && !(await hasImageSignature(req.file.path, req.file.mimetype))) {
        removeUpload(req.file);
        return res.status(400).json({ error: 'That file is not a valid JPEG, PNG, or WebP image.' });
      }
      if (req.file) await normalizeImage(req.file);
      next();
    } catch (processingError) {
      res.status(400).json({ error: processingError.message });
    }
  });
}

function genericError(res) {
  return res.status(400).json({ error: 'We could not find that order. Check the reference and phone digits.' });
}

function adminOnly(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: 'Admin sign-in required.' });
  next();
}

const limiter = (limit, windowMinutes = 15) => rateLimit({ windowMs: windowMinutes * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait a few minutes and try again.' } });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const csrfCookie = { httpOnly: false, sameSite: 'strict', secure: PRODUCTION, maxAge: 30 * 60 * 1000, path: '/' };
const LOCKED = { error: 'Too many attempts. Try again in 15 minutes.' };

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
      frameSrc: ['https://challenges.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'baron.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'local-development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: PRODUCTION, maxAge: 30 * 60 * 1000 }
}));
app.use((req, res, next) => {
  if (req.path.startsWith('/assets')) return next();
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.cookie('baron.csrf', req.session.csrf, csrfCookie);
  next();
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && ALLOWED_ORIGIN) {
    const origin = req.get('origin');
    const host = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== ALLOWED_ORIGIN && origin !== host) return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(String(req.get('x-csrf-token') || ''), req.session.csrf || '')) {
    return res.status(403).json({ error: 'Reload the page and try again.' });
  }
  next();
});
app.use('/api/admin', (req, res, next) => {
  const allow = (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!allow.length) return next();
  const clientIp = String(req.headers['cf-connecting-ip'] || req.ip || '').replace(/^::ffff:/, '');
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (allow.includes(clientIp) || allow.includes(req.ip) || allow.includes(ip)) return next();
  console.log(`admin_blocked ip=${req.ip} cf=${req.headers['cf-connecting-ip'] || ''} xff=${req.headers['x-forwarded-for'] || ''} allow=${allow.join('|')}`);
  return res.status(403).json({ error: 'Admin access is not available from this network.' });
});
app.use('/api/track', limiter(20));
app.use('/api/admin/login', limiter(20));
app.use('/api/wholesale/login', limiter(20));
app.post('/api/orders', limiter(30));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { dotfiles: 'deny' }));
for (const page of ['index', 'wholesale', 'track', 'admin']) {
  app.get(`/${page}.html`, (req, res) => res.sendFile(path.join(ROOT, `${page}.html`)));
}

app.get('/api/products', (req, res) => res.json(products.map((product) => publicProduct(product))));

app.get('/api/catalogue-options', (req, res) => {
  res.json({ colors: Object.entries(PRODUCT_COLOR_VALUES).map(([name, value]) => ({ name, value })) });
});

app.get('/api/security', (req, res) => {
  const siteKey = process.env.TURNSTILE_SITE_KEY || '';
  res.json({ turnstileSiteKey: siteKey && process.env.TURNSTILE_SECRET_KEY ? siteKey : '' });
});

app.get('/api/arrival', (req, res) => res.json({ arrival: nextArrival() }));

app.get('/api/wholesale/products', (req, res) => {
  if (!req.session.wholesale) return res.status(403).json({ error: 'Approved wholesale access is required.' });
  res.json(products.filter((product) => Object.values(product.sizes).some((quantity) => quantity > 0)).map((product) => publicProduct(product, true)));
});

function resumeSession(req, res, next, setup) {
  const csrf = req.session.csrf;
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.csrf = csrf;
    res.cookie('baron.csrf', csrf, csrfCookie);
    setup();
  });
}

app.post('/api/wholesale/login', async (req, res, next) => {
  const phone = normalizePhone(req.body?.phone);
  if (req.body?.hp) return res.status(401).json({ error: 'Wholesale sign-in details are not valid.' });
  if (locked('wholesale-ip', req.ip) || locked('wholesale-phone', phone)) return res.status(429).json(LOCKED);
  if (!(await humanOk(req))) return res.status(400).json({ error: 'Could not verify this request. Please try again.' });
  if (!validPhone(phone) || !WHOLESALE_CODE || !safeEqual(req.body?.accessCode || '', WHOLESALE_CODE)) {
    const tripped = recordFailure('wholesale-ip', req.ip) || recordFailure('wholesale-phone', phone);
    return res.status(tripped ? 429 : 401).json(tripped ? LOCKED : { error: 'Wholesale sign-in details are not valid.' });
  }
  clearFailures('wholesale-ip', req.ip);
  clearFailures('wholesale-phone', phone);
  resumeSession(req, res, next, () => {
    req.session.wholesale = true;
    req.session.wholesalePhone = phone;
    res.json({ ok: true });
  });
});

app.post('/api/orders', async (req, res) => {
  if (!(await humanOk(req))) return res.status(400).json({ error: 'Could not verify this request. Please try again.' });
  const { type = 'retail', items, pay, accepted, hp, idempotencyKey } = req.body || {};
  const phone = type === 'wholesale' ? req.session.wholesalePhone : normalizePhone(req.body?.phone);
  const name = clean(req.body?.name, 80);
  const location = clean(req.body?.location, 120);
  if (hp || accepted !== true || !name || !location || !validPhone(phone) || !['MoMo', 'Bank transfer'].includes(pay)) {
    return res.status(400).json({ error: 'Complete the required order details.' });
  }
  if (!['retail', 'wholesale'].includes(type) || !Array.isArray(items) || !items.length || items.length > 50 || (type === 'wholesale' && !req.session.wholesale)) {
    return res.status(400).json({ error: 'This order is not valid.' });
  }
  if (!idempotencyKey || !/^[a-f0-9-]{16,64}$/i.test(idempotencyKey)) return res.status(400).json({ error: 'A valid order key is required.' });
  const existing = orders.find((order) => order.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ ref: existing.ref, total: existing.total, wa_url: existing.wa_url });

  expireHolds();
  const openUnpaid = orders.filter((order) => order.status === 'awaiting_payment' && (phoneDigits(order.phone) === phoneDigits(phone) || order.ip === req.ip));
  if (openUnpaid.length >= MAX_OPEN_UNPAID) {
    return res.status(429).json({ error: 'You already have unpaid orders open. Pay or wait for them to expire before ordering again.' });
  }

  const requested = new Map();
  for (const item of items) {
    const product = products.find((candidate) => candidate.id === Number(item?.id));
    const size = Number(item?.size);
    const quantity = Number(item?.qty);
    if (!product || !Number.isInteger(size) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return res.status(400).json({ error: 'This order is not valid.' });
    }
    const key = `${product.id}:${size}`;
    const line = requested.get(key) || { product, size, quantity: 0 };
    line.quantity += quantity;
    requested.set(key, line);
  }

  const lines = [];
  let total = 0;
  let pairCount = 0;
  for (const { product, size, quantity } of requested.values()) {
    if ((product.sizes[size] || 0) < quantity) {
      return res.status(409).json({ error: `Size ${size} is no longer available for ${product.name}.` });
    }
    const unitPrice = pricing(product.cost_cfa)[type];
    total += unitPrice * quantity;
    pairCount += quantity;
    const fitNote = [product.fit, product.shift ? `Buyer ordered EU ${size} after the size warning. The ordered size was kept.` : ''].filter(Boolean).join(' ') || null;
    lines.push({ product_id: product.id, product_name: product.name, colorway: product.colorway, size, quantity, unit_price: unitPrice, fit_note: fitNote });
  }
  total = Math.round(total * 100) / 100;
  if (type === 'wholesale' && pairCount < MIN_PAIRS) return res.status(400).json({ error: `Wholesale orders require at least ${MIN_PAIRS} pairs.` });

  const ref = `BRN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const createdAt = Date.now();
  const order = {
    ref, type, name, phone, location, pay, status: 'awaiting_payment', total, items: lines,
    createdAt, holdExpires: createdAt + HOLD_MINUTES * 60 * 1000, paidAt: null, dispatchDate: null, arrivalDate: null,
    idempotencyKey, ip: req.ip
  };
  order.wa_url = orderWaUrl(order);
  if (dbMode) {
    try {
      await persistOrderInsert(order);
    } catch (error) {
      if (error.code === 'INSUFFICIENT_STOCK' || error.code === '23505') {
        return res.status(409).json({ error: 'One of those sizes just sold out. Please review your bag.' });
      }
      throw error;
    }
  }
  for (const line of lines) products.find((product) => product.id === line.product_id).sizes[line.size] -= line.quantity;
  orders.push(order);
  res.status(201).json({ ref, total, wa_url: order.wa_url });
});

app.post('/api/requests', limiter(10), async (req, res) => {
  if (!(await humanOk(req))) return res.status(400).json({ error: 'Could not verify this request. Please try again.' });
  const { item, brand, sizeWanted, pictureUrl, name, phone, notes, hp } = req.body || {};
  if (hp) return res.status(400).json({ error: 'That request could not be submitted.' });
  const cleanItem = clean(item, 120);
  const cleanName = clean(name, 80);
  const cleanPhone = normalizePhone(phone);
  if (!cleanItem || !cleanName || !validPhone(cleanPhone)) {
    return res.status(400).json({ error: 'Product name, your name, and a valid phone number are required.' });
  }
  let picture = clean(pictureUrl, 500) || null;
  if (picture) {
    try {
      const url = new URL(picture);
      if (!['http:', 'https:'].includes(url.protocol)) picture = null;
    } catch { picture = null; }
  }
  const request = {
    ref: `REQ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    item: cleanItem, brand: clean(brand, 80) || null, size_wanted: clean(sizeWanted, 40) || null,
    picture_url: picture, name: cleanName, phone: cleanPhone, notes: clean(notes, 300) || null,
    ip: req.ip, createdAt: Date.now()
  };
  const lines = [
    `Product request ${request.ref}`,
    `Item: ${request.item}`,
    ...(request.brand ? [`Brand/model: ${request.brand}`] : []),
    ...(request.size_wanted ? [`Size wanted: ${request.size_wanted}`] : []),
    ...(request.picture_url ? [`Picture: ${request.picture_url}`] : []),
    `Name: ${request.name}`, `Phone: ${request.phone}`,
    ...(request.notes ? [`Notes: ${request.notes}`] : [])
  ];
  request.wa_url = `https://wa.me/${WA}?text=${encodeURIComponent(lines.join('\n'))}`;
  requests.push(request);
  if (dbMode) {
    await db.q(`INSERT INTO product_requests (item, brand, size_wanted, picture_url, name, phone, notes, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [request.item, request.brand, request.size_wanted, request.picture_url, request.name, request.phone, request.notes, request.ip]);
  }
  res.status(201).json({ ref: request.ref, wa_url: request.wa_url });
});

app.post('/api/track', async (req, res) => {
  if (!(await humanOk(req))) return res.status(400).json({ error: 'Could not verify this request. Please try again.' });
  expireHolds();
  const ref = String(req.body?.ref || '').toUpperCase();
  const last4 = String(req.body?.last4 || '');
  const order = orders.find((candidate) => candidate.ref === ref && candidate.phone.replace(/\D/g, '').slice(-4) === last4);
  if (!order) return genericError(res);
  const stage = { awaiting_payment: 0, paid: 1, sent_to_warehouse: 2, arrived_at_tudu: 3, delivered: 4 }[order.status];
  res.json({ status: order.status, stage: stage ?? null, arrival: order.paidAt ? order.arrivalDate : null });
});

app.post('/api/admin/login', async (req, res, next) => {
  const email = String(req.body?.email || '');
  const emailKey = email.toLowerCase();
  const password = String(req.body?.password || '');
  const expectedEmail = process.env.DEV_ADMIN_EMAIL || '';
  const expectedPassword = process.env.DEV_ADMIN_PASSWORD || '';
  if (req.body?.hp) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (locked('admin-ip', req.ip) || locked('admin-email', emailKey)) return res.status(429).json(LOCKED);
  if (!(await humanOk(req))) return res.status(400).json({ error: 'Could not verify this request. Please try again.' });
  const passwordOk = expectedEmail && expectedPassword && safeEqual(email, expectedEmail) && safeEqual(password, expectedPassword);
  if (!passwordOk || !validTotp(req.body?.totp)) {
    const tripped = recordFailure('admin-ip', req.ip) || recordFailure('admin-email', emailKey);
    audit(clean(email, 120) || 'unknown', passwordOk ? 'login_failed_mfa' : 'login_failed', 'admin', null, { ip: req.ip });
    return res.status(tripped ? 429 : 401).json(tripped ? LOCKED : { error: passwordOk ? 'The six-digit MFA code is not valid.' : 'Email or password is incorrect.' });
  }
  clearFailures('admin-ip', req.ip);
  clearFailures('admin-email', emailKey);
  resumeSession(req, res, next, () => {
    req.session.admin = email;
    audit(email, 'login', 'admin', null, { ip: req.ip });
    res.json({ ok: true });
  });
});

app.post('/api/admin/logout', adminOnly, (req, res) => {
  req.session.destroy(() => res.clearCookie('baron.sid').clearCookie('baron.csrf').json({ ok: true }));
});

app.get('/api/admin/orders', adminOnly, (req, res) => {
  expireHolds();
  res.json(orders.map(adminOrder));
});

app.get('/api/admin/audit', adminOnly, (req, res) => res.json(auditLog.slice(-200).reverse()));

app.get('/api/admin/settings', adminOnly, (req, res) => res.json({ rate: settings.rate, holidays: settings.holidays }));

app.patch('/api/admin/settings', adminOnly, async (req, res) => {
  const rate = Number(req.body?.rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
    return res.status(400).json({ error: 'Rate must be a number greater than 0 and no more than 1000.' });
  }
  const holidays = req.body?.holidays ?? settings.holidays;
  if (!Array.isArray(holidays) || holidays.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
    return res.status(400).json({ error: 'Holidays must be dates in YYYY-MM-DD format.' });
  }
  const previous = { rate: settings.rate, holidays: settings.holidays };
  settings.rate = Math.round(rate * 10000) / 10000;
  settings.holidays = [...new Set(holidays)].sort();
  if (dbMode) await persistSettings(settings.rate, settings.holidays);
  audit(req.session.admin, 'settings_updated', 'settings', null, { previous, current: { rate: settings.rate, holidays: settings.holidays } });
  res.json({ rate: settings.rate, holidays: settings.holidays });
});

app.post('/api/admin/products', adminOnly, imageUpload, async (req, res) => {
  const { error, fields } = parseProductBody(req.body);
  if (error) {
    removeUpload(req.file);
    return res.status(400).json({ error });
  }
  const product = { id: null, dbId: null, ...fields, img: null };
  if (dbMode) {
    product.dbId = await persistProduct(product);
    product.id = product.dbId;
  } else {
    product.id = nextProductId++;
  }
  if (req.file) {
    if (dbMode) {
      const buffer = await fs.promises.readFile(req.file.path);
      await persistProductImage(product.dbId, buffer, 'image/webp');
      product.img = `/api/products/${product.dbId}/image`;
      await fs.promises.rm(req.file.path, { force: true });
    } else {
      product.img = `assets/uploads/${req.file.filename}`;
    }
  }
  products.push(product);
  audit(req.session.admin, 'product_created', 'product', product.id, { name: product.name, cost_cfa: product.cost_cfa });
  res.status(201).json(publicProduct(product));
});

app.get('/api/admin/products', adminOnly, (req, res) => {
  res.json(products.map((product) => ({ ...publicProduct(product), cost_cfa: product.cost_cfa })));
});

app.patch('/api/admin/products/:id', adminOnly, imageUpload, async (req, res) => {
  const product = products.find((item) => item.id === Number(req.params.id));
  if (!product) {
    removeUpload(req.file);
    return res.status(404).json({ error: 'Sneaker not found.' });
  }
  const { error, fields } = parseProductBody(req.body);
  if (error) {
    removeUpload(req.file);
    return res.status(400).json({ error });
  }
  const previousCost = product.cost_cfa;
  const previousImage = product.img;
  Object.assign(product, fields);
  if (dbMode) {
    product.dbId = product.dbId ?? product.id;
    await persistProduct(product);
    product.id = product.dbId;
  }
  if (req.file) {
    if (dbMode) {
      const buffer = await fs.promises.readFile(req.file.path);
      await persistProductImage(product.dbId, buffer, 'image/webp');
      product.img = `/api/products/${product.dbId}/image`;
      await fs.promises.rm(req.file.path, { force: true });
    } else {
      product.img = `assets/uploads/${req.file.filename}`;
      await removeProductImage(previousImage);
    }
  }
  audit(req.session.admin, 'product_updated', 'product', product.id, { name: product.name, previous_cost_cfa: previousCost, cost_cfa: product.cost_cfa });
  res.json(publicProduct(product));
});

app.delete('/api/admin/products/:id', adminOnly, async (req, res) => {
  const productIndex = products.findIndex((product) => product.id === Number(req.params.id));
  if (productIndex < 0) return res.status(404).json({ error: 'Sneaker not found.' });
  const [removed] = products.splice(productIndex, 1);
  if (dbMode) {
    await db.q(`UPDATE products SET active = FALSE WHERE id = $1`, [removed.dbId ?? removed.id]);
  } else {
    await removeProductImage(removed.img);
  }
  audit(req.session.admin, 'product_deleted', 'product', removed.id, { name: removed.name });
  res.json({ ok: true, id: removed.id });
});

app.get('/api/products/:id/image', async (req, res) => {
  if (!dbMode) return res.status(404).end();
  const result = await db.q(`SELECT image_data, image_mime FROM products WHERE id = $1`, [Number(req.params.id)]);
  if (!result.rows[0] || !result.rows[0].image_data) return res.status(404).end();
  res.type(result.rows[0].image_mime || 'image/webp').send(result.rows[0].image_data);
});

app.patch('/api/admin/orders/:ref', adminOnly, async (req, res) => {
  expireHolds();
  const order = orders.find((candidate) => candidate.ref === req.params.ref);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const action = req.body?.action;
  const previous = order.status;
  if (action === 'paid' && order.status === 'awaiting_payment') {
    const transactionId = clean(req.body.transactionId, 80);
    if (!transactionId || payments.some((payment) => payment.transaction_id.toLowerCase() === transactionId.toLowerCase())) {
      return res.status(409).json({ error: 'A unique transaction ID is required.' });
    }
    payments.push({ order_ref: order.ref, transaction_id: transactionId, recorded_by: req.session.admin, created_at: new Date().toISOString() });
    order.status = 'paid';
    order.paidAt = Date.now();
    order.transactionId = transactionId;
    const plan = schedule(new Date(order.paidAt));
    order.dispatchDate = plan.dispatch;
    order.arrivalDate = plan.arrival;
  } else if (action === 'extend' && order.status === 'awaiting_payment') {
    const limit = order.createdAt + MAX_HOLD_MINUTES * 60 * 1000;
    if (order.holdExpires >= limit) return res.status(409).json({ error: `Holds cannot run longer than ${MAX_HOLD_MINUTES} minutes.` });
    order.holdExpires = Math.min(order.holdExpires + EXTEND_MINUTES * 60 * 1000, limit);
  } else if (action === 'ship' && order.status === 'paid') order.status = 'sent_to_warehouse';
  else if (action === 'arrive' && order.status === 'sent_to_warehouse') order.status = 'arrived_at_tudu';
  else if (action === 'deliver' && order.status === 'arrived_at_tudu') order.status = 'delivered';
  else if (action === 'cancel' && ['awaiting_payment', 'paid', 'sent_to_warehouse'].includes(order.status)) {
    if (['awaiting_payment', 'paid'].includes(order.status)) restock(order);
    order.status = 'cancelled';
  } else return res.status(409).json({ error: 'That status change is not allowed.' });
  audit(req.session.admin, `order_${action}`, 'order', order.ref, { previous, status: order.status, transaction_id: order.transactionId });
  if (dbMode && order.dbId != null) {
    if (action === 'paid') await persistPayment(order, order.transactionId, req.session.admin);
    await persistOrderState(order);
  }
  res.json({ ok: true, status: order.status, holdExpires: order.holdExpires });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function main() {
  if (dbMode) await hydrate();
  app.listen(PORT, () => console.log(`Baron Sneakers running at http://localhost:${PORT}`));
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { app, pricing, validPhone, nextArrival, schedule, expireHolds, totpCode, settings, products, orders };
