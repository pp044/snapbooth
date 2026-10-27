'use strict';
try { require('dotenv').config(); } catch (e) { /* dotenv opsional */ }
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path'); // <-- Cukup dideklarasikan SEKALI di sini
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo');

// ============================================================
// KONFIGURASI
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

// ---------- Catalog ----------
const FRAMES = [
  { id: 'classic', name: 'Classic White', premium: false },
  { id: 'noir',    name: 'Noir',          premium: false },
  { id: 'sunset',  name: 'Sunset Glow',   premium: true  },
  { id: 'gold',    name: 'Golden Luxe',   premium: true  },
  { id: 'koran',   name: 'Koran Retro',   premium: false },
];

// ---------- Harga token ----------
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
const orderTimestamps = new Map();
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

app.set('trust proxy', 1);

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

// Serve static files 
// ... kode server.js sebelumnya ...
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', '..', 'public_html')));
app.get('/style.css', (req, res) => {
  res.type('css').send(`
    :root{--bg:#0f1020;--panel:#181a30;--panel2:#202345;--text:#eef0ff;--muted:#9aa0c8;--primary:#7c5cff;--accent:#ffb020;--danger:#ff6b81;--radius:16px}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:radial-gradient(1200px 600px at 20% -10%,#2a2470 0%,var(--bg) 60%);color:var(--text);font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
.hidden{display:none!important}
header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 22px;background:rgba(15,16,32,.7);backdrop-filter:blur(8px);border-bottom:1px solid #ffffff14;position:sticky;top:0;z-index:10}
.brand{font-weight:800;font-size:1.25rem}
.top-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{background:var(--panel2);padding:6px 12px;border-radius:999px;font-size:.85rem}
main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}
.screen{display:none;animation:fade .25s ease}
.screen.active{display:block}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
h1,h2{margin:.2em 0 .5em}
.muted{color:var(--muted);font-size:.9rem}
.error{color:var(--danger);min-height:1.2em;margin:.5em 0 0}
.card{background:var(--panel);border:1px solid #ffffff12;border-radius:var(--radius);padding:24px;box-shadow:0 10px 40px #0006}
.narrow{max-width:420px;margin:30px auto;display:flex;flex-direction:column;gap:12px}
input{background:#0f1124;border:1px solid #ffffff22;color:var(--text);padding:12px 14px;border-radius:12px;font-size:1rem;width:100%}
input:focus{outline:2px solid var(--primary)}
.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.divider{text-align:center;color:var(--muted)}
.btn{background:var(--panel2);color:var(--text);border:1px solid #ffffff1f;padding:11px 18px;border-radius:12px;font-size:1rem;cursor:pointer;transition:.15s}
.btn:hover:not(:disabled){transform:translateY(-1px);border-color:#ffffff55}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:var(--primary);border-color:transparent}
.btn.accent{background:var(--accent);color:#2b1c00;border-color:transparent;font-weight:700}
.btn.ghost{background:transparent}
.btn.small{padding:6px 12px;font-size:.85rem}
.btn.big{font-size:1.15rem;padding:14px 36px;display:block;margin:18px auto 0}
.banner{background:#ffb02022;border:1px solid var(--accent);padding:12px 16px;border-radius:12px;margin-bottom:16px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;margin:18px 0}
/* KODE BARU (LEBIH PROFESIONAL) */
.choice {
  position: relative;
  background: linear-gradient(145deg, rgba(32, 35, 69, 0.8), rgba(24, 26, 48, 0.9));
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  padding: 40px 24px;
  color: var(--text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  font-size: 1.25rem;
  transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* Efek Cahaya di Belakang */
.choice::before {
  content: "";
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, rgba(124, 92, 255, 0.15) 0%, transparent 60%);
  opacity: 0;
  transition: opacity 0.4s ease;
  pointer-events: none;
}

.choice:hover {
  border-color: rgba(124, 92, 255, 0.5);
  transform: translateY(-8px) scale(1.02);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), 0 0 20px rgba(124, 92, 255, 0.2);
}

.choice:hover::before {
  opacity: 1;
}
/* --- IKON SVG PROFESIONAL --- */
.icon {
  display: inline-block;
  width: 64px;
  height: 64px;
  background-color: var(--primary);
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
  transition: all 0.4s ease;
  filter: drop-shadow(0 5px 15px rgba(124, 92, 255, 0.4));
}

/* Ikon Single (Orang berdiri) */
.icon-single {
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>');
}

/* Ikon Group (Banyak orang) */
.icon-group {
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>');
}

/* Animasi saat kartu di-hover */
.choice:hover .icon {
  transform: translateY(-5px) scale(1.1);
  background-color: var(--accent); /* Berubah warna jadi emas/kuning saat di-hover */
  filter: drop-shadow(0 10px 20px rgba(255, 176, 32, 0.4));
}
.mini{display:grid;gap:5px;width:70px}
.mini i{background:var(--primary);border-radius:3px;height:22px;display:block}
.mini3{grid-template-columns:1fr}
.mini6{grid-template-columns:1fr 1fr;width:100px}
.booth-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.room-panel{background:var(--panel);border-radius:12px;padding:12px 16px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.code{font-family:monospace;font-size:1.4rem;letter-spacing:4px;background:#0f1124;padding:4px 12px;border-radius:8px;color:var(--accent)}
.members{display:flex;gap:6px;flex-wrap:wrap}
.members span{background:var(--panel2);padding:4px 10px;border-radius:999px;font-size:.85rem}
.stage{position:relative;background:#000;border-radius:var(--radius);overflow:hidden}
.video-grid{display:grid;gap:2px;grid-template-columns:1fr;aspect-ratio:4/3;max-height:70vh;width:100%}
.video-grid[data-count="2"]{grid-template-columns:1fr 1fr}
.video-grid[data-count="3"]{grid-template-columns:1fr 1fr 1fr}
.video-grid[data-count="4"]{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.tile{position:relative;overflow:hidden;background:#111;min-height:0}
.tile video{width:100%;height:100%;object-fit:cover;display:block}
.mirror{transform:scaleX(-1)}
.tag{position:absolute;left:8px;bottom:8px;background:#000a;padding:3px 10px;border-radius:999px;font-size:.8rem}
.countdown{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:min(30vw,220px);font-weight:900;color:#fff;text-shadow:0 6px 30px #000;pointer-events:none}
.countdown.pop{animation:pop .9s ease}
@keyframes pop{0%{transform:scale(1.8);opacity:0}25%{opacity:1}100%{transform:scale(.9);opacity:.6}}
.flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.flash.go{animation:flash .5s ease}
@keyframes flash{0%{opacity:.95}100%{opacity:0}}
.thumbs{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px}
.thumbs div{width:90px;aspect-ratio:4/3;border-radius:8px;background:var(--panel);border:1px dashed #ffffff33;overflow:hidden}
.thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.frames-wrap{display:grid;grid-template-columns:260px 1fr;gap:22px;align-items:start}
.frame-list{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.frame-card{background:var(--panel);border:2px solid #ffffff14;border-radius:12px;padding:8px;color:var(--text);cursor:pointer;position:relative;text-align:center;font-size:.85rem}
.frame-card.selected{border-color:var(--primary);box-shadow:0 0 0 3px #7c5cff55}
.frame-card canvas{width:100%;border-radius:6px;display:block;margin-bottom:6px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem;margin-top:3px;background:#2dd4a022;color:#2dd4a0}
.badge.prem{background:#ffb02022;color:var(--accent)}
.preview{display:flex;flex-direction:column;align-items:center;gap:12px}
#previewCanvas{max-width:100%;max-height:68vh;border-radius:8px;box-shadow:0 10px 40px #000a;background:#fff}
.modal{position:fixed;inset:0;background:#000b;display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
.buy-card{max-height:92vh;overflow:auto;margin:0}
.packs{display:grid;gap:10px}
.pack{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--panel2);color:var(--text);padding:12px 16px;border-radius:12px;border:2px solid transparent;cursor:pointer;text-align:left;font-size:1rem;position:relative}
.pack:hover{border-color:#ffffff44}
.pack.selected{border-color:var(--primary);box-shadow:0 0 0 3px #7c5cff44}
.pack small{display:block;color:var(--muted);font-size:.78rem}
.pack .price{font-weight:700;text-align:right}
.disc-badge{display:inline-block;background:#2dd4a022;color:#2dd4a0;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px;vertical-align:middle}
.summary{background:#0f1124;border-radius:12px;padding:12px 14px;display:grid;gap:6px;font-size:.92rem}
.sum-row{display:flex;justify-content:space-between;gap:10px}
.sum-row.total{border-top:1px solid #ffffff22;padding-top:8px;font-weight:800;font-size:1.1rem;color:var(--accent)}
.strike{text-decoration:line-through;color:var(--muted)}
.big-pay{font-size:1.05rem;padding:13px}
#qtyInput{
  -webkit-appearance: textfield; /* Untuk Chrome, Safari, Edge */
  -moz-appearance: textfield;    /* Untuk Firefox */
  appearance: textfield;         /* Properti standar modern */
}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(30px);background:#000d;color:#fff;padding:12px 20px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;z-index:99;max-width:90vw;text-align:center}
.toast.show{opacity:1;transform:translateX(-50%)}
a{color:var(--accent)}
@media(max-width:760px){.frames-wrap{grid-template-columns:1fr}.frame-list{grid-template-columns:repeat(4,1fr)}}
@media(max-width:520px){.frame-list{grid-template-columns:repeat(2,1fr)}}
  `);
});

app.get('/app.js', (req, res) => {
  res.type('js').send(`
    (() => {
'use strict';
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newDeferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const state = {
  user: null, mode: null, layout: null, photos: [], images: [], frames: [],
  frameId: null, room: null, selfId: null, shooting: false, pendingPeers: [],
};
let socket = null;
let localStream = null;
let camDeferred = newDeferred();
const peers = new Map();
const localVideo = $('#localVideo');
const grid = $('#videoGrid');

// ---------------- helpers ----------------
async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function show(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  window.scrollTo(0, 0);
}
function setUser(u) {
  state.user = u;
  $('#topbar').classList.toggle('hidden', !u);
  if (!u) return;
  $('#pillUser').textContent = '👤 ' + u.username;
  $('#pillTokens').textContent = u.tokens;
  $('#pillFree').textContent = u.freeLeft;
  $('#blocked').classList.toggle('hidden', u.canStart);
}

// ---------------- auth ----------------
async function auth(kind) {
  $('#authMsg').textContent = '';
  try {
    const d = await api('/api/' + kind, 'POST', {
      username: $('#authUser').value,
      password: $('#authPass').value,
    });
    setUser(d.user);
    $('#authPass').value = '';
    show('landing');
  } catch (e) { $('#authMsg').textContent = e.message; }
}
$('#btnLogin').onclick = () => auth('login');
$('#btnRegister').onclick = () => auth('register');
$('#authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') auth('login'); });
$('#btnLogout').onclick = async () => {
  leaveSession(false);
  if (socket) { socket.disconnect(); socket = null; }
  try { await api('/api/logout', 'POST'); } catch (e) { /* ignore */ }
  setUser(null);
  show('auth');
};

// ---------------- beli token ----------------
const rupiah = (n) => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
}).format(n);
let pricing = null;
let buyQty = 1;
let currentOrder = null;
let payBusy = false;
let pollId = 0;
const mk = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function initSocket() { ensureSocket().catch(() => {}); }

function calcPrice(q) {
  let tier = pricing.tiers[0];
  pricing.tiers.forEach((t) => { if (q >= t.minQty) tier = t; });
  const baseTotal = q * pricing.basePrice;
  const total = q * tier.unitPrice;
  return {
    unitPrice: tier.unitPrice,
    baseTotal,
    total,
    saved: baseTotal - total,
    discountPercent: Math.round((1 - tier.unitPrice / pricing.basePrice) * 100),
  };
}
function setPayStatus(t) { $('#payStatus').textContent = t || ''; }
function renderPacks() {
  const list = $('#packList');
  list.innerHTML = '';
  pricing.packages.forEach((q) => {
    const p = calcPrice(q);
    const btn = mk('button', 'pack');
    btn.type = 'button';
    btn.dataset.qty = q;
    const left = mk('div');
    const title = mk('b', '', `🪙 ${q} Token`);
    if (p.discountPercent > 0) title.append(mk('span', 'disc-badge', `Hemat ${p.discountPercent}%`));
    left.append(title, mk('small', '', `${rupiah(p.unitPrice)} / token`));
    const right = mk('div', 'price');
    if (p.saved > 0) right.append(mk('small', 'strike', rupiah(p.baseTotal)));
    right.append(mk('span', '', rupiah(p.total)));
    btn.append(left, right);
    btn.onclick = () => { buyQty = q; $('#qtyInput').value = q; updateSummary(); };
    list.append(btn);
  });
}
function updateSummary() {
  const box = $('#priceSummary');
  box.innerHTML = '';
  const pay = $('#btnPay');
  document.querySelectorAll('.pack').forEach((x) => x.classList.toggle('selected', Number(x.dataset.qty) === buyQty));
  if (!Number.isInteger(buyQty) || buyQty < 1 || buyQty > pricing.maxQty) {
    box.textContent = `Masukkan jumlah bilangan bulat 1–${pricing.maxQty} token.`;
    pay.disabled = true;
    pay.textContent = 'Bayar';
    return;
  }
  const p = calcPrice(buyQty);
  const row = (k, v, cls) => {
    const r = mk('div', 'sum-row' + (cls ? ' ' + cls : ''));
    r.append(mk('span', '', k));
    const val = mk('span', '', v);
    r.append(val);
    box.append(r);
    return val;
  };
  row('Jumlah', `${buyQty} token`);
  const normal = row('Harga normal', rupiah(p.baseTotal));
  if (p.saved > 0) normal.className = 'strike';
  row('Diskon', p.discountPercent > 0 ? `${p.discountPercent}% (hemat ${rupiah(p.saved)})` : 'Tidak ada');
  row('Harga per token', rupiah(p.unitPrice));
  row('Total bayar', rupiah(p.total), 'total');
  pay.disabled = payBusy;
  pay.textContent = `Bayar ${rupiah(p.total)}`;
}
async function openBuy() {
  try {
    if (!pricing) pricing = await api('/api/token-pricing');
    currentOrder = null;
    pollId++;
    payBusy = false;
    setPayStatus('');
    $('#btnMockPay').classList.add('hidden');
    buyQty = 1;
    $('#qtyInput').value = 1;
    renderPacks();
    updateSummary();
    $('#modal').classList.remove('hidden');
    initSocket();
  } catch (e) { toast(e.message); }
}
$('#btnBuy').onclick = openBuy;
$('#btnBlockedBuy').onclick = openBuy;
$('#btnCloseModal').onclick = () => {
  pollId++;
  currentOrder = null;
  $('#modal').classList.add('hidden');
};
$('#qtyInput').oninput = () => { buyQty = Number($('#qtyInput').value); updateSummary(); };

function loadSnap(clientKey, src) {
  return new Promise((resolve, reject) => {
    if (window.snap) return resolve();
    const sc = document.createElement('script');
    sc.src = src;
    sc.setAttribute('data-client-key', clientKey);
    sc.onload = resolve;
    sc.onerror = () => reject(new Error('Gagal memuat Midtrans Snap.'));
    document.head.append(sc);
  });
}
async function pollOrder(orderId) {
  const my = ++pollId;
  for (let i = 0; i < 20; i++) {
    if (my !== pollId || !currentOrder || currentOrder.orderId !== orderId) return;
    try {
      const r = await api('/api/payment/verify', 'POST', { orderId });
      if (r.credited) { setUser(r.user); return; }
      if (r.status === 'FAILED' || r.status === 'EXPIRED') {
        setPayStatus('Pembayaran ' + (r.status === 'EXPIRED' ? 'kedaluwarsa.' : 'gagal.'));
        return;
      }
    } catch (e) { /* coba lagi */ }
    await sleep(3000);
  }
  setPayStatus('Masih menunggu konfirmasi pembayaran. Token akan masuk otomatis setelah lunas.');
}
$('#btnPay').onclick = async () => {
  if (payBusy) return;
  payBusy = true;
  $('#btnPay').disabled = true;
  setPayStatus('Membuat transaksi…');
  try {
    await ensureSocket();
    const ack = await emitAck('create-payment-transaction', {
      userId: state.user.id, tokenQuantity: buyQty,
    });
    if (!ack.ok) throw new Error(ack.error || 'Gagal membuat transaksi.');
    currentOrder = ack;
    if (ack.mode === 'mock') {
      $('#btnMockPay').classList.remove('hidden');
      setPayStatus(
        `Mode demo (Midtrans belum dikonfigurasi). Order ${ack.orderId}: total ${rupiah(ack.price.total)}. ` +
        `Klik "Simulasikan pembayaran".`,
      );
    } else {
      setPayStatus(`Order ${ack.orderId}: total ${rupiah(ack.price.total)}`);
      await loadSnap(ack.clientKey, ack.snapJsUrl);
      window.snap.pay(ack.snapToken, {
        onSuccess: () => { setPayStatus('Pembayaran diterima, memverifikasi…'); pollOrder(ack.orderId); },
        onPending: () => { setPayStatus('Menunggu pembayaran. Token ditambahkan otomatis setelah lunas.'); pollOrder(ack.orderId); },
        onError: () => setPayStatus('Pembayaran gagal. Silakan coba lagi.'),
        onClose: () => setPayStatus('Jendela pembayaran ditutup. Jika sudah membayar, token akan masuk otomatis.'),
      });
    }
  } catch (e) {
    setPayStatus(e.message);
    toast(e.message);
  } finally {
    payBusy = false;
    updateSummary();
  }
};
$('#btnMockPay').onclick = async () => {
  if (!currentOrder) return;
  try { await api('/api/payment/mock-pay', 'POST', { orderId: currentOrder.orderId }); }
  catch (e) { toast(e.message); }
};

// ---------------- landing / room ----------------
async function beginBoothSession(mode) {
  try {
    const d = await api('/api/session/start', 'POST', { mode });
    setUser(d.user);
    state.mode = mode;
    return true;
  } catch (e) {
    toast(e.message);
    if (e.status === 402) openBuy();
    return false;
  }
}
$('#btnSingle').onclick = async () => {
  if (await beginBoothSession('single')) { state.layout = null; show('layout'); }
};
$('#btnGroup').onclick = async () => {
  if (await beginBoothSession('group')) {
    $('#groupMsg').textContent = '';
    show('group');
  }
};
$('#btnGroupBack').onclick = () => leaveSession(true);

function ensureSocket() {
  return new Promise((resolve, reject) => {
    if (socket && socket.connected) return resolve(socket);
    if (!socket) { socket = io(); bindSocket(socket); }
    const timer = setTimeout(() => reject(new Error('Could not connect to server.')), 7000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Could not connect to server.')); });
  });
}
// PERBAIKAN: emitAck dengan timeout agar tidak menggantung.
const emitAck = (ev, payload, timeoutMs = 10000) => new Promise((resolve, reject) => {
  if (!socket || !socket.connected) return reject(new Error('Not connected.'));
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    reject(new Error('Server tidak merespons. Coba lagi.'));
  }, timeoutMs);
  const cb = (resp) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(resp);
  };
  if (payload === undefined) socket.emit(ev, cb);
  else socket.emit(ev, payload, cb);
});

async function enterRoom(ack) {
  if (!ack.ok) {
    $('#groupMsg').textContent = ack.error || 'Failed.';
    if (ack.code === 'PAYWALL') openBuy();
    return false;
  }
  state.selfId = ack.selfId;
  state.pendingPeers = ack.peers || [];
  applyRoom(ack.room);
  return true;
}
$('#btnCreateRoom').onclick = async () => {
  try {
    await ensureSocket();
    if (await enterRoom(await emitAck('room:create'))) show('layout');
  } catch (e) { $('#groupMsg').textContent = e.message; }
};
$('#btnJoinRoom').onclick = async () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!code) { $('#groupMsg').textContent = 'Enter a group code.'; return; }
  try {
    await ensureSocket();
    if (await enterRoom(await emitAck('room:join', { code }))) enterBooth();
  } catch (e) { $('#groupMsg').textContent = e.message; }
};

// ---------------- layout ----------------
document.querySelectorAll('.layout-card').forEach((c) => {
  c.onclick = async () => {
    state.layout = Number(c.dataset.layout);
    if (state.mode === 'group') {
      try { await emitAck('room:layout', { layout: state.layout }); } catch (e) { /* ignore */ }
    }
    enterBooth();
  };
});
$('#btnLayoutBack').onclick = () => leaveSession(true);

// ---------------- booth ----------------
const isHost = () => !state.room || state.room.hostId === state.selfId;
async function enterBooth() {
  show('booth');
  renderBoothUI();
  renderThumbs();
  try {
    await startCamera();
  } catch (e) {
    toast('Camera error: ' + e.message + ' (use localhost or HTTPS and allow camera access)');
  }
}
async function startCamera() {
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      localVideo.srcObject = localStream;
      try { await localVideo.play(); } catch (e) { /* autoplay attr */ }
      camDeferred.resolve();
    } catch (e) {
      // PERBAIKAN: reject deferred agar rtc:signal tidak menggantung
      camDeferred.reject(e);
      throw e;
    }
  }
  const ids = state.pendingPeers;
  state.pendingPeers = [];
  ids.forEach((id) => createPeer(id, true));
}
function stopCamera() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  localVideo.srcObject = null;
  camDeferred = newDeferred();
}
function renderBoothUI() {
  const group = state.mode === 'group';
  $('#roomPanel').classList.toggle('hidden', !group);
  $('#boothInfo').textContent =
    (group ? 'Group Photo' : 'Single Photo') + (state.layout ? ` · ${state.layout} photos` : ' · waiting for layout');
  const btn = $('#btnStart');
  if (!group) {
    btn.classList.remove('hidden');
    btn.disabled = state.shooting || !state.layout;
    btn.textContent = state.shooting ? 'Shooting…' : `Start (${state.layout || ''} photos)`;
    return;
  }
  if (state.room) {
    $('#roomCode').textContent = state.room.code;
    const m = $('#members');
    m.innerHTML = '';
    state.room.members.forEach((x) => {
      const s = document.createElement('span');
      s.textContent = x.name + (x.id === state.room.hostId ? ' 👑' : '') + (x.id === state.selfId ? ' (you)' : '');
      m.append(s);
    });
  }
  const host = isHost();
  btn.classList.toggle('hidden', !host);
  btn.disabled = state.shooting || !state.layout;
  btn.textContent = state.shooting ? 'Shooting…' : `Start for everyone (${state.layout || ''} photos)`;
  $('#roomWait').textContent = !state.layout
    ? 'Waiting for the host to choose a layout…'
    : host
      ? 'Share the code, then press Start when everyone is in.'
      : 'Waiting for the host to press Start…';
}
function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  for (let i = 0; i < (state.layout || 3); i++) {
    const d = document.createElement('div');
    if (state.photos[i]) {
      const im = document.createElement('img');
      im.src = state.photos[i];
      d.append(im);
    }
    box.append(d);
  }
}
function updateGridCount() { grid.dataset.count = Math.min(4, grid.children.length); }

function beginShoot(total) {
  state.photos = [];
  state.shooting = true;
  state.layout = total;
  show('booth');
  renderThumbs();
  renderBoothUI();
}
function showCount(n) {
  const el = $('#countdown');
  el.textContent = n;
  el.classList.remove('hidden', 'pop');
  void el.offsetWidth;
  el.classList.add('pop');
}
function doCapture(index) {
  $('#countdown').classList.add('hidden');
  const f = $('#flash');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
  try { state.photos[index] = snapshot(); } catch (e) { toast('Capture failed: ' + e.message); }
  renderThumbs();
}
function finishShoot() {
  state.shooting = false;
  $('#countdown').classList.add('hidden');
  renderBoothUI();
  goFrames();
}
async function runLocalSequence() {
  const total = state.layout;
  beginShoot(total);
  for (let i = 0; i < total; i++) {
    for (let n = 3; n >= 1; n--) { showCount(n); await sleep(1000); }
    doCapture(i);
    await sleep(1500);
  }
  finishShoot();
}
$('#btnStart').onclick = async () => {
  if (!localStream) { toast('Camera is not ready yet.'); return; }
  if (state.mode === 'single') return runLocalSequence();
  try {
    const r = await emitAck('room:start');
    if (!r.ok) toast(r.error || 'Could not start.');
  } catch (e) { toast(e.message); }
};
$('#btnLeave').onclick = () => leaveSession(true);

function drawCover(ctx, v, x, y, w, h, mirror) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const sc = Math.max(w / vw, h / vh), sw = w / sc, sh = h / sc;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (mirror) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
  } else {
    ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
  }
  ctx.restore();
}
function snapshot() {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 720;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 960, 720);
  let els = [];
  if (state.mode === 'group' && state.room) {
    state.room.members.forEach((m) => {
      if (m.id === state.selfId) els.push(localVideo);
      else { const p = peers.get(m.id); if (p && p.video) els.push(p.video); }
    });
  }
  if (!els.length) els = [localVideo];
  els = els.filter((v) => v.videoWidth > 0);
  const rects = {
    1: [[0, 0, 960, 720]],
    2: [[0, 0, 480, 720], [480, 0, 480, 720]],
    3: [[0, 0, 320, 720], [320, 0, 320, 720], [640, 0, 320, 720]],
    4: [[0, 0, 480, 360], [480, 0, 480, 360], [0, 360, 480, 360], [480, 360, 480, 360]],
  }[Math.min(4, els.length)] || [];
  els.slice(0, 4).forEach((v, i) => drawCover(ctx, v, ...rects[i], state.mode === 'single'));
  return c.toDataURL('image/jpeg', 0.92);
}

// ---------------- sockets & WebRTC ----------------
function applyRoom(room) {
  state.room = room;
  state.layout = room.layout;
  peers.forEach((p, id) => {
    const m = room.members.find((x) => x.id === id);
    if (m && p.tag) p.tag.textContent = m.name;
  });
  if (state.mode === 'group') {
    state.shooting = room.capturing;
    renderBoothUI();
    renderThumbs();
  }
}
function bindSocket(s) {
  s.on('room:state', applyRoom);
  s.on('room:peer-left', ({ id }) => removePeer(id));
  s.on('shoot:begin', ({ total }) => beginShoot(total));
  s.on('shoot:count', ({ n }) => showCount(n));
  s.on('shoot:capture', ({ index }) => doCapture(index));
  s.on('shoot:done', async () => { await sleep(400); finishShoot(); });
  s.on('auth:required', () => {
    toast('Session expired. Please log in again.');
    setUser(null);
    show('auth');
  });
  s.on('disconnect', () => {
    if (state.mode === 'group' && state.room) {
      toast('Disconnected from the group.');
      leaveSession(true);
    }
  });
  s.on('rtc:signal', async ({ from, data }) => {
    try {
      await camDeferred.promise;
    } catch (e) {
      return; // kamera gagal, abaikan
    }
    let p = peers.get(from) || createPeer(from, false);
    try {
      if (data.description) {
        await p.pc.setRemoteDescription(data.description);
        while (p.pending.length) await p.pc.addIceCandidate(p.pending.shift()).catch(() => {});
        if (data.description.type === 'offer') {
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          socket.emit('rtc:signal', { to: from, data: { description: p.pc.localDescription } });
        }
      } else if (data.candidate) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pending.push(data.candidate);
      }
    } catch (e) { console.warn('signal error', e); }
  });
}
function createPeer(id, initiator) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const p = { pc, video: null, tile: null, tag: null, pending: [] };
  peers.set(id, p);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => attachRemote(id, e.streams[0]);
  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => socket.emit('rtc:signal', { to: id, data: { description: pc.localDescription } }))
      .catch((e) => console.warn('offer error', e));
  }
  return p;
}
function attachRemote(id, stream) {
  const p = peers.get(id);
  if (!p) return;
  if (p.video) { p.video.srcObject = stream; return; }
  const tile = document.createElement('div');
  tile.className = 'tile';
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true;
  v.srcObject = stream;
  const tag = document.createElement('span');
  tag.className = 'tag';
  const m = state.room && state.room.members.find((x) => x.id === id);
  tag.textContent = m ? m.name : 'Guest';
  tile.append(v, tag);
  grid.append(tile);
  Object.assign(p, { video: v, tile, tag });
  v.play().catch(() => {});
  updateGridCount();
}
function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  try { p.pc.close(); } catch (e) { /* ignore */ }
  if (p.tile) p.tile.remove();
  peers.delete(id);
  updateGridCount();
}

function leaveSession(goHome) {
  if (socket && state.room) socket.emit('room:leave');
  [...peers.keys()].forEach(removePeer);
  stopCamera();
  Object.assign(state, {
    mode: null, layout: null, photos: [], images: [], frameId: null,
    room: null, selfId: null, shooting: false, pendingPeers: [],
  });
  $('#countdown').classList.add('hidden');
  if (goHome) {
    api('/api/me').then((d) => setUser(d.user)).catch(() => {});
    show('landing');
  }
}

// ---------------- frames (Canvas) ----------------
const GEOM = {
  3: { W: 640, H: 1560, cols: 1, sw: 560, sh: 420, x0: 40, y0: 60, gx: 0, gy: 40 },
  6: { W: 1180, H: 1470, cols: 2, sw: 520, sh: 390, x0: 50, y0: 60, gx: 40, gy: 40 },
};
function slotRects(layout) {
  const g = GEOM[layout];
  const out = [];
  for (let i = 0; i < layout; i++) {
    out.push({
      x: g.x0 + (i % g.cols) * (g.sw + g.gx),
      y: g.y0 + Math.floor(i / g.cols) * (g.sh + g.gy),
      w: g.sw,
      h: g.sh,
    });
  }
  return out;
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PERBAIKAN: muat koran.png dari root /public dengan handler onload & flag
const imgKoran = new Image();
let imgKoranReady = false;
imgKoran.onload = () => { imgKoranReady = true; };
imgKoran.onerror = () => { console.warn('[frame] koran.png tidak ditemukan'); };
imgKoran.src = 'koran.png'; // relative to /public/app.js -> /koran.png

const THEMES = {
  classic: {
    stroke: '#111827', sw: 4, radius: 10, text: '#111827',
    bg(ctx, W, H) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 16;
      ctx.strokeRect(8, 8, W - 16, H - 16);
    },
  },
  noir: {
    stroke: '#ffffff', sw: 4, radius: 6, text: '#ffffff',
    bg(ctx, W, H) {
      ctx.fillStyle = '#0b0b0f';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#ffffff55';
      ctx.lineWidth = 3;
      ctx.strokeRect(20, 20, W - 40, H - 40);
    },
  },
  sunset: {
    stroke: '#ffffff', sw: 7, radius: 26, text: '#ffffff',
    bg(ctx, W, H) {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#ff9a8b');
      g.addColorStop(0.5, '#ff6a88');
      g.addColorStop(1, '#8e44ad');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      const r = rng(42);
      for (let i = 0; i < 70; i++) {
        ctx.globalAlpha = 0.15 + r() * 0.5;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(r() * W, r() * H, 2 + r() * 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  },
  gold: {
    stroke: '#e9c46a', sw: 7, radius: 8, text: '#e9c46a',
    bg(ctx, W, H) {
      ctx.fillStyle = '#17110a';
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#f6e27a');
      g.addColorStop(0.5, '#b8860b');
      g.addColorStop(1, '#f6e27a');
      ctx.strokeStyle = g;
      ctx.lineWidth = 10;
      ctx.strokeRect(14, 14, W - 28, H - 28);
      ctx.lineWidth = 3;
      ctx.strokeRect(34, 34, W - 68, H - 68);
      ctx.fillStyle = g;
      [[34, 34], [W - 34, 34], [34, H - 34], [W - 34, H - 34]].forEach(([x, y]) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-14, -14, 28, 28);
        ctx.restore();
      });
    },
  },
  koran: {
    stroke: '#3e352f', sw: 3, radius: 0, text: '#3e352f',
    bg(ctx, W, H) {
      if (imgKoranReady && imgKoran.complete && imgKoran.naturalWidth > 0) {
        ctx.drawImage(imgKoran, 0, 0, W, H);
      } else {
        // fallback sementara agar tidak putih polos
        ctx.fillStyle = '#e2decb';
        ctx.fillRect(0, 0, W, H);
      }
    },
  },
};

// PERBAIKAN: cache thumbnail frame agar tidak render ulang setiap goFrames
const frameThumbCache = new Map(); // key = `${frameId}|${layout}|${imagesHash}`

function renderFrame(canvas, frameId, layout, images) {
  const g = GEOM[layout];
  const th = THEMES[frameId];
  canvas.width = g.W;
  canvas.height = g.H;
  const ctx = canvas.getContext('2d');
  th.bg(ctx, g.W, g.H);
  const slots = slotRects(layout);
  slots.forEach((s, i) => {
    ctx.save();
    rr(ctx, s.x, s.y, s.w, s.h, th.radius);
    ctx.clip();
    ctx.fillStyle = '#222';
    ctx.fillRect(s.x, s.y, s.w, s.h);
    const im = images[i];
    if (im) {
      const sc = Math.max(s.w / im.width, s.h / im.height);
      const dw = im.width * sc, dh = im.height * sc;
      ctx.drawImage(im, s.x + (s.w - dw) / 2, s.y + (s.h - dh) / 2, dw, dh);
    }
    ctx.restore();
    ctx.strokeStyle = th.stroke;
    ctx.lineWidth = th.sw;
    rr(ctx, s.x, s.y, s.w, s.h, th.radius);
    ctx.stroke();
  });
  const last = slots[slots.length - 1];
  const endY = last.y + last.h;
  ctx.fillStyle = th.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 38px "Segoe UI", Arial, sans-serif';
  ctx.fillText('SNAPBOOTH · ' + new Date().toLocaleDateString(), g.W / 2, endY + (g.H - endY) / 2);
}

function loadImg(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}
function blankPhoto() {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 720;
  const x = c.getContext('2d');
  x.fillStyle = '#333';
  x.fillRect(0, 0, 960, 720);
  return c.toDataURL('image/jpeg');
}

async function goFrames() {
  show('frames');
  $('#saveLink').textContent = '';
  const srcs = [];
  for (let i = 0; i < state.layout; i++) srcs.push(state.photos[i] || blankPhoto());
  state.images = await Promise.all(srcs.map(loadImg));
  try {
    state.frames = (await api('/api/frames')).frames;
  } catch (e) { toast(e.message); return; }
  const list = $('#frameList');
  list.innerHTML = '';
  state.frames.forEach((f) => {
    const card = document.createElement('button');
    card.className = 'frame-card';
    card.dataset.id = f.id;
    const off = document.createElement('canvas');
    renderFrame(off, f.id, state.layout, state.images);
    const thumb = document.createElement('canvas');
    thumb.width = 160;
    thumb.height = Math.round(160 * off.height / off.width);
    thumb.getContext('2d').drawImage(off, 0, 0, thumb.width, thumb.height);
    const name = document.createElement('div');
    name.textContent = (f.premium ? '🔒 ' : '') + f.name;
    const badge = document.createElement('span');
    badge.className = 'badge' + (f.premium ? ' prem' : '');
    badge.textContent = f.premium ? '1 token' : 'Free';
    card.append(thumb, name, badge);
    card.onclick = () => selectFrame(f.id);
    list.append(card);
  });
  selectFrame(state.frames.find((f) => !f.premium).id);
}
function selectFrame(id) {
  const f = state.frames.find((x) => x.id === id);
  if (f.premium && state.user.tokens < 1) {
    toast('🔒 Premium frames cost 1 token. Please buy tokens.');
    openBuy();
    return;
  }
  state.frameId = id;
  document.querySelectorAll('.frame-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  renderFrame($('#previewCanvas'), id, state.layout, state.images);
  $('#costNote').textContent = f.premium
    ? '🔒 Premium frame: 1 token is deducted when you download or save.'
    : 'Basic frame: free (counts as one free session if you have free sessions left).';
}

function chargeError(e) {
  toast(e.message);
  if (e.status === 402 || e.status === 403) openBuy();
}
$('#btnDownload').onclick = async () => {
  try {
    const r = await api('/api/finalize', 'POST', { frameId: state.frameId });
    setUser(r.user);
    const blob = await new Promise((res) => $('#previewCanvas').toBlob(res, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `snapbooth-${Date.now()}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Downloaded!');
  } catch (e) { chargeError(e); }
};
$('#btnSave').onclick = async () => {
  try {
    const r = await api('/api/save', 'POST', {
      frameId: state.frameId,
      image: $('#previewCanvas').toDataURL('image/png'),
    });
    setUser(r.user);
    const link = document.createElement('a');
    link.href = r.url;
    link.target = '_blank';
    link.textContent = 'Open saved image';
    $('#saveLink').textContent = 'Saved to your account! ';
    $('#saveLink').append(link);
    toast('Saved!');
  } catch (e) { chargeError(e); }
};
$('#btnRetake').onclick = () => {
  if (state.mode === 'group' && !isHost()) {
    toast('Waiting for the host to start another round…');
  }
  show('booth');
  renderBoothUI();
  renderThumbs();
};
$('#btnHome').onclick = () => leaveSession(true);

// ---------------- boot ----------------
(async function boot() {
  try {
    const d = await api('/api/me');
    setUser(d.user);
    show('landing');
  } catch (e) {
    show('auth');
  }
})();
})();
  `);
});
app.get('/', (req, res) => {
  res.type('html').send(`
    <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SnapBooth – Online Photo Booth</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header id="topbar" class="hidden">
    <div class="brand">📸 SnapBooth</div>
    <div class="top-right">
      <span class="pill" id="pillUser"></span>
      <span class="pill">🪙 <b id="pillTokens">0</b> tokens</span>
      <span class="pill">🎁 <b id="pillFree">0</b> free left</span>
      <button class="btn small accent" id="btnBuy">Buy Tokens</button>
      <button class="btn small ghost" id="btnLogout">Log out</button>
    </div>
  </header>

  <main>
    <!-- AUTH -->
    <section id="screen-auth" class="screen">
      <div class="card narrow">
        <h1>📸 SnapBooth</h1>
        <p class="muted">Log in or create an account to start. New accounts get 2 free sessions.</p>
        <input id="authUser" type="text" placeholder="Username" autocomplete="username">
        <input id="authPass" type="password" placeholder="Password" autocomplete="current-password">
        <div class="row">
          <button class="btn primary" id="btnLogin">Log in</button>
          <button class="btn" id="btnRegister">Create account</button>
        </div>
        <p class="error" id="authMsg"></p>
      </div>
    </section>

    <!-- LANDING -->
    <section id="screen-landing" class="screen">
      <h2>Choose your booth</h2>
      <div id="blocked" class="banner hidden">
        You have 0 tokens and have used all free sessions.
        <button class="btn small accent" id="btnBlockedBuy">Buy Tokens</button>
      </div>
      <div class="grid2">
        <button class="choice" id="btnSingle">
          <span class="icon icon-single"></span>
          <b>Single Photo</b>
          <small>Just you, solo shots</small>
        </button>
        <button class="choice" id="btnGroup">
          <span class="icon icon-group"></span>
          <b>Group Photo</b>
          <small>Shoot together in a shared room</small>
        </button>

      </div>
    </section>

    <!-- GROUP ROOM -->
    <section id="screen-group" class="screen">
      <div class="card narrow">
        <h2>Group Photo</h2>
        <button class="btn primary" id="btnCreateRoom">Create a Group Code</button>
        <div class="divider">or</div>
        <input id="joinCode" type="text" maxlength="8" placeholder="Enter group code" style="text-transform:uppercase">
        <button class="btn" id="btnJoinRoom">Join Group</button>
        <button class="btn ghost" id="btnGroupBack">← Back</button>
        <p class="error" id="groupMsg"></p>
      </div>
    </section>

    <!-- LAYOUT -->
    <section id="screen-layout" class="screen">
      <h2>Choose a layout</h2>
      <div class="grid2">
        <button class="choice layout-card" data-layout="3">
          <div class="mini mini3"><i></i><i></i><i></i></div><b>3 Photos</b><small>Classic vertical strip</small>
        </button>
        <button class="choice layout-card" data-layout="6">
          <div class="mini mini6"><i></i><i></i><i></i><i></i><i></i><i></i></div><b>6 Photos</b><small>2 × 3 grid</small>
        </button>
      </div>
      <button class="btn ghost" id="btnLayoutBack">← Back</button>
    </section>

    <!-- BOOTH -->
    <section id="screen-booth" class="screen">
      <div class="booth-head">
        <div><b id="boothInfo"></b></div>
        <button class="btn small ghost" id="btnLeave">Leave</button>
      </div>
      <div id="roomPanel" class="room-panel hidden">
        <div>Group code: <span class="code" id="roomCode"></span></div>
        <div id="members" class="members"></div>
        <div class="muted" id="roomWait"></div>
      </div>
      <div class="stage">
        <div id="videoGrid" class="video-grid" data-count="1">
          <div class="tile"><video id="localVideo" autoplay muted playsinline class="mirror"></video><span class="tag">You</span></div>
        </div>
        <div id="countdown" class="countdown hidden"></div>
        <div id="flash" class="flash"></div>
      </div>
      <div id="thumbs" class="thumbs"></div>
      <button class="btn primary big" id="btnStart">Start</button>
    </section>

    <!-- FRAMES -->
    <section id="screen-frames" class="screen">
      <h2>Pick a frame</h2>
      <div class="frames-wrap">
        <div id="frameList" class="frame-list"></div>
        <div class="preview">
          <canvas id="previewCanvas"></canvas>
          <p class="muted" id="costNote"></p>
          <div class="row">
            <button class="btn primary" id="btnDownload">⬇ Download</button>
            <button class="btn" id="btnSave">💾 Save</button>
          </div>
          <p id="saveLink" class="muted"></p>
          <div class="row">
            <button class="btn ghost" id="btnRetake">↻ Retake</button>
            <button class="btn ghost" id="btnHome">🏠 Home</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- BUY MODAL -->
  <div id="modal" class="modal hidden">
    <div class="card narrow buy-card">
      <h2>Beli Token</h2>
      <p class="muted">Harga dasar Rp 5.000 / token. Makin banyak, makin hemat! Frame Premium memakai 1 token.</p>
      <div id="packList" class="packs"></div>
      <label class="muted" for="qtyInput">Atau masukkan jumlah kustom (1–100)</label>
      <input id="qtyInput" type="number" inputmode="numeric" min="1" max="100" step="1" value="1">
      <div id="priceSummary" class="summary"></div>
      <button class="btn accent big-pay" id="btnPay">Bayar</button>
      <button class="btn hidden" id="btnMockPay">Simulasikan pembayaran (mode demo)</button>
      <p id="payStatus" class="muted"></p>
      <button class="btn ghost" id="btnCloseModal">Tutup</button>
    </div>
  </div>
  <div id="toast" class="toast"></div>
 
  <script src="/socket.io/socket.io.js"></script>
  <script src="app.js"></script>
</body>
</html>
  `);
  app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public_html', 'index.html'));
});
});



// ---------- Rate limiter ----------
const rateBuckets = new Map();
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

// ---------- Health check ----------
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

async function fulfillOrder(order) {
  if (order.credited || !PAID_STATUSES.includes(order.status)) return false;
  const user = usersById.get(order.userId);
  if (!user) return false;

  if (ordersCol) {
    try {
      const r = await ordersCol.findOneAndUpdate(
        { _id: order.orderId, credited: { $ne: true } },
        { $set: { credited: true, status: order.status, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!r) return false; 
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
  if (!order) return res.json({ ok: true }); 
  if (!Number.isFinite(Number(b.gross_amount)) || Number(b.gross_amount) !== order.amount) {
    return res.status(400).json({ error: 'Amount mismatch' });
  }
  applyMidtransStatus(order, b.transaction_status, b.fraud_status);
  res.json({ ok: true });
});

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
const chargeLocks = new Map();

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