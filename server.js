'use strict';
try { require('dotenv').config(); } catch (e) { /* dotenv opsional */ }
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo');

// ============================================================
// KONFIGURASI (semua lewat env di production)
// ============================================================
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const MAX_FREE_SESSIONS = Number(process.env.MAX_FREE_SESSIONS) || 2;
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 4;

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'snapbooth';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

if (IS_PROD && !SESSION_SECRET) {
  console.error('[fatal] SESSION_SECRET wajib di-set di production.');
  process.exit(1);
}
if (IS_PROD && !MONGODB_URI) {
  console.error('[fatal] MONGODB_URI wajib di-set di production.');
  process.exit(1);
}

const SAVE_DIR = process.env.SAVE_DIR
  ? path.resolve(process.env.SAVE_DIR)
  : path.join(__dirname, 'saved');
fs.mkdirSync(SAVE_DIR, { recursive: true });

// ---------- Catalog (frames drawn client-side by id) ----------
const FRAMES = [
  { id: 'classic', name: 'Classic White', premium: false },
  { id: 'noir',    name: 'Noir',          premium: false },
  { id: 'sunset',  name: 'Sunset Glow',   premium: true  },
  { id: 'gold',    name: 'Golden Luxe',   premium: true  },
  { id: 'koran',   name: 'Koran Retro',   premium: false },
];

// ---------- Harga token (Rupiah) ----------
const BASE_TOKEN_PRICE = 5000;
const MAX_TOKEN_QTY = 100;
const PRICE_TIERS = [
  { minQty: 1,  unitPrice: 5000 },
  { minQty: 3,  unitPrice: 4500 },
  { minQty: 5,  unitPrice: 4000 },
  { minQty: 10, unitPrice: 3500 },
];
const PACKAGE_QUANTITIES = [1, 3, 5, 10];

function calculateTokenPrice(quantity) {
  const q = Number(quantity);
  if (!Number.isInteger(q) || q < 1 || q > MAX_TOKEN_QTY) {
    throw new Error(`Jumlah token harus bilangan bulat 1-${MAX_TOKEN_QTY}.`);
  }
  let tier = PRICE_TIERS[0];
  for (const t of PRICE_TIERS) if (q >= t.minQty) tier = t;
  const baseTotal = q * BASE_TOKEN_PRICE;
  const total = q * tier.unitPrice;
  return {
    quantity: q,
    unitPrice: tier.unitPrice,
    baseTotal,
    total,
    saved: baseTotal - total,
    discountPercent: Math.round((1 - tier.unitPrice / BASE_TOKEN_PRICE) * 100),
  };
}

// ---------- Midtrans ----------
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || '';
const MIDTRANS_IS_PRODUCTION = String(process.env.MIDTRANS_IS_PRODUCTION || '').toLowerCase() === 'true';
const PAYMENT_MODE = MIDTRANS_SERVER_KEY && MIDTRANS_CLIENT_KEY ? 'midtrans' : 'mock';
const SNAP_API = MIDTRANS_IS_PRODUCTION
  ? 'https://app.midtrans.com/snap/v1/transactions'
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
const CORE_API = MIDTRANS_IS_PRODUCTION
  ? 'https://api.midtrans.com/v2'
  : 'https://api.sandbox.midtrans.com/v2';
const SNAP_JS_URL = MIDTRANS_IS_PRODUCTION
  ? 'https://app.midtrans.com/snap/snap.js'
  : 'https://app.sandbox.midtrans.com/snap/snap.js';
const MIDTRANS_AUTH = MIDTRANS_SERVER_KEY
  ? 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64')
  : '';

if (IS_PROD && PAYMENT_MODE === 'mock') {
  console.warn('[warn] Produksi berjalan di MODE DEMO — set MIDTRANS_SERVER_KEY & MIDTRANS_CLIENT_KEY!');
}

// ---------- In-memory cache ----------
const users = new Map();
const usersById = new Map();
const orders = new Map();
const orderTimestamps = new Map(); // untuk TTL
const ORDER_TTL_MS = 24 * 3600 * 1000;

// ---------- MongoDB ----------
let usersCol = null;
let ordersCol = null;
let mongoClient = null;

function persistUser(u) {
  if (!usersCol) return;
  usersCol.updateOne(
    { _id: u.id },
    { $set: {
        username: u.username,
        usernameLower: u.username.toLowerCase(),
        salt: u.salt,
        hash: u.hash.toString('hex'),
        tokens: u.tokens,
        freeUsed: u.freeUsed,
    } },
    { upsert: true },
  ).catch((e) => console.error('[db] gagal simpan user:', e.message));
}

function persistOrder(o) {
  if (!ordersCol) return;
  const now = new Date();
  orderTimestamps.set(o.orderId, now.getTime());
  ordersCol.updateOne(
    { _id: o.orderId },
    { $set: {
        userId: o.userId,
        quantity: o.quantity,
        amount: o.amount,
        status: o.status,
        credited: o.credited,
        updatedAt: now,
    }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  ).catch((e) => console.error('[db] gagal simpan order:', e.message));
}

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.warn('[db] MONGODB_URI kosong -> data HANYA di memori (hilang saat restart).');
    return;
  }
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  usersCol = db.collection('users');
  ordersCol = db.collection('orders');
  await usersCol.createIndex({ usernameLower: 1 }, { unique: true });
  await ordersCol.createIndex({ credited: 1, userId: 1 });

  for (const d of await usersCol.find({}).toArray()) {
    const u = {
      id: d._id,
      username: d.username,
      salt: d.salt,
      hash: Buffer.from(d.hash, 'hex'),
      tokens: d.tokens || 0,
      freeUsed: d.freeUsed || 0,
    };
    users.set(u.username.toLowerCase(), u);
    usersById.set(u.id, u);
  }
  // Load order belum credited, plus yang baru (< TTL) untuk verifikasi
  const cutoff = new Date(Date.now() - ORDER_TTL_MS);
  for (const d of await ordersCol.find({ updatedAt: { $gte: cutoff } }).toArray()) {
    orders.set(d._id, {
      orderId: d._id,
      userId: d.userId,
      quantity: d.quantity,
      amount: d.amount,
      status: d.status,
      credited: !!d.credited,
    });
    orderTimestamps.set(d._id, (d.updatedAt || new Date()).getTime());
  }
  console.log(`[db] Terhubung ke MongoDB "${MONGODB_DB}" (${users.size} user, ${orders.size} order dimuat).`);
}

// ---------- Helpers ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);

function safeCompare(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const canStart = (u) => u.tokens > 0 || u.freeUsed < MAX_FREE_SESSIONS;
const publicUser = (u) => ({
  username: u.username,
  tokens: u.tokens,
  freeUsed: u.freeUsed,
  maxFree: MAX_FREE_SESSIONS,
  freeLeft: Math.max(0, MAX_FREE_SESSIONS - u.freeUsed),
  canStart: canStart(u),
});

// ---------- App setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.set('trust proxy', 1); // di balik nginx/heroku/railway

const sessionMiddleware = session({
  name: 'snapbooth.sid',
  secret: SESSION_SECRET || 'snapbooth-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MONGODB_URI
    ? MongoStore.create({
        mongoUrl: MONGODB_URI,
        dbName: MONGODB_DB,
        collectionName: 'sessions',
        ttl: 7 * 24 * 3600,
        autoRemove: 'native',
      })
    : undefined,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 3600 * 1000,
  },
});

app.use(express.json({ limit: '25mb' }));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PROD ? '7d' : 0,
  etag: true,
}));

// ---------- Rate limiter (sederhana, in-memory) ----------
const rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}
function rateLimitMw(prefix, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(`${prefix}:${ip}`, max, windowMs)) {
      return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    }
    next();
  };
}

// ---------- Auth helpers ----------
const getUser = (req) => (req.session && req.session.userId ? usersById.get(req.session.userId) : null);
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.user = u;
  next();
}

// ---------- Auth routes ----------
app.post('/api/register', rateLimitMw('register', 10, 60_000), (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscore.' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  if (users.has(username.toLowerCase()))
    return res.status(409).json({ error: 'Username already taken.' });

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(6).toString('hex'),
    username,
    salt,
    hash: hashPw(password, salt),
    tokens: 0,
    freeUsed: 0,
  };
  users.set(username.toLowerCase(), user);
  usersById.set(user.id, user);
  persistUser(user);
  req.session.userId = user.id;
  req.session.booth = null;
  res.json({ user: publicUser(user) });
});

app.post('/api/login', rateLimitMw('login', 20, 60_000), (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const user = users.get(username.toLowerCase());
  const ok = user && safeCompare(hashPw(password, user.salt), user.hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
  req.session.userId = user.id;
  req.session.booth = null;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/frames', requireAuth, (req, res) => res.json({ frames: FRAMES }));

// ---------- Health check (untuk load balancer) ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: !!usersCol,
    mode: PAYMENT_MODE,
    uptime: process.uptime(),
  });
});

// ---------- Token pricing ----------
app.get('/api/token-pricing', requireAuth, (req, res) => {
  res.json({
    basePrice: BASE_TOKEN_PRICE,
    maxQty: MAX_TOKEN_QTY,
    tiers: PRICE_TIERS,
    packages: PACKAGE_QUANTITIES,
    mode: PAYMENT_MODE,
  });
});

// ============================================================
// PEMBAYARAN
// ============================================================
const PAID_STATUSES = ['PAID', 'SETTLED'];

/**
 * Idempoten: tambahkan token SEKALI SAJA.
 * Menggunakan atomic claim di Mongo untuk mencegah race condition
 * antar multiple webhook / instance.
 */
async function fulfillOrder(order) {
  if (order.credited || !PAID_STATUSES.includes(order.status)) return false;
  const user = usersById.get(order.userId);
  if (!user) return false;

  // Atomic claim jika DB tersedia
  if (ordersCol) {
    try {
      const r = await ordersCol.findOneAndUpdate(
        { _id: order.orderId, credited: { $ne: true } },
        { $set: { credited: true, status: order.status, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!r) return false; // sudah di-claim proses lain
    } catch (e) {
      console.error('[db] claim order gagal:', e.message);
      return false;
    }
  }

  order.credited = true;
  user.tokens += order.quantity;
  persistUser(user);
  persistOrder(order);
  io.to('user:' + user.id).emit('payment-success', {
    orderId: order.orderId,
    tokens: order.quantity,
    user: publicUser(user),
  });
  return true;
}

function applyMidtransStatus(order, txStatus, fraudStatus) {
  if (order.credited) return;
  if (txStatus === 'settlement' || (txStatus === 'capture' && (fraudStatus || 'accept') === 'accept')) {
    order.status = 'SETTLED';
  } else if (['deny', 'cancel', 'failure'].includes(txStatus)) {
    order.status = 'FAILED';
  } else if (txStatus === 'expire') {
    order.status = 'EXPIRED';
  } else {
    order.status = 'PENDING';
  }
  persistOrder(order);
  fulfillOrder(order);
}

async function createPaymentTransaction(user, tokenQuantity) {
  const price = calculateTokenPrice(tokenQuantity);
  const orderId = `SB-${user.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const order = {
    orderId,
    userId: user.id,
    quantity: price.quantity,
    amount: price.total,
    status: 'PENDING',
    credited: false,
  };
  const result = { ok: true, orderId, mode: PAYMENT_MODE, price };

  if (PAYMENT_MODE === 'midtrans') {
    const resp = await fetch(SNAP_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: MIDTRANS_AUTH,
      },
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: price.total },
        item_details: [{
          id: 'SNAPBOOTH-TOKEN',
          price: price.unitPrice,
          quantity: price.quantity,
          name: 'SnapBooth Token',
        }],
        customer_details: { first_name: user.username },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.token) {
      throw new Error(
        'Gagal membuat transaksi Midtrans: ' +
        ((data.error_messages || []).join(', ') || resp.status),
      );
    }
    result.snapToken = data.token;
    result.clientKey = MIDTRANS_CLIENT_KEY;
    result.snapJsUrl = SNAP_JS_URL;
  }

  orders.set(orderId, order);
  persistOrder(order);
  return result;
}

// Webhook Midtrans
app.post('/api/payment/notification', (req, res) => {
  if (PAYMENT_MODE !== 'midtrans') return res.status(404).end();
  const b = req.body || {};
  const expected = crypto.createHash('sha512')
    .update(String(b.order_id) + String(b.status_code) + String(b.gross_amount) + MIDTRANS_SERVER_KEY)
    .digest('hex');
  const given = String(b.signature_key || '');
  if (given.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const order = orders.get(String(b.order_id));
  if (!order) return res.json({ ok: true }); // idempoten untuk order tak dikenal
  if (!Number.isFinite(Number(b.gross_amount)) || Number(b.gross_amount) !== order.amount) {
    return res.status(400).json({ error: 'Amount mismatch' });
  }
  applyMidtransStatus(order, b.transaction_status, b.fraud_status);
  res.json({ ok: true });
});

// Verifikasi server-to-server
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const order = orders.get(String((req.body || {}).orderId || ''));
  if (!order || order.userId !== req.user.id) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  }
  try {
    if (PAYMENT_MODE === 'midtrans' && !order.credited) {
      const r = await fetch(`${CORE_API}/${encodeURIComponent(order.orderId)}/status`, {
        headers: { Accept: 'application/json', Authorization: MIDTRANS_AUTH },
      });
      const d = await r.json().catch(() => ({}));
      if (d.order_id === order.orderId &&
          Number.isFinite(Number(d.gross_amount)) &&
          Number(d.gross_amount) === order.amount) {
        applyMidtransStatus(order, d.transaction_status, d.fraud_status);
      }
    }
    res.json({ status: order.status, credited: order.credited, user: publicUser(req.user) });
  } catch (e) {
    res.status(502).json({ error: 'Gagal memeriksa status pembayaran.' });
  }
});

// Mock pay (HANYA mode demo)
app.post('/api/payment/mock-pay', requireAuth, (req, res) => {
  if (PAYMENT_MODE !== 'mock') return res.status(403).json({ error: 'Mode demo tidak aktif.' });
  const order = orders.get(String((req.body || {}).orderId || ''));
  if (!order || order.userId !== req.user.id) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  }
  order.status = 'PAID';
  fulfillOrder(order);
  res.json({ status: order.status, credited: order.credited, user: publicUser(req.user) });
});

// ============================================================
// SESSION / CHARGING
// ============================================================
// Lock per booth session untuk mencegah double-charge
const chargeLocks = new Map(); // boothId -> Promise

async function withBoothLock(booth, fn) {
  if (!booth) return fn();
  const id = booth.id;
  while (chargeLocks.has(id)) {
    try { await chargeLocks.get(id); } catch { /* ignore */ }
  }
  let release;
  const p = new Promise((r) => (release = r));
  chargeLocks.set(id, p);
  try {
    return fn();
  } finally {
    chargeLocks.delete(id);
    release();
  }
}

app.post('/api/session/start', requireAuth, (req, res) => {
  const mode = (req.body || {}).mode;
  if (!['single', 'group'].includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
  if (!canStart(req.user)) {
    return res.status(402).json({
      error: 'You have no tokens and have used all free sessions. Please buy tokens.',
      code: 'PAYWALL',
    });
  }
  req.session.booth = {
    id: crypto.randomBytes(4).toString('hex'),
    mode,
    paid: [],
    freeCounted: false,
  };
  res.json({ ok: true, user: publicUser(req.user) });
});

function chargeInternal(user, booth, frameId) {
  const frame = FRAMES.find((f) => f.id === frameId);
  if (!frame) return { status: 400, error: 'Unknown frame.' };
  if (!booth) return { status: 400, error: 'No active session. Start a new session first.' };
  if (booth.paid.includes(frameId)) return { ok: true };

  if (frame.premium) {
    if (user.tokens < 1) return { status: 402, error: 'Not enough tokens for this premium frame.' };
    user.tokens -= 1;
  } else if (!booth.freeCounted) {
    const hasPaidPremium = booth.paid.some(
      (id) => (FRAMES.find((f) => f.id === id) || {}).premium,
    );
    if (!hasPaidPremium) {
      if (user.freeUsed < MAX_FREE_SESSIONS) {
        user.freeUsed += 1;
      } else if (user.tokens < 1) {
        return { status: 403, error: 'Free sessions used up. Please buy tokens.' };
      }
    }
    booth.freeCounted = true;
  }
  booth.paid.push(frameId);
  return { ok: true };
}

app.post('/api/finalize', requireAuth, async (req, res) => {
  const booth = req.session.booth;
  const r = await withBoothLock(booth, () =>
    chargeInternal(req.user, booth, (req.body || {}).frameId),
  );
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  persistUser(req.user);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/save', requireAuth, async (req, res) => {
  const { frameId, image } = req.body || {};
  const prefix = 'data:image/png;base64,';
  if (typeof image !== 'string' || !image.startsWith(prefix)) {
    return res.status(400).json({ error: 'Invalid image.' });
  }
  const booth = req.session.booth;
  const r = await withBoothLock(booth, () => chargeInternal(req.user, booth, frameId));
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  persistUser(req.user);
  const name = `${req.user.id}_${Date.now()}.png`;
  fs.writeFileSync(path.join(SAVE_DIR, name), Buffer.from(image.slice(prefix.length), 'base64'));
  res.json({ ok: true, url: '/saved/' + name, user: publicUser(req.user) });
});

app.get('/saved/:file', requireAuth, (req, res) => {
  const f = req.params.file;
  if (!/^[a-z0-9_]+\.png$/i.test(f) || !f.startsWith(req.user.id + '_')) {
    return res.status(404).end();
  }
  res.sendFile(path.join(SAVE_DIR, f));
});

// ============================================================
// SOCKET.IO
// ============================================================
const rooms = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomState = (r) => ({
  code: r.code,
  layout: r.layout,
  hostId: r.hostId,
  capturing: r.capturing,
  members: [...r.members].map(([id, name]) => ({ id, name })),
});
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  socket.data.room = null;
  socket.leave(code);
  const r = rooms.get(code);
  if (!r) return;
  r.members.delete(socket.id);
  if (!r.members.size) { rooms.delete(code); return; }
  if (r.hostId === socket.id) r.hostId = r.members.keys().next().value;
  io.to(code).emit('room:peer-left', { id: socket.id });
  io.to(code).emit('room:state', roomState(r));
}
async function runSequence(r) {
  r.capturing = true;
  io.to(r.code).emit('room:state', roomState(r));
  io.to(r.code).emit('shoot:begin', { total: r.layout });
  for (let i = 0; i < r.layout; i++) {
    for (let n = 3; n >= 1; n--) {
      if (rooms.get(r.code) !== r) return;
      io.to(r.code).emit('shoot:count', { n, index: i, total: r.layout });
      await sleep(1000);
    }
    if (rooms.get(r.code) !== r) return;
    io.to(r.code).emit('shoot:capture', { index: i, total: r.layout });
    await sleep(1500);
  }
  if (rooms.get(r.code) !== r) return;
  r.capturing = false;
  io.to(r.code).emit('shoot:done');
  io.to(r.code).emit('room:state', roomState(r));
}

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const user = sess && sess.userId ? usersById.get(sess.userId) : null;
  if (!user) { socket.emit('auth:required'); socket.disconnect(true); return; }
  socket.data.room = null;
  const myRoom = () => rooms.get(socket.data.room);
  socket.join('user:' + user.id);

  socket.on('create-payment-transaction', async (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      if (!payload || payload.userId !== user.id) {
        return reply({ ok: false, error: 'User tidak valid.' });
      }
      reply(await createPaymentTransaction(user, payload.tokenQuantity));
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });

  socket.on('room:create', (cb) => {
    if (typeof cb !== 'function') return;
    if (!canStart(user)) {
      return cb({ ok: false, error: 'Buy tokens to start a new session.', code: 'PAYWALL' });
    }
    leaveRoom(socket);
    const code = genCode();
    const r = {
      code,
      hostId: socket.id,
      layout: null,
      capturing: false,
      members: new Map([[socket.id, user.username]]),
    };
    rooms.set(code, r);
    socket.data.room = code;
    socket.join(code);
    cb({ ok: true, selfId: socket.id, room: roomState(r), peers: [] });
  });

  socket.on('room:join', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const code = String((payload || {}).code || '').trim().toUpperCase();
    const r = rooms.get(code);
    if (!canStart(user)) {
      return cb({ ok: false, error: 'Buy tokens to start a new session.', code: 'PAYWALL' });
    }
    if (!r) return cb({ ok: false, error: 'Group code not found.' });
    if (r.capturing) return cb({ ok: false, error: 'This group is mid-shoot. Try again in a moment.' });
    if (r.members.size >= MAX_ROOM_SIZE && !r.members.has(socket.id)) {
      return cb({ ok: false, error: `Room is full (max ${MAX_ROOM_SIZE}).` });
    }
    leaveRoom(socket);
    const peers = [...r.members.keys()];
    r.members.set(socket.id, user.username);
    socket.data.room = code;
    socket.join(code);
    socket.to(code).emit('room:state', roomState(r));
    cb({ ok: true, selfId: socket.id, room: roomState(r), peers });
  });

  socket.on('room:layout', (payload, cb) => {
    const r = myRoom();
    const layout = Number((payload || {}).layout);
    if (!r || r.hostId !== socket.id || r.capturing || ![3, 6].includes(layout)) {
      return typeof cb === 'function' && cb({ ok: false });
    }
    r.layout = layout;
    io.to(r.code).emit('room:state', roomState(r));
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('room:start', (cb) => {
    const r = myRoom();
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!r || r.hostId !== socket.id) return reply({ ok: false, error: 'Only the host can start.' });
    if (!r.layout) return reply({ ok: false, error: 'Choose a layout first.' });
    if (r.capturing) return reply({ ok: false, error: 'Already shooting.' });
    reply({ ok: true });
    runSequence(r);
  });

  socket.on('rtc:signal', (payload) => {
    const r = myRoom();
    const to = (payload || {}).to;
    if (!r || !r.members.has(to)) return;
    io.to(to).emit('rtc:signal', { from: socket.id, data: payload.data });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

// ============================================================
// TTL cleanup orders
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [orderId, ts] of orderTimestamps) {
    if (now - ts > ORDER_TTL_MS) {
      const order = orders.get(orderId);
      if (order && order.credited) {
        orders.delete(orderId);
        orderTimestamps.delete(orderId);
      }
    }
  }
}, 60 * 60 * 1000).unref();

// ============================================================
// Graceful shutdown
// ============================================================
async function shutdown(sig) {
  console.log(`[shutdown] menerima ${sig}, menutup server...`);
  try { io.close(); } catch { /* ignore */ }
  server.close(() => {});
  if (mongoClient) {
    try { await mongoClient.close(); } catch { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================
// Boot
// ============================================================
(async () => {
  try {
    await connectDatabase();
  } catch (e) {
    console.error('[db] Gagal terhubung ke MongoDB:', e.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`SnapBooth running at http://localhost:${PORT} (mode=${PAYMENT_MODE})`);
  });
})();