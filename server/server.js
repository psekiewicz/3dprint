'use strict';
// Serwer zamówień druku 3D. Bez zależności — wystarczy Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const WEB_DIR = ROOT;
// Strona leży w głównym katalogu repozytorium, więc serwujemy tylko te pliki (nie data/, server/ ani .git).
const WEB_FILES = ['/index.html', '/admin.html', '/app.js', '/admin.js', '/common.js', '/demo.js', '/viewer.js', '/config.js', '/style.css'];
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180] },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220] },
];
const STATUSES = ['new', 'printing', 'done', 'collected', 'rejected', 'cancelled'];
const ACTIVE = ['new', 'printing'];
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
    settings: {
      classCode: randomCode(6).toLowerCase(),
      adminPassword: hashPassword(password),
      maxActive: 2,
      maxFileMB: 50,
      printers: { mini: true, mk4s: true },
      filaments: [
        { id: 'f1', name: 'PLA czarny', color: '#1d1d1f', available: true },
        { id: 'f2', name: 'PLA biały', color: '#f4f4f4', available: true },
        { id: 'f3', name: 'PLA pomarańczowy', color: '#fa6831', available: true },
        { id: 'f4', name: 'PETG przezroczysty', color: '#cfe8f3', available: true },
      ],
    },
  };
  saveNow();
  console.log('=== PIERWSZE URUCHOMIENIE ===');
  console.log(`Hasło nauczyciela: ${password}`);
  console.log(`Kod klasy:         ${db.settings.classCode}`);
  console.log('Oba można zmienić w panelu nauczyciela (/admin.html).');
}
if (process.env.ADMIN_PASSWORD && !checkPassword(process.env.ADMIN_PASSWORD, db.settings.adminPassword)) {
  db.settings.adminPassword = hashPassword(process.env.ADMIN_PASSWORD);
  saveNow();
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
    printers: PRINTERS.map((p) => ({ ...p, enabled: !!s.printers[p.id] })),
    filaments: s.filaments,
    maxActive: s.maxActive,
    maxFileMB: s.maxFileMB,
  };
}
const publicOrder = ({ cancelToken, storedFile, ...rest }) => rest;

// ---------- autoryzacja ----------
const sessions = new Map(); // token -> czas wygaśnięcia
const loginFailures = new Map(); // ip -> { count, until }
const SESSION_MS = 12 * 60 * 60 * 1000;

function requireClass(req) {
  const code = header(req, 'x-class-code').trim().toLowerCase();
  if (!code || !safeEqual(code, db.settings.classCode.toLowerCase())) fail(401, 'Niepoprawny kod klasy.');
}
function requireAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) { sessions.delete(token); fail(401, 'Zaloguj się ponownie.'); }
}

// ---------- obsługa zamówień ----------
function createOrder(req, res) {
  requireClass(req);
  let meta;
  try { meta = JSON.parse(header(req, 'x-order')); } catch { fail(400, 'Brak danych zamówienia.'); }
  const s = db.settings;

  const name = text(meta.name, 60);
  const title = text(meta.title, 80);
  const fileName = text(meta.fileName, 120).replace(/[\\/]/g, '_');
  const ext = fileName.split('.').pop().toLowerCase();
  const quantity = Math.floor(Number(meta.quantity));
  const printer = meta.printer;
  const filament = s.filaments.find((f) => f.id === meta.filament && f.available);
  const size = Number(req.headers['content-length']);

  if (name.length < 3) fail(400, 'Podaj imię i nazwisko.');
  if (!title) fail(400, 'Podaj nazwę wydruku.');
  if (!EXTENSIONS.includes(ext)) fail(400, 'Dozwolone są tylko pliki STL i 3MF.');
  if (!(quantity >= 1 && quantity <= 10)) fail(400, 'Liczba sztuk musi być od 1 do 10.');
  if (printer !== 'any' && !(PRINTERS.some((p) => p.id === printer) && s.printers[printer])) fail(400, 'Wybierz dostępną drukarkę.');
  if (!filament) fail(400, 'Wybierz dostępny filament.');
  if (!(size > 0)) fail(400, 'Brak pliku z modelem.');
  if (size > s.maxFileMB * 1024 * 1024) fail(413, `Plik jest za duży (limit ${s.maxFileMB} MB).`);
  const active = db.orders.filter((o) => nameKey(o.name) === nameKey(name) && ACTIVE.includes(o.status)).length;
  if (active >= s.maxActive) fail(429, `Masz już ${active} aktywne zamówienia (limit: ${s.maxActive}). Poczekaj, aż któreś zostanie wydrukowane.`);

  const dims = Array.isArray(meta.dims) && meta.dims.length === 3 && meta.dims.every((d) => Number.isFinite(d) && d >= 0)
    ? meta.dims.map((d) => Math.round(d * 10) / 10) : null;

  const id = db.nextId++;
  const storedFile = `${id}.${ext}`;
  const target = path.join(UPLOAD_DIR, storedFile);
  const out = fs.createWriteStream(target);
  let done = false;
  const abort = () => { if (done) return; done = true; out.destroy(); fs.rm(target, { force: true }, () => {}); };
  req.on('aborted', abort);
  req.on('error', abort);
  out.on('error', () => { abort(); if (!res.headersSent) send(res, 500, { error: 'Nie udało się zapisać pliku.' }); });
  out.on('finish', () => {
    if (done) return;
    done = true;
    const order = {
      id, name, title, fileName, fileSize: size, dims, quantity, printer,
      filament: { id: filament.id, name: filament.name, color: filament.color },
      notes: longText(meta.notes, 500),
      status: 'new', assignedPrinter: null, teacherNote: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cancelToken: crypto.randomBytes(16).toString('hex'), storedFile,
    };
    db.orders.push(order);
    saveNow();
    send(res, 201, { order: publicOrder(order), cancelToken: order.cancelToken });
  });
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

    case 'POST /api/check-code':
      requireClass(req);
      return send(res, 200, { ok: true });

    case 'GET /api/orders':
      requireClass(req);
      return send(res, 200, { orders: db.orders.map(publicOrder) });

    case 'POST /api/orders':
      return createOrder(req, res);

    case 'POST /api/orders/:id/cancel': {
      requireClass(req);
      const body = await readJson(req);
      const order = findOrder(id);
      if (!body.token || !safeEqual(body.token, order.cancelToken)) fail(403, 'To zamówienie można anulować tylko z urządzenia, z którego zostało złożone.');
      if (order.status !== 'new') fail(409, 'Tego zamówienia nie da się już anulować.');
      order.status = 'cancelled';
      order.updatedAt = new Date().toISOString();
      saveNow();
      return send(res, 200, { order: publicOrder(order) });
    }

    case 'POST /api/admin/login': {
      const ip = req.socket.remoteAddress;
      const f = loginFailures.get(ip);
      if (f && f.until > Date.now()) fail(429, 'Za dużo prób. Spróbuj za chwilę.');
      const body = await readJson(req);
      if (!checkPassword(body.password || '', db.settings.adminPassword)) {
        const count = (f ? f.count : 0) + 1;
        loginFailures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
        fail(401, 'Niepoprawne hasło.');
      }
      loginFailures.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      return send(res, 200, { token });
    }

    case 'GET /api/admin/orders':
      requireAdmin(req);
      return send(res, 200, { orders: db.orders.map(publicOrder) });

    case 'PATCH /api/admin/orders/:id': {
      requireAdmin(req);
      const body = await readJson(req);
      const order = findOrder(id);
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) fail(400, 'Nieznany status.');
        order.status = body.status;
      }
      if (body.assignedPrinter !== undefined) {
        if (body.assignedPrinter !== null && !PRINTERS.some((p) => p.id === body.assignedPrinter)) fail(400, 'Nieznana drukarka.');
        order.assignedPrinter = body.assignedPrinter;
      }
      if (body.teacherNote !== undefined) order.teacherNote = longText(body.teacherNote, 500);
      order.updatedAt = new Date().toISOString();
      saveNow();
      return send(res, 200, { order: publicOrder(order) });
    }

    case 'DELETE /api/admin/orders/:id': {
      requireAdmin(req);
      const order = findOrder(id);
      db.orders = db.orders.filter((o) => o !== order);
      saveNow();
      fs.rm(path.join(UPLOAD_DIR, order.storedFile), { force: true }, () => {});
      return send(res, 200, { ok: true });
    }

    case 'GET /api/admin/orders/:id/file': {
      requireAdmin(req);
      const order = findOrder(id);
      const file = path.join(UPLOAD_DIR, order.storedFile);
      if (!fs.existsSync(file)) fail(404, 'Plik został usunięty.');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${order.id}-${order.fileName}`)}`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    case 'GET /api/admin/settings': {
      requireAdmin(req);
      const { adminPassword, ...settings } = db.settings;
      return send(res, 200, { settings });
    }

    case 'PUT /api/admin/settings': {
      requireAdmin(req);
      const body = await readJson(req);
      const s = db.settings;
      const classCode = text(body.classCode, 40);
      const maxActive = Math.floor(Number(body.maxActive));
      const maxFileMB = Math.floor(Number(body.maxFileMB));
      if (classCode.length < 3) fail(400, 'Kod klasy musi mieć co najmniej 3 znaki.');
      if (!(maxActive >= 1 && maxActive <= 50)) fail(400, 'Limit zamówień: od 1 do 50.');
      if (!(maxFileMB >= 1 && maxFileMB <= 200)) fail(400, 'Limit pliku: od 1 do 200 MB.');
      if (!Array.isArray(body.filaments) || body.filaments.length > 50) fail(400, 'Niepoprawna lista filamentów.');
      const filaments = body.filaments.map((f) => ({
        id: /^[\w-]{1,20}$/.test(f.id) ? f.id : 'f' + crypto.randomBytes(4).toString('hex'),
        name: text(f.name, 40),
        color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#888888',
        available: !!f.available,
      })).filter((f) => f.name);
      if (body.newPassword) {
        if (String(body.newPassword).length < 6) fail(400, 'Hasło musi mieć co najmniej 6 znaków.');
        s.adminPassword = hashPassword(String(body.newPassword));
      }
      Object.assign(s, {
        classCode, maxActive, maxFileMB, filaments,
        printers: Object.fromEntries(PRINTERS.map((p) => [p.id, !!(body.printers && body.printers[p.id])])),
      });
      saveNow();
      const { adminPassword, ...settings } = s;
      return send(res, 200, { settings });
    }
  }
  fail(404, 'Nie znaleziono.');
}

// ---------- pliki statyczne ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
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
