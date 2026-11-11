// Wersja pokazowa: zamiast serwera dane trafiają do pamięci tej przeglądarki
// (zamówienia do localStorage, pliki modeli do IndexedDB). Nic nie jest wysyłane, e-maile też nie.
const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180], maxColors: 1 },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220], maxColors: 5 },
];
const STATUSES = ['new', 'confirm', 'accepted', 'printing', 'done', 'collected', 'rejected', 'cancelled'];
const ACTIVE = ['new', 'confirm', 'accepted', 'printing'];
const KEY = 'demoDb2';

// Zapasowa pamięć na wypadek, gdy przeglądarka blokuje localStorage/IndexedDB (dane znikają po odświeżeniu).
let memoryDb = null;
const memoryFiles = new Map();

function load() {
  if (memoryDb) return memoryDb;
  try {
    const db = JSON.parse(localStorage.getItem(KEY));
    if (db && db.settings) return db;
  } catch { /* zaczynamy od nowa */ }
  const plain = 'zwykły plastik, pasuje do większości rzeczy';
  return {
    nextId: 1,
    orders: [],
    users: [],
    settings: {
      designFeeFrom: 10,
      classCode: 'demo',
      maxActive: 2,
      maxFileMB: 50,
      printers: { mini: true, mk4s: true },
      filaments: [
        { id: 'f1', name: 'PLA czarny', note: plain, color: '#1d1d1f', available: true, pricePerMinute: 0.05 },
        { id: 'f2', name: 'PLA biały', note: plain, color: '#f4f4f4', available: true, pricePerMinute: 0.05 },
        { id: 'f3', name: 'PLA pomarańczowy', note: plain, color: '#fa6831', available: true, pricePerMinute: 0.05 },
        { id: 'f4', name: 'PETG przezroczysty', note: 'mocniejszy, znosi ciepło i wodę', color: '#cfe8f3', available: true, pricePerMinute: 0.07 },
      ],
    },
  };
}
function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); memoryDb = null; } catch { memoryDb = db; }
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

// ---------- pliki w IndexedDB ----------
function files(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('druk3d-demo', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const request = action(tx.objectStore('files'));
      tx.oncomplete = () => { open.result.close(); resolve(request.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
export const demoFile = (id) => (memoryFiles.has(id) ? memoryFiles.get(id) : files('readonly', (store) => store.get(id)).catch(() => undefined));

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const long = (value, max) => String(value ?? '').trim().slice(0, max);
const nameKey = (name) => name.toLowerCase();
const cleanRate = (value) => { const r = Math.round(Number(value) * 1000) / 1000; return r >= 0 && r <= 100 ? r : 0; };
function reprice(order) {
  if (order.printMinutes == null && !order.serviceFee) { order.price = null; return; }
  const rate = Math.max(0, ...order.filaments.map((f) => f.pricePerMinute || 0));
  order.price = Math.round(((order.printMinutes || 0) * rate + (order.serviceFee || 0)) * 100) / 100;
}
function cleanLink(value) {
  const link = String(value ?? '').trim().slice(0, 500);
  if (!link) return '';
  try {
    const url = new URL(link);
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch { /* niżej */ }
  return fail(400, 'To nie wygląda na link. Skopiuj cały adres strony z modelem (zaczyna się od https://).');
}

export async function demoApi(path, { method = 'GET', headers = {}, json, body } = {}) {
  const db = load();
  const s = db.settings;
  const route = `${method} ${path.replace(/\/\d+(?=\/|$)/, '/:id')}`;
  const id = Number((path.match(/\/(\d+)(?:\/|$)/) || [])[1]);
  // W wersji pokazowej konto to samo imię — hasło nie jest sprawdzane.
  const me = () => db.users.find((u) => `Bearer demo-${u.id}` === headers.Authorization) || fail(401, 'Zaloguj się ponownie.');
  const find = () => db.orders.find((o) => o.id === id) || fail(404, 'Nie ma takiego zamówienia.');
  const mine = () => { const order = find(); if (order.userId !== me().id) fail(403, 'To nie jest Twoje zamówienie.'); return order; };
  const touch = (order) => { order.updatedAt = new Date().toISOString(); save(db); return { order, mail: null }; };

  switch (route) {
    case 'GET /api/config':
      return {
        designFeeFrom: s.designFeeFrom,
        printers: PRINTERS.map((p) => ({ ...p, enabled: !!s.printers[p.id] })),
        filaments: s.filaments, maxActive: s.maxActive, maxFileMB: s.maxFileMB,
      };

    case 'POST /api/register':
    case 'POST /api/login': {
      const name = clean(json.name, 60) || 'Gość';
      let user = db.users.find((u) => nameKey(u.name) === nameKey(name));
      if (!user) {
        user = { id: db.users.reduce((max, u) => Math.max(max, u.id), 0) + 1, name, email: clean(json.email, 120), createdAt: new Date().toISOString() };
        db.users.push(user);
        save(db);
      }
      return { user, token: `demo-${user.id}` };
    }

    case 'GET /api/orders':
    case 'GET /api/admin/orders':
      return { orders: db.orders };

    case 'POST /api/orders': {
      const meta = JSON.parse(decodeURIComponent(headers['X-Order']));
      const user = me();
      const title = clean(meta.title, 80);
      const notes = long(meta.notes, 1000);
      const filaments = (meta.filaments || []).map((fid) => s.filaments.find((f) => f.id === fid && f.available));
      const enabled = PRINTERS.filter((p) => s.printers[p.id]);
      const chosen = meta.printer === 'any' ? enabled : enabled.filter((p) => p.id === meta.printer);
      if (!title) fail(400, 'Nazwij jakoś swoje zamówienie.');
      if (!(meta.quantity >= 1 && meta.quantity <= 10)) fail(400, 'Liczba sztuk musi być od 1 do 10.');
      if (!chosen.length) fail(400, 'Wybierz dostępną drukarkę.');
      if (!filaments.length || filaments.includes(undefined)) fail(400, 'Wybierz kolor z listy.');
      if (filaments.length > Math.max(...chosen.map((p) => p.maxColors))) fail(400, 'Za dużo kolorów na tę drukarkę.');
      if (filaments.length > 1 && !long(meta.colorPlan, 500)) fail(400, 'Napisz, co ma być w którym kolorze.');
      const link = meta.kind === 'link' ? cleanLink(meta.link) : '';
      if (meta.kind === 'link' && !link) fail(400, 'Wklej link do modelu.');
      if (['find', 'design'].includes(meta.kind) && notes.length < 10) fail(400, 'Opisz w kilku słowach, o co Ci chodzi.');
      const active = db.orders.filter((o) => o.userId === user.id && ACTIVE.includes(o.status)).length;
      if (active >= s.maxActive) fail(429, `Masz już ${active} zamówienia w toku (limit: ${s.maxActive}). Poczekaj, aż któreś będzie gotowe.`);
      const hasFile = meta.kind === 'file';
      const order = {
        id: db.nextId++, userId: user.id, name: user.name, kind: meta.kind, title, link,
        quantity: Math.floor(meta.quantity), printer: meta.printer,
        filaments: filaments.map((f) => ({ id: f.id, name: f.name, color: f.color, pricePerMinute: cleanRate(f.pricePerMinute) })),
        colorPlan: long(meta.colorPlan, 500), notes,
        fileName: hasFile ? clean(meta.fileName, 120) : '', fileSize: hasFile ? body.size : 0, hasFile,
        dims: hasFile && meta.dims ? meta.dims.map((d) => Math.round(d * 10) / 10) : null,
        printMinutes: null, serviceFee: 0, price: null, paid: false,
        status: 'new', assignedPrinter: null, teacherNote: '',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      if (hasFile) {
        try { await files('readwrite', (store) => store.put(body, order.id)); }
        catch { memoryFiles.set(order.id, body); }
      }
      db.orders.push(order);
      save(db);
      return { order };
    }

    case 'POST /api/orders/:id/cancel': {
      const order = mine();
      if (!['new', 'confirm'].includes(order.status)) fail(409, 'Tego zamówienia nie da się już anulować — napisz do sprzedawcy.');
      order.status = 'cancelled';
      return touch(order);
    }

    case 'POST /api/orders/:id/confirm': {
      const order = mine();
      if (order.status !== 'confirm') fail(409, 'To zamówienie nie czeka teraz na potwierdzenie.');
      order.status = 'accepted';
      return touch(order);
    }

    case 'POST /api/admin/login':
      return { token: 'demo', admin: { id: 1, name: clean(json.name, 60) || 'demo' } };

    case 'GET /api/admin/sellers':
      return { sellers: [{ id: 1, name: 'demo' }], me: 1 };

    case 'POST /api/admin/sellers':
    case 'PUT /api/admin/sellers/:id/password':
    case 'DELETE /api/admin/sellers/:id':
      return fail(400, 'W wersji pokazowej nie da się zmieniać kont sprzedawców.');

    case 'GET /api/admin/users':
      return { users: db.users };

    case 'PUT /api/admin/users/:id/password':
      return { ok: true };

    case 'DELETE /api/admin/users/:id':
      db.users = db.users.filter((u) => u.id !== id);
      save(db);
      return { ok: true };

    case 'PATCH /api/admin/orders/:id': {
      const order = find();
      if (json.assignedPrinter !== undefined) order.assignedPrinter = json.assignedPrinter;
      if (json.teacherNote !== undefined) order.teacherNote = long(json.teacherNote, 500);
      if (json.link !== undefined) order.link = cleanLink(json.link);
      if (json.printMinutes !== undefined) {
        const m = json.printMinutes === null ? null : Math.round(Number(json.printMinutes));
        if (m !== null && !(m >= 1)) fail(400, 'Podaj czas druku w minutach (co najmniej 1).');
        order.printMinutes = m;
      }
      if (json.serviceFee !== undefined) order.serviceFee = Math.max(0, Math.round(Number(json.serviceFee || 0) * 100) / 100);
      reprice(order);
      if (json.paid !== undefined) order.paid = !!json.paid;
      if (json.status === 'confirm' && order.price == null) fail(400, 'Najpierw wpisz czas druku (albo opłatę), żeby kupujący zobaczył cenę.');
      if (STATUSES.includes(json.status)) order.status = json.status;
      order.handledBy = 'demo';
      return touch(order);
    }

    case 'DELETE /api/admin/orders/:id':
      find();
      db.orders = db.orders.filter((o) => o.id !== id);
      save(db);
      memoryFiles.delete(id);
      await files('readwrite', (store) => store.delete(id)).catch(() => {});
      return { ok: true };

    case 'GET /api/admin/settings':
      return { settings: s, mail: false };

    case 'PUT /api/admin/settings': {
      if (!(json.maxActive >= 1 && json.maxActive <= 50)) fail(400, 'Limit zamówień: od 1 do 50.');
      if (!(json.maxFileMB >= 1 && json.maxFileMB <= 200)) fail(400, 'Limit pliku: od 1 do 200 MB.');
      db.settings = {
        designFeeFrom: Math.max(0, Number(json.designFeeFrom) || 0),
        classCode: 'demo', // w wersji pokazowej kod i hasło są stałe
        maxActive: Math.floor(json.maxActive),
        maxFileMB: Math.floor(json.maxFileMB),
        printers: Object.fromEntries(PRINTERS.map((p) => [p.id, !!json.printers[p.id]])),
        filaments: json.filaments
          .map((f, i) => ({ id: f.id || `d${Date.now()}${i}`, name: clean(f.name, 40), note: clean(f.note, 80), color: f.color, available: !!f.available, pricePerMinute: cleanRate(f.pricePerMinute) }))
          .filter((f) => f.name),
      };
      save(db);
      return { settings: db.settings, mail: false };
    }
  }
  return fail(404, 'Nie znaleziono.');
}
