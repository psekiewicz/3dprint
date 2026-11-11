import { api, h, $, setDemo, showDemoBanner, fits, swatch, formatRate, formatPrice, priceText, statusBadge, formatDate, formatDims, formatSize } from './common.js';

const store = {
  get: (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* tryb prywatny */ } },
};

let user = store.get('user', null); // { id, name, token }
if (user && !user.token) user = null; // zapis ze starszej wersji
let config = null;
let orders = [];
let model = null; // { file, dims, object }
let viewer = null;
let viewerModule = null;
let filter = 'active';

const authHeaders = () => ({ Authorization: `Bearer ${user.token}` });
const isMine = (o) => o.userId === user.id;
const isActive = (o) => o.status === 'new' || o.status === 'printing';

// ---------- logowanie ----------
function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#logout').hidden = true;
  $('#who').textContent = '';
  $('#login-error').textContent = message;
  if (user) $('#login-name').value = user.name;
  $('#login-password').value = '';
}

let registering = false;
function setRegistering(on) {
  registering = on;
  $('#login-title').textContent = on ? 'Nowe konto' : 'Logowanie';
  $('#login-submit').textContent = on ? 'Załóż konto' : 'Zaloguj';
  $('#toggle-register').textContent = on ? 'Mam już konto' : 'Załóż konto';
  $('#register-fields').hidden = !on;
  $('#forgot').hidden = on;
  $('#login-code').required = on;
  $('#login-password').autocomplete = on ? 'new-password' : 'current-password';
  $('#login-error').textContent = '';
}
$('#toggle-register').addEventListener('click', () => setRegistering(!registering));

async function signIn(path, body, headers = {}) {
  const result = await api(path, { method: 'POST', json: body, headers });
  user = { ...result.user, token: result.token };
  store.set('user', user);
  start();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { name: $('#login-name').value.trim().replace(/\s+/g, ' '), password: $('#login-password').value };
  setDemo(false);
  try {
    if (registering) await signIn('/api/register', body, { 'X-Class-Code': encodeURIComponent($('#login-code').value.trim()) });
    else await signIn('/api/login', body);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#open-demo').addEventListener('click', async () => {
  setDemo(true);
  await signIn('/api/login', { name: $('#login-name').value.trim() || 'Gość' });
});

$('#logout').addEventListener('click', () => {
  user = null;
  store.set('user', null);
  setDemo(false);
  showLogin();
});

// ---------- start ----------
async function start() {
  if (!user) return showLogin();
  try {
    config = await api('/api/config');
    await loadOrders();
  } catch (err) {
    return showLogin(err.status === 401 ? 'Zaloguj się ponownie.' : err.message);
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  $('#who').textContent = user.name;
  renderChoices();
  renderFit();
}

async function loadOrders() {
  orders = (await api('/api/orders', { headers: authHeaders() })).orders;
  renderOrders();
}

// ---------- formularz ----------
function choice(group, value, label, { checked = false, disabled = false } = {}) {
  return h('label', { class: 'choice' },
    h('input', { type: 'radio', name: group, value, checked, disabled, required: true }),
    h('span', {}, label));
}

function renderChoices() {
  const selectedPrinter = document.querySelector('input[name=printer]:checked')?.value ?? 'any';
  const enabled = config.printers.filter((p) => p.enabled);
  const fit = (p) => fits(model?.dims, p.volume) !== 'no';
  const options = [
    { id: 'any', name: 'Dowolna', ok: enabled.some(fit) },
    ...enabled.map((p) => ({ id: p.id, name: p.name, ok: fit(p) })),
  ];
  const pick = options.find((o) => o.id === selectedPrinter && o.ok) || options.find((o) => o.ok);
  $('#printers').replaceChildren(...options.map((o) =>
    choice('printer', o.id, o.name, { checked: o === pick, disabled: !o.ok })));
  $('#printers').onchange = () => updateBed();

  const selectedFilament = document.querySelector('input[name=filament]:checked')?.value;
  const available = config.filaments.filter((f) => f.available);
  $('#filaments').replaceChildren(...(available.length
    ? available.map((f) => choice('filament', f.id, [swatch(f.color), `${f.name} · ${formatRate(f.pricePerMinute)}`], { checked: f.id === selectedFilament }))
    : [h('span', { class: 'hint' }, 'Brak dostępnych filamentów — zapytaj sprzedawcę.')]));

  const mine = orders.filter((o) => isMine(o) && isActive(o)).length;
  $('#limit-info').textContent = `Twoje aktywne zamówienia: ${mine} z ${config.maxActive}`;
  updateBed();
}

function bedVolume() {
  const id = document.querySelector('input[name=printer]:checked')?.value;
  const enabled = config.printers.filter((p) => p.enabled);
  const printer = enabled.find((p) => p.id === id)
    || enabled.find((p) => fits(model?.dims, p.volume) !== 'no'); // „Dowolna": pierwsza, w której się mieści
  return printer ? printer.volume : null;
}
function updateBed() {
  if (viewer && model) viewer.setVolume(bedVolume());
}

function renderFit() {
  const list = $('#fit');
  if (!model?.dims) return list.replaceChildren();
  const words = { yes: 'mieści się', rotated: 'mieści się po obróceniu', no: 'za duży' };
  const marks = { yes: '✓', rotated: '↻', no: '✕' };
  list.replaceChildren(
    h('li', {}, `Wymiary: ${formatDims(model.dims)}`),
    ...config.printers.filter((p) => p.enabled).map((p) => {
      const result = fits(model.dims, p.volume);
      return h('li', { class: result }, `${marks[result]} ${p.name} (${p.volume.join(' × ')} mm): ${words[result]}`);
    }),
  );
}

async function selectFile(file) {
  $('#order-error').textContent = '';
  $('#order-success').textContent = '';
  model = null;
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['stl', '3mf'].includes(extension)) return fileError('Dozwolone są tylko pliki STL i 3MF.');
  if (file.size > config.maxFileMB * 1048576) return fileError(`Plik jest za duży (limit ${config.maxFileMB} MB).`);

  $('#file-info').textContent = `${file.name} · ${formatSize(file.size)}`;
  if (!$('#title').value) $('#title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  model = { file, dims: null };
  const preview = $('#preview');
  if (!viewer) preview.textContent = 'Wczytywanie modelu…';

  try {
    viewerModule ??= await import('./viewer.js');
    const object = viewerModule.parseModel(await file.arrayBuffer(), extension);
    if (model.file !== file) return; // w międzyczasie wybrano inny plik
    model.dims = viewerModule.measure(object);
    if (!model.dims.every((d) => d > 0)) throw new Error('pusty model');
    renderChoices();
    renderFit();
    try {
      viewer ??= new viewerModule.Viewer(preview);
      viewer.show(object, bedVolume());
    } catch {
      preview.textContent = 'Podgląd 3D nie działa w tej przeglądarce, ale zamówienie można złożyć.';
    }
  } catch {
    if (model?.file !== file) return;
    model = null;
    viewer = null;
    preview.textContent = 'Tu pojawi się podgląd modelu';
    fileError('Nie udało się odczytać modelu — plik jest uszkodzony albo to nie jest STL/3MF.');
  }
}

function fileError(message) {
  model = null;
  $('#file').value = '';
  $('#file-info').textContent = '';
  $('#order-error').textContent = message;
  renderChoices();
  renderFit();
}

const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); selectFile(e.dataTransfer.files[0]); });
$('#file').addEventListener('change', (e) => selectFile(e.target.files[0]));

$('#order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#order-error');
  const success = $('#order-success');
  error.textContent = success.textContent = '';
  const printer = document.querySelector('input[name=printer]:checked')?.value;
  const filament = document.querySelector('input[name=filament]:checked')?.value;
  if (!model) { error.textContent = 'Wybierz plik z modelem.'; return; }
  if (!printer) { error.textContent = 'Model nie mieści się w żadnej drukarce — zmniejsz go albo podziel na części.'; return; }
  if (!filament) { error.textContent = 'Wybierz filament.'; return; }

  const meta = {
    title: $('#title').value,
    fileName: model.file.name,
    quantity: Number($('#quantity').value),
    printer, filament,
    notes: $('#notes').value,
    dims: model.dims,
  };
  const button = $('#submit');
  button.disabled = true;
  button.textContent = 'Wysyłanie…';
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-Order': encodeURIComponent(JSON.stringify(meta)), 'Content-Type': 'application/octet-stream' },
      body: model.file,
    });
    success.textContent = `Zamówienie nr ${result.order.id} zostało przyjęte.`;
    $('#title').value = $('#notes').value = $('#file').value = '';
    $('#quantity').value = 1;
    $('#file-info').textContent = '';
    model = null;
    renderFit();
    await loadOrders();
    renderChoices();
  } catch (err) {
    if (err.status === 401) return showLogin('Zaloguj się ponownie.');
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Złóż zamówienie';
  }
});

// ---------- kolejka ----------
const FILTERS = {
  active: ['W kolejce', (o) => isActive(o)],
  mine: ['Moje', (o) => isMine(o)],
  done: ['Gotowe', (o) => o.status === 'done'],
  all: ['Wszystkie', () => true],
};

function renderOrders() {
  $('#tabs').replaceChildren(...Object.entries(FILTERS).map(([key, [label, test]]) =>
    h('button', {
      type: 'button', class: `small ${key === filter ? 'active' : ''}`,
      onclick: () => { filter = key; renderOrders(); },
    }, `${label} (${orders.filter(test).length})`)));

  const printerName = (id) => config.printers.find((p) => p.id === id)?.name;
  const visible = orders.filter(FILTERS[filter][1]);
  // aktywne: od najstarszego (kolejność druku); pozostałe: od najnowszego
  visible.sort((a, b) => (filter === 'active' ? a.id - b.id : b.id - a.id));

  $('#orders').replaceChildren(...(visible.length ? visible.map((o) => {
    const mine = isMine(o);
    const printer = o.assignedPrinter ? printerName(o.assignedPrinter) : (printerName(o.printer) || 'dowolna drukarka');
    return h('div', { class: `order ${mine ? 'mine' : ''}` },
      h('div', { class: 'order-head' },
        h('span', { class: 'title' }, `#${o.id} ${o.title}`),
        statusBadge(o.status),
        mine && o.status === 'new' && h('button', { class: 'small danger', type: 'button', onclick: () => cancelOrder(o) }, 'Anuluj')),
      h('div', { class: 'order-meta' },
        `${o.name} · ${formatDate(o.createdAt)} · ${printer} · `, swatch(o.filament.color), ` ${o.filament.name} · ${o.quantity} szt.`),
      o.price != null && h('div', { class: 'order-price' }, priceText(o), ' ',
        h('span', { class: `badge ${o.paid ? 'badge-done' : 'badge-new'}` }, o.paid ? 'Zapłacone' : 'Do zapłaty')),
      o.teacherNote && h('div', { class: 'order-note' }, `Sprzedawca: ${o.teacherNote}`));
  }) : [h('div', { class: 'empty' }, 'Brak zamówień.')]));
}

async function cancelOrder(order) {
  if (!confirm(`Anulować zamówienie #${order.id} „${order.title}"?`)) return;
  try {
    await api(`/api/orders/${order.id}/cancel`, { method: 'POST', headers: authHeaders() });
  } catch (err) {
    alert(err.message);
  }
  await loadOrders().catch(() => {});
  renderChoices();
}

// odświeżanie kolejki co 30 s, gdy karta jest widoczna
setInterval(() => {
  if (user && !$('#app').hidden && !document.hidden) loadOrders().then(renderChoices).catch(() => {});
}, 30000);

showDemoBanner();
start();
