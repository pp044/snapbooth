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
// --- LOGIKA PINDAH FORM ---
$('#btnShowRegister').onclick = () => {
  $('#formLogin').classList.add('hidden');
  $('#formRegister').classList.remove('hidden');
  $('#authMsg').textContent = '';
};
$('#btnShowLogin').onclick = () => {
  $('#formRegister').classList.add('hidden');
  $('#formLogin').classList.remove('hidden');
  $('#authMsg').textContent = '';
};

// --- LOGIKA LOGIN ---
$('#btnLogin').onclick = () => auth('login');
$('#authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') auth('login'); });

// --- LOGIKA REGISTER BARU ---
$('#btnRegister').onclick = async () => {
  $('#authMsg').textContent = '';
  const u = $('#regUser').value;
  const p = $('#regPass').value;
  const c = $('#regConfirm').value;
  
  if (p !== c) {
    $('#authMsg').textContent = 'Password dan Konfirmasi Password tidak cocok!';
    return;
  }
  
  try {
    const d = await api('/api/register', 'POST', { username: u, password: p });
    setUser(d.user);
    show('landing');
  } catch (e) {
    $('#authMsg').textContent = e.message;
  }
};
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
imgKoran.src = '/koran.png';

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