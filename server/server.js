'use strict';
// Serwer zamówień druku 3D. Bez zależności — wystarczy Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mail = require('./mail');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const WEB_DIR = ROOT;
// Strona leży w głównym katalogu repozytorium, więc serwujemy tylko te pliki (nie data/, server/ ani .git).
const WEB_FILES = ['/index.html', '/admin.html', '/app.js', '/admin.js', '/common.js', '/demo.js', '/viewer.js', '/config.js', '/style.css'];
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // adres strony do linków w e-mailach

const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180], maxColors: 1 },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220], maxColors: 5 }, // MMU3
];
// new: do wyceny · confirm: czeka na potwierdzenie kupującego · accepted: potwierdzone, w kolejce
const STATUSES = ['new', 'confirm', 'accepted', 'printing', 'done', 'collected', 'rejected', 'cancelled'];
const ACTIVE = ['new', 'confirm', 'accepted', 'printing'];
const KINDS = ['link', 'file', 'find', 'design'];
const EXTENSIONS = ['stl', '3mf'];

// ---------- baza danych (plik JSON) ----------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const randomCode = (n) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(password), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let db;
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} else {
  const password = process.env.ADMIN_PASSWORD || randomCode(10);
  db = {
    nextId: 1,
    orders: [],
    users: [],
    nextUserId: 1,
    settings: {
      designFeeFrom: 10,
      classCode: randomCode(6).toLowerCase(),
      adminPassword: hashPassword(password),
      maxActive: 2,
      maxFileMB: 50,
      printers: { mini: true, mk4s: true },
      filaments: [
        { id: 'f1', name: 'PLA czarny', note: 'zwykły plastik, pasuje do większości rzeczy', color: '#1d1d1f', available: true, pricePerMinute: 0.1 },
        { id: 'f2', name: 'PLA biały', note: 'zwykły plastik, pasuje do większości rzeczy', color: '#f4f4f4', available: true, pricePerMinute: 0.1 },
        { id: 'f3', name: 'PLA pomarańczowy', note: 'zwykły plastik, pasuje do większości rzeczy', color: '#fa6831', available: true, pricePerMinute: 0.1 },
        { id: 'f4', name: 'PETG przezroczysty', note: 'mocniejszy, znosi ciepło i wodę', color: '#cfe8f3', available: true, pricePerMinute: 0.12 },
      ],
    },
  };
  saveNow();
  console.log('=== PIERWSZE URUCHOMIENIE ===');
  console.log('Login sprzedawcy:  admin');
  console.log(`Hasło sprzedawcy:  ${password}`);
  console.log(`Kod klasy:         ${db.settings.classCode}`);
  console.log('Zmienisz je w panelu sprzedawcy (/admin.html); tam też dodasz kolejnych sprzedawców.');
}
// uzupełnienie baz utworzonych przez starsze wersje
db.users ||= [];
db.nextUserId ||= 1;
delete db.settings.shopName;
db.settings.designFeeFrom ??= 10;
for (const o of db.orders) {
  o.filaments ||= o.filament ? [o.filament] : [];
  o.kind ||= 'file';
  o.serviceFee ||= 0;
}
if (!db.settings.secret) { db.settings.secret = crypto.randomBytes(32).toString('hex'); saveNow(); }

// Sprzedawcy mają osobne konta; pierwsze („admin") powstaje z hasła z pierwszego uruchomienia.
if (!db.admins) {
  db.admins = [{ id: 1, name: 'admin', password: db.settings.adminPassword }];
  db.nextAdminId = 2;
  delete db.settings.adminPassword;
  saveNow();
}
// ADMIN_PASSWORD ustawia hasło konta „admin" (i odtwarza je, gdyby zostało usunięte) — ratunek po zapomnieniu haseł.
if (process.env.ADMIN_PASSWORD) {
  let main = db.admins.find((a) => a.name === 'admin');
  if (!main) { main = { id: db.nextAdminId++, name: 'admin', password: '' }; db.admins.push(main); }
  if (!checkPassword(process.env.ADMIN_PASSWORD, main.password)) { main.password = hashPassword(process.env.ADMIN_PASSWORD); saveNow(); }
}

function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- pomocnicze ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Za duże żądanie.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Niepoprawny JSON.')); }
    });
    req.on('error', reject);
  });
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const longText = (value, max) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
const nameKey = (name) => name.toLowerCase();
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function header(req, name) {
  try { return decodeURIComponent(req.headers[name] || ''); } catch { return ''; }
}

function publicConfig() {
  const s = db.settings;
  return {
    designFeeFrom: s.designFeeFrom,
    printers: PRINTERS.map((p) => ({ ...p, enabled: !!s.printers[p.id] })),
    filaments: s.filaments,
    maxActive: s.maxActive,
    maxFileMB: s.maxFileMB,
  };
}
const publicOrder = ({ cancelToken, storedFile, filament, ...rest }) => ({ ...rest, hasFile: !!storedFile });
// Cudze zamówienia w kolejce: tylko to, co potrzebne, bez linków, uwag i cen.
function queueOrder(o, user) {
  if (o.userId === user.id) return publicOrder(o);
  const { id, userId, name, title, kind, status, quantity, filaments, createdAt } = o;
  return { id, userId, name, title, kind, status, quantity, filaments, createdAt };
}

// Cena = najwyższa stawka z wybranych filamentów (zł/min) × czas druku (min) + opłata za usługę.
const cleanRate = (value) => { const r = Math.round(Number(value) * 1000) / 1000; return r >= 0 && r <= 100 ? r : 0; };
const orderRate = (order) => Math.max(0, ...order.filaments.map((f) => f.pricePerMinute || 0));
function reprice(order) {
  if (order.printMinutes == null && !order.serviceFee) { order.price = null; return; }
  order.price = Math.round(((order.printMinutes || 0) * orderRate(order) + (order.serviceFee || 0)) * 100) / 100;
}
function setPrintTime(order, minutes) {
  if (minutes === null || minutes === '') { order.printMinutes = null; return; }
  const m = Math.round(Number(minutes));
  if (!(m >= 1 && m <= 100000)) fail(400, 'Podaj czas druku w minutach (co najmniej 1).');
  order.printMinutes = m;
}
const cleanLink = (value) => {
  const link = String(value ?? '').trim().slice(0, 500);
  if (!link) return '';
  let url;
  try { url = new URL(link); } catch { fail(400, 'To nie wygląda na link. Skopiuj cały adres strony z modelem (zaczyna się od https://).'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'Link musi zaczynać się od http:// lub https://.');
  return url.href;
};
const cleanEmail = (value) => {
  const email = String(value ?? '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Podaj poprawny adres e-mail.');
  return email;
};

// ---------- e-maile do kupujących ----------
const firstName = (name) => name.split(' ')[0];
const money = (value) => `${value.toFixed(2).replace('.', ',')} zł`;
const duration = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
function orderMail(order, kind) {
  const user = db.users.find((u) => u.id === order.userId);
  if (!user || !user.email) return Promise.resolve('off');
  const where = PUBLIC_URL ? `Wejdź na ${PUBLIC_URL}` : 'Wejdź na stronę z zamówieniami';
  const lines = [`Cześć ${firstName(user.name)},`, ''];
  let subject;
  if (kind === 'confirm') {
    subject = `Potwierdź zamówienie #${order.id}: ${order.title}`;
    lines.push(`mamy wycenę Twojego zamówienia #${order.id} („${order.title}"). Zerknij, czy wszystko się zgadza:`, '');
    if (order.link) lines.push(`Model: ${order.link}`);
    lines.push(`Kolory: ${order.filaments.map((f) => f.name).join(', ')}`, `Sztuk: ${order.quantity}`);
    if (order.printMinutes) lines.push(`Czas druku: ok. ${duration(order.printMinutes)}`);
    if (order.serviceFee) lines.push(`Opłata za usługę: ${money(order.serviceFee)}`);
    lines.push(`Cena razem: ${money(order.price)}`);
    if (order.teacherNote) lines.push('', `Od nas: ${order.teacherNote}`);
    lines.push('', `${where}, zaloguj się i kliknij „Potwierdzam" albo „Rezygnuję".`, 'Bez Twojego potwierdzenia niczego nie drukujemy.');
  } else {
    subject = `Zamówienie #${order.id} gotowe do odbioru: ${order.title}`;
    lines.push(`Twój wydruk „${order.title}" (zamówienie #${order.id}) jest gotowy do odbioru.`);
    if (order.price != null && !order.paid) lines.push(`Do zapłaty: ${money(order.price)}.`);
    if (order.teacherNote) lines.push('', `Od nas: ${order.teacherNote}`);
  }
  return mail.send({ to: user.email, subject, text: lines.join('\n') });
}


// ---------- autoryzacja ----------
const sessions = new Map(); // token -> { adminId, expires }
const endSessions = (adminId, except) => { for (const [t, s] of sessions) if (s.adminId === adminId && t !== except) sessions.delete(t); };
const adminToken = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
const publicAdmin = (a) => ({ id: a.id, name: a.name });
const loginFailures = new Map(); // ip -> { count, until }
const SESSION_MS = 12 * 60 * 60 * 1000;

function requireClass(req) {
  const code = header(req, 'x-class-code').trim().toLowerCase();
  if (!code || !safeEqual(code, db.settings.classCode.toLowerCase())) fail(401, 'Niepoprawny kod klasy.');
}
// Token konta: nie wygasa, ale przestaje działać po zmianie hasła.
const userToken = (user) =>
  `${user.id}.${crypto.createHmac('sha256', db.settings.secret).update(`${user.id}:${user.password}`).digest('hex')}`;
function requireUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = db.users.find((u) => u.id === Number(token.split('.')[0]));
  if (!user || !safeEqual(token, userToken(user))) fail(401, 'Zaloguj się ponownie.');
  return user;
}
// Blokada po 5 nieudanych próbach logowania z jednego adresu.
// Za reverse proxy prawdziwy adres klienta to ostatni wpis X-Forwarded-For (dopisuje go proxy).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  const forwarded = TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return forwarded || req.socket.remoteAddress;
}
function throttle(req) {
  const ip = clientIp(req);
  const f = loginFailures.get(ip);
  if (f && f.until > Date.now()) fail(429, 'Za dużo prób. Spróbuj za minutę.');
  return {
    failed() {
      const count = (f ? f.count : 0) + 1;
      loginFailures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    },
    ok() { loginFailures.delete(ip); },
  };
}
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email || '', createdAt: user.createdAt });
function requireAdmin(req) {
  const token = adminToken(req);
  const session = sessions.get(token);
  const admin = session && session.expires > Date.now() && db.admins.find((a) => a.id === session.adminId);
  if (!admin) { sessions.delete(token); fail(401, 'Zaloguj się ponownie.'); }
  return admin;
}

// ---------- obsługa zamówień ----------
function createOrder(req, res) {
  const user = requireUser(req);
  let meta;
  try { meta = JSON.parse(header(req, 'x-order')); } catch { fail(400, 'Brak danych zamówienia.'); }
  const s = db.settings;

  const kind = meta.kind;
  const title = text(meta.title, 80);
  const notes = longText(meta.notes, 1000);
  const quantity = Math.floor(Number(meta.quantity));
  const printer = meta.printer || 'any';
  const ids = Array.isArray(meta.filaments) ? [...new Set(meta.filaments)] : [];
  const filaments = ids.map((id) => s.filaments.find((f) => f.id === id && f.available));
  const enabled = PRINTERS.filter((p) => s.printers[p.id]);
  const chosen = printer === 'any' ? enabled : enabled.filter((p) => p.id === printer);

  if (!KINDS.includes(kind)) fail(400, 'Wybierz, co chcesz zamówić.');
  if (!title) fail(400, 'Nazwij jakoś swoje zamówienie.');
  if (!(quantity >= 1 && quantity <= 10)) fail(400, 'Liczba sztuk musi być od 1 do 10.');
  if (!chosen.length) fail(400, 'Wybierz dostępną drukarkę.');
  if (!filaments.length || filaments.includes(undefined)) fail(400, 'Wybierz kolor z listy.');
  const maxColors = Math.max(...chosen.map((p) => p.maxColors));
  if (filaments.length > maxColors) {
    fail(400, maxColors > 1 ? `W jednym wydruku zmieści się najwyżej ${maxColors} kolorów.` : 'Ta drukarka drukuje tylko jednym kolorem naraz.');
  }
  const colorPlan = longText(meta.colorPlan, 500);
  if (filaments.length > 1 && !colorPlan) fail(400, 'Napisz, co ma być w którym kolorze.');
  const link = kind === 'link' ? cleanLink(meta.link) : '';
  if (kind === 'link' && !link) fail(400, 'Wklej link do modelu.');
  if ((kind === 'find' || kind === 'design') && notes.length < 10) fail(400, 'Opisz w kilku słowach, o co Ci chodzi.');
  const active = db.orders.filter((o) => o.userId === user.id && ACTIVE.includes(o.status)).length;
  if (active >= s.maxActive) fail(429, `Masz już ${active} zamówienia w toku (limit: ${s.maxActive}). Poczekaj, aż któreś będzie gotowe.`);

  const finish = (file) => {
    const order = {
      id: db.nextId++, userId: user.id, name: user.name, kind, title, link, quantity, printer,
      filaments: filaments.map((f) => ({ id: f.id, name: f.name, color: f.color, pricePerMinute: cleanRate(f.pricePerMinute) })),
      colorPlan, notes,
      fileName: '', fileSize: 0, dims: null, ...file,
      printMinutes: null, serviceFee: 0, price: null, paid: false,
      status: 'new', assignedPrinter: null, teacherNote: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.orders.push(order);
    saveNow();
    send(res, 201, { order: publicOrder(order) });
  };

  if (kind !== 'file') { req.resume(); return finish({}); }

  const fileName = text(meta.fileName, 120).replace(/[\\/]/g, '_');
  const ext = fileName.split('.').pop().toLowerCase();
  const size = Number(req.headers['content-length']);
  if (!EXTENSIONS.includes(ext)) fail(400, 'Przyjmujemy tylko pliki STL i 3MF.');
  if (!(size > 0)) fail(400, 'Brak pliku z modelem.');
  if (size > s.maxFileMB * 1024 * 1024) fail(413, `Plik jest za duży (limit ${s.maxFileMB} MB).`);
  const dims = Array.isArray(meta.dims) && meta.dims.length === 3 && meta.dims.every((d) => Number.isFinite(d) && d >= 0)
    ? meta.dims.map((d) => Math.round(d * 10) / 10) : null;

  const storedFile = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const target = path.join(UPLOAD_DIR, storedFile);
  const out = fs.createWriteStream(target);
  let done = false;
  const abort = () => { if (done) return; done = true; out.destroy(); fs.rm(target, { force: true }, () => {}); };
  req.on('aborted', abort);
  req.on('error', abort);
  out.on('error', () => { abort(); if (!res.headersSent) send(res, 500, { error: 'Nie udało się zapisać pliku.' }); });
  out.on('finish', () => { if (done) return; done = true; finish({ fileName, fileSize: size, dims, storedFile }); });
  req.pipe(out);
}

function findOrder(id) {
  const order = db.orders.find((o) => o.id === Number(id));
  if (!order) fail(404, 'Nie ma takiego zamówienia.');
  return order;
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname.replace(/\/\d+(?=\/|$)/, '/:id')}`;
  const id = (url.pathname.match(/\/(\d+)(?:\/|$)/) || [])[1];

  switch (route) {
    case 'GET /api/config':
      return send(res, 200, publicConfig());

    case 'POST /api/register': {
      requireClass(req);
      const body = await readJson(req);
      const name = text(body.name, 60);
      const password = String(body.password || '');
      if (name.length < 3) fail(400, 'Podaj imię i nazwisko.');
      const email = cleanEmail(body.email);
      if (password.length < 6 || password.length > 100) fail(400, 'Hasło musi mieć co najmniej 6 znaków.');
      if (db.users.some((u) => nameKey(u.name) === nameKey(name))) fail(409, 'Takie konto już istnieje. Zaloguj się albo poproś sprzedawcę o nowe hasło.');
      if (db.users.length >= 500) fail(403, 'Osiągnięto limit kont.');
      const user = { id: db.nextUserId++, name, email, password: hashPassword(password), createdAt: new Date().toISOString() };
      db.users.push(user);
      saveNow();
      return send(res, 201, { user: publicUser(user), token: userToken(user) });
    }

    case 'POST /api/login': {
      const attempt = throttle(req);
      const body = await readJson(req);
      const user = db.users.find((u) => nameKey(u.name) === nameKey(text(body.name, 60)));
      if (!user || !checkPassword(body.password || '', user.password)) { attempt.failed(); fail(401, 'Niepoprawne imię i nazwisko lub hasło.'); }
      attempt.ok();
      return send(res, 200, { user: publicUser(user), token: userToken(user) });
    }

    case 'GET /api/orders': {
      const user = requireUser(req);
      return send(res, 200, { orders: db.orders.map((o) => queueOrder(o, user)) });
    }

    case 'POST /api/orders':
      return createOrder(req, res);

    case 'POST /api/orders/:id/cancel': {
      const user = requireUser(req);
      const order = findOrder(id);
      if (order.userId !== user.id) fail(403, 'To nie jest Twoje zamówienie.');
      if (!['new', 'confirm'].includes(order.status)) fail(409, 'Tego zamówienia nie da się już anulować — napisz do sprzedawcy.');
      order.status = 'cancelled';
      order.updatedAt = new Date().toISOString();
      saveNow();
      return send(res, 200, { order: publicOrder(order) });
    }

    case 'POST /api/orders/:id/confirm': {
      const user = requireUser(req);
      const order = findOrder(id);
      if (order.userId !== user.id) fail(403, 'To nie jest Twoje zamówienie.');
      if (order.status !== 'confirm') fail(409, 'To zamówienie nie czeka teraz na potwierdzenie.');
      order.status = 'accepted';
      order.updatedAt = new Date().toISOString();
      saveNow();
      return send(res, 200, { order: publicOrder(order) });
    }

    case 'POST /api/admin/login': {
      const attempt = throttle(req);
      const body = await readJson(req);
      const admin = db.admins.find((a) => nameKey(a.name) === nameKey(text(body.name, 60)));
      if (!admin || !checkPassword(body.password || '', admin.password)) { attempt.failed(); fail(401, 'Niepoprawny login lub hasło.'); }
      attempt.ok();
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { adminId: admin.id, expires: Date.now() + SESSION_MS });
      return send(res, 200, { token, admin: publicAdmin(admin) });
    }

    case 'GET /api/admin/orders':
      requireAdmin(req);
      return send(res, 200, { orders: db.orders.map(publicOrder) });

    case 'PATCH /api/admin/orders/:id': {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const order = findOrder(id);
      const before = order.status;
      if (body.status !== undefined && !STATUSES.includes(body.status)) fail(400, 'Nieznany status.');
      if (body.assignedPrinter !== undefined) {
        if (body.assignedPrinter !== null && !PRINTERS.some((p) => p.id === body.assignedPrinter)) fail(400, 'Nieznana drukarka.');
        order.assignedPrinter = body.assignedPrinter;
      }
      if (body.teacherNote !== undefined) order.teacherNote = longText(body.teacherNote, 500);
      if (body.link !== undefined) order.link = cleanLink(body.link);
      if (body.printMinutes !== undefined) setPrintTime(order, body.printMinutes);
      if (body.serviceFee !== undefined) {
        const fee = Math.round(Number(body.serviceFee || 0) * 100) / 100;
        if (!(fee >= 0 && fee <= 10000)) fail(400, 'Opłata za usługę: od 0 zł.');
        order.serviceFee = fee;
      }
      reprice(order);
      if (body.paid !== undefined) order.paid = !!body.paid;
      if (body.status === 'confirm' && order.price == null) fail(400, 'Najpierw wpisz czas druku (albo opłatę), żeby kupujący zobaczył cenę.');
      if (body.status !== undefined) order.status = body.status;
      order.handledBy = admin.name;
      order.updatedAt = new Date().toISOString();
      saveNow();
      // e-mail tylko przy wejściu w dany status, nie przy każdym zapisie
      let mailed = null;
      if (order.status !== before && order.status === 'confirm') mailed = await orderMail(order, 'confirm');
      if (order.status !== before && order.status === 'done') mailed = await orderMail(order, 'done');
      return send(res, 200, { order: publicOrder(order), mail: mailed });
    }

    case 'DELETE /api/admin/orders/:id': {
      requireAdmin(req);
      const order = findOrder(id);
      db.orders = db.orders.filter((o) => o !== order);
      saveNow();
      if (order.storedFile) fs.rm(path.join(UPLOAD_DIR, order.storedFile), { force: true }, () => {});
      return send(res, 200, { ok: true });
    }

    case 'GET /api/admin/orders/:id/file': {
      requireAdmin(req);
      const order = findOrder(id);
      const file = path.join(UPLOAD_DIR, order.storedFile || 'brak');
      if (!order.storedFile || !fs.existsSync(file)) fail(404, 'To zamówienie nie ma pliku.');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${order.id}-${order.fileName}`)}`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    case 'GET /api/admin/sellers': {
      const admin = requireAdmin(req);
      return send(res, 200, { sellers: db.admins.map(publicAdmin), me: admin.id });
    }

    case 'POST /api/admin/sellers': {
      requireAdmin(req);
      const body = await readJson(req);
      const name = text(body.name, 60);
      if (name.length < 3) fail(400, 'Login musi mieć co najmniej 3 znaki.');
      if (String(body.password || '').length < 8) fail(400, 'Hasło sprzedawcy musi mieć co najmniej 8 znaków.');
      if (db.admins.some((a) => nameKey(a.name) === nameKey(name))) fail(409, 'Taki sprzedawca już istnieje.');
      if (db.admins.length >= 10) fail(403, 'Osiągnięto limit sprzedawców.');
      const seller = { id: db.nextAdminId++, name, password: hashPassword(String(body.password)) };
      db.admins.push(seller);
      saveNow();
      return send(res, 201, { seller: publicAdmin(seller) });
    }

    case 'PUT /api/admin/sellers/:id/password': {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      if (admin.id !== Number(id)) fail(403, 'Możesz zmienić tylko własne hasło.');
      if (String(body.password || '').length < 8) fail(400, 'Hasło sprzedawcy musi mieć co najmniej 8 znaków.');
      admin.password = hashPassword(String(body.password));
      endSessions(admin.id, adminToken(req));
      saveNow();
      return send(res, 200, { ok: true });
    }

    case 'DELETE /api/admin/sellers/:id': {
      const admin = requireAdmin(req);
      if (admin.id === Number(id)) fail(400, 'Nie możesz usunąć własnego konta.');
      if (!db.admins.some((a) => a.id === Number(id))) fail(404, 'Nie ma takiego sprzedawcy.');
      db.admins = db.admins.filter((a) => a.id !== Number(id));
      endSessions(Number(id));
      saveNow();
      return send(res, 200, { ok: true });
    }

    case 'GET /api/admin/users':
      requireAdmin(req);
      return send(res, 200, { users: db.users.map(publicUser) });

    case 'PUT /api/admin/users/:id/password': {
      requireAdmin(req);
      const body = await readJson(req);
      const user = db.users.find((u) => u.id === Number(id));
      if (!user) fail(404, 'Nie ma takiego konta.');
      if (String(body.password || '').length < 6) fail(400, 'Hasło musi mieć co najmniej 6 znaków.');
      user.password = hashPassword(String(body.password));
      saveNow();
      return send(res, 200, { ok: true });
    }

    case 'DELETE /api/admin/users/:id': {
      requireAdmin(req);
      if (!db.users.some((u) => u.id === Number(id))) fail(404, 'Nie ma takiego konta.');
      db.users = db.users.filter((u) => u.id !== Number(id));
      saveNow();
      return send(res, 200, { ok: true });
    }

    case 'GET /api/admin/settings': {
      requireAdmin(req);
      const { secret, ...settings } = db.settings;
      return send(res, 200, { settings, mail: mail.enabled() });
    }

    case 'PUT /api/admin/settings': {
      requireAdmin(req);
      const body = await readJson(req);
      const s = db.settings;
      const classCode = text(body.classCode, 40);
      const designFeeFrom = Math.round(Number(body.designFeeFrom) * 100) / 100;
      if (!(designFeeFrom >= 0 && designFeeFrom <= 10000)) fail(400, 'Cena projektu: od 0 zł.');
      const maxActive = Math.floor(Number(body.maxActive));
      const maxFileMB = Math.floor(Number(body.maxFileMB));
      if (classCode.length < 3) fail(400, 'Kod klasy musi mieć co najmniej 3 znaki.');
      if (!(maxActive >= 1 && maxActive <= 50)) fail(400, 'Limit zamówień: od 1 do 50.');
      if (!(maxFileMB >= 1 && maxFileMB <= 200)) fail(400, 'Limit pliku: od 1 do 200 MB.');
      if (!Array.isArray(body.filaments) || body.filaments.length > 50) fail(400, 'Niepoprawna lista filamentów.');
      const filaments = body.filaments.map((f) => ({
        id: /^[\w-]{1,20}$/.test(f.id) ? f.id : 'f' + crypto.randomBytes(4).toString('hex'),
        name: text(f.name, 40),
        note: text(f.note, 80),
        color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#888888',
        available: !!f.available,
        pricePerMinute: cleanRate(f.pricePerMinute),
      })).filter((f) => f.name);
      Object.assign(s, {
        designFeeFrom, classCode, maxActive, maxFileMB, filaments,
        printers: Object.fromEntries(PRINTERS.map((p) => [p.id, !!(body.printers && body.printers[p.id])])),
      });
      saveNow();
      const { secret, ...settings } = s;
      return send(res, 200, { settings, mail: mail.enabled() });
    }
  }
  fail(404, 'Nie znaleziono.');
}

// ---------- pliki statyczne ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Niedozwolona metoda.' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Zły adres.' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WEB_DIR, rel);
  const inVendor = file.startsWith(path.join(WEB_DIR, 'vendor') + path.sep);
  if (!WEB_FILES.includes(rel) && !inVendor) return send(res, 404, { error: 'Nie znaleziono.' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { error: 'Nie znaleziono.' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- serwer ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Class-Code, X-Order');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  Promise.resolve().then(() => api(req, res, url)).catch((err) => {
    if (res.headersSent) return res.destroy();
    if (!(err instanceof HttpError)) console.error(err);
    req.resume(); // dokończ odbieranie treści, żeby przeglądarka dostała odpowiedź
    send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Błąd serwera.' });
  });
});

server.listen(PORT, () => console.log(`Zamówienia druku 3D działają na http://localhost:${PORT}`));
