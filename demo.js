// Wersja pokazowa: zamiast serwera dane trafiają do pamięci tej przeglądarki
// (zamówienia do localStorage, pliki modeli do IndexedDB). Nic nie jest wysyłane.
const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180] },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220] },
];
const STATUSES = ['new', 'printing', 'done', 'collected', 'rejected', 'cancelled'];
const KEY = 'demoDb';

// Zapasowa pamięć na wypadek, gdy przeglądarka blokuje localStorage/IndexedDB (dane znikają po odświeżeniu).
let memoryDb = null;
const memoryFiles = new Map();

function load() {
  if (memoryDb) return memoryDb;
  try {
    const db = JSON.parse(localStorage.getItem(KEY));
    if (db && db.settings) return db;
  } catch { /* zaczynamy od nowa */ }
  return {
    nextId: 1,
    orders: [],
    settings: {
      classCode: 'demo',
      maxActive: 2,
      maxFileMB: 50,
      printers: { mini: true, mk4s: true },
      filaments: [
        { id: 'f1', name: 'PLA czarny', color: '#1d1d1f', available: true, pricePerMinute: 0.05 },
        { id: 'f2', name: 'PLA biały', color: '#f4f4f4', available: true, pricePerMinute: 0.05 },
        { id: 'f3', name: 'PLA pomarańczowy', color: '#fa6831', available: true, pricePerMinute: 0.05 },
        { id: 'f4', name: 'PETG przezroczysty', color: '#cfe8f3', available: true, pricePerMinute: 0.07 },
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
const nameKey = (name) => name.toLowerCase();
const publicOrder = ({ cancelToken, ...rest }) => rest;

// Cena = stawka filamentu (zł/min) × czas druku (min).
function setPrintTime(order, minutes, filaments) {
  if (minutes === null || minutes === '') { order.printMinutes = null; order.price = null; return; }
  const m = Math.round(Number(minutes));
  if (!(m >= 1 && m <= 100000)) fail(400, 'Podaj czas druku w minutach (co najmniej 1).');
  const current = filaments.find((f) => f.id === order.filament.id);
  const rate = order.filament.pricePerMinute ?? (current ? current.pricePerMinute : 0) ?? 0;
  order.printMinutes = m;
  order.price = Math.round(m * rate * 100) / 100;
}
const cleanRate = (value) => { const r = Math.round(Number(value) * 1000) / 1000; return r >= 0 && r <= 100 ? r : 0; };


export async function demoApi(path, { method = 'GET', headers = {}, json, body } = {}) {
  const db = load();
  const s = db.settings;
  const route = `${method} ${path.replace(/\/\d+(?=\/|$)/, '/:id')}`;
  const id = Number((path.match(/\/(\d+)(?:\/|$)/) || [])[1]);
  const find = () => db.orders.find((o) => o.id === id) || fail(404, 'Nie ma takiego zamówienia.');

  switch (route) {
    case 'GET /api/config':
      return { printers: PRINTERS.map((p) => ({ ...p, enabled: !!s.printers[p.id] })), filaments: s.filaments, maxActive: s.maxActive, maxFileMB: s.maxFileMB };

    case 'POST /api/check-code':
      return { ok: true };

    case 'GET /api/orders':
    case 'GET /api/admin/orders':
      return { orders: db.orders.map(publicOrder) };

    case 'POST /api/orders': {
      const meta = JSON.parse(decodeURIComponent(headers['X-Order']));
      const name = clean(meta.name, 60);
      const title = clean(meta.title, 80);
      const filament = s.filaments.find((f) => f.id === meta.filament && f.available);
      if (!title) fail(400, 'Podaj nazwę wydruku.');
      if (!(meta.quantity >= 1 && meta.quantity <= 10)) fail(400, 'Liczba sztuk musi być od 1 do 10.');
      if (!filament) fail(400, 'Wybierz dostępny filament.');
      const active = db.orders.filter((o) => nameKey(o.name) === nameKey(name) && ['new', 'printing'].includes(o.status)).length;
      if (active >= s.maxActive) fail(429, `Masz już ${active} aktywne zamówienia (limit: ${s.maxActive}). Poczekaj, aż któreś zostanie wydrukowane.`);
      const order = {
        id: db.nextId++, name, title, fileName: clean(meta.fileName, 120), fileSize: body.size,
        dims: meta.dims ? meta.dims.map((d) => Math.round(d * 10) / 10) : null,
        quantity: Math.floor(meta.quantity), printer: meta.printer,
        filament: { id: filament.id, name: filament.name, color: filament.color, pricePerMinute: cleanRate(filament.pricePerMinute) },
        printMinutes: null, price: null, paid: false,
        notes: String(meta.notes ?? '').trim().slice(0, 500),
        status: 'new', assignedPrinter: null, teacherNote: '',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        cancelToken: crypto.randomUUID(),
      };
      try { await files('readwrite', (store) => store.put(body, order.id)); }
      catch { memoryFiles.set(order.id, body); }
      db.orders.push(order);
      save(db);
      return { order: publicOrder(order), cancelToken: order.cancelToken };
    }

    case 'POST /api/orders/:id/cancel': {
      const order = find();
      if (json.token !== order.cancelToken) fail(403, 'To zamówienie można anulować tylko z urządzenia, z którego zostało złożone.');
      if (order.status !== 'new') fail(409, 'Tego zamówienia nie da się już anulować.');
      order.status = 'cancelled';
      save(db);
      return { order: publicOrder(order) };
    }

    case 'POST /api/admin/login':
      return { token: 'demo' };

    case 'PATCH /api/admin/orders/:id': {
      const order = find();
      if (STATUSES.includes(json.status)) order.status = json.status;
      if (json.assignedPrinter !== undefined) order.assignedPrinter = json.assignedPrinter;
      if (json.teacherNote !== undefined) order.teacherNote = String(json.teacherNote).trim().slice(0, 500);
      if (json.printMinutes !== undefined) setPrintTime(order, json.printMinutes, s.filaments);
      if (json.paid !== undefined) order.paid = !!json.paid;
      order.updatedAt = new Date().toISOString();
      save(db);
      return { order: publicOrder(order) };
    }

    case 'DELETE /api/admin/orders/:id':
      find();
      db.orders = db.orders.filter((o) => o.id !== id);
      save(db);
      memoryFiles.delete(id);
      await files('readwrite', (store) => store.delete(id)).catch(() => {});
      return { ok: true };

    case 'GET /api/admin/settings':
      return { settings: s };

    case 'PUT /api/admin/settings': {
      if (!(json.maxActive >= 1 && json.maxActive <= 50)) fail(400, 'Limit zamówień: od 1 do 50.');
      if (!(json.maxFileMB >= 1 && json.maxFileMB <= 200)) fail(400, 'Limit pliku: od 1 do 200 MB.');
      db.settings = {
        classCode: 'demo', // w wersji pokazowej kod i hasło są stałe
        maxActive: Math.floor(json.maxActive),
        maxFileMB: Math.floor(json.maxFileMB),
        printers: Object.fromEntries(PRINTERS.map((p) => [p.id, !!json.printers[p.id]])),
        filaments: json.filaments
          .map((f, i) => ({ id: f.id || `d${Date.now()}${i}`, name: clean(f.name, 40), color: f.color, available: !!f.available, pricePerMinute: cleanRate(f.pricePerMinute) }))
          .filter((f) => f.name),
      };
      save(db);
      return { settings: db.settings };
    }
  }
  fail(404, 'Nie znaleziono.');
}
