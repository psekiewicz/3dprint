import { API, api, h, $, DEMO_CODE, isDemo, setDemo, showDemoBanner, STATUS, fits, swatch, statusBadge, formatDate, formatDims, formatSize } from './common.js';

const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180] },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220] },
];
const FILTERS = {
  new: ['Oczekujące', (o) => o.status === 'new'],
  printing: ['W druku', (o) => o.status === 'printing'],
  done: ['Do odbioru', (o) => o.status === 'done'],
  closed: ['Zakończone', (o) => ['collected', 'rejected', 'cancelled'].includes(o.status)],
  all: ['Wszystkie', () => true],
};

let token = sessionStorage.getItem('adminToken');
let orders = [];
let filter = 'new';

const auth = () => ({ Authorization: `Bearer ${token}` });
async function adminApi(path, options = {}) {
  try {
    return await api(path, { ...options, headers: { ...auth(), ...options.headers } });
  } catch (err) {
    if (err.status === 401) showLogin();
    throw err;
  }
}

function showLogin() {
  token = null;
  sessionStorage.removeItem('adminToken');
  $('#app').hidden = true;
  $('#logout').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  setDemo($('#password').value === DEMO_CODE);
  try {
    token = (await api('/api/admin/login', { method: 'POST', json: { password: $('#password').value } })).token;
    sessionStorage.setItem('adminToken', token);
    $('#password').value = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', showLogin);

async function start() {
  if (!token) return showLogin();
  try {
    const [o, s] = await Promise.all([adminApi('/api/admin/orders'), adminApi('/api/admin/settings')]);
    orders = o.orders;
    fillSettings(s.settings);
  } catch (err) {
    if (err.status !== 401) { showLogin(); $('#login-error').textContent = err.message; }
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  renderOrders();
}

// ---------- zamówienia ----------
function renderOrders() {
  $('#tabs').replaceChildren(...Object.entries(FILTERS).map(([key, [label, test]]) =>
    h('button', {
      type: 'button', class: `small ${key === filter ? 'active' : ''}`,
      onclick: () => { filter = key; renderOrders(); },
    }, `${label} (${orders.filter(test).length})`)));

  const visible = orders.filter(FILTERS[filter][1]);
  visible.sort((a, b) => (['new', 'printing'].includes(filter) ? a.id - b.id : b.id - a.id));
  $('#orders').replaceChildren(...(visible.length ? visible.map(orderCard) : [h('div', { class: 'empty' }, 'Brak zamówień.')]));
}

function orderCard(o) {
  const wanted = PRINTERS.find((p) => p.id === o.printer)?.name || 'dowolna';
  const fitInfo = o.dims
    ? PRINTERS.map((p) => `${p.name}: ${{ yes: 'tak', rotated: 'po obróceniu', no: 'nie' }[fits(o.dims, p.volume)]}`).join(', ')
    : '';
  const status = h('select', {}, ...Object.entries(STATUS).map(([value, label]) => h('option', { value, selected: value === o.status }, label)));
  const printer = h('select', {},
    h('option', { value: '' }, '— nie przypisano —'),
    ...PRINTERS.map((p) => h('option', { value: p.id, selected: p.id === o.assignedPrinter }, p.name)));
  const note = h('input', { type: 'text', maxLength: 500, value: o.teacherNote, placeholder: 'np. model za cienki, popraw ścianki' });
  const message = h('span', { class: 'hint' });

  const save = async () => {
    try {
      const { order } = await adminApi(`/api/admin/orders/${o.id}`, {
        method: 'PATCH',
        json: { status: status.value, assignedPrinter: printer.value || null, teacherNote: note.value },
      });
      orders = orders.map((x) => (x.id === order.id ? order : x));
      renderOrders();
    } catch (err) { message.textContent = err.message; }
  };
  const quick = (label, next) => o.status !== next && h('button', {
    type: 'button', class: 'small', onclick: () => { status.value = next; save(); },
  }, label);

  return h('div', { class: 'order' },
    h('div', { class: 'order-head' }, h('span', { class: 'title' }, `#${o.id} ${o.title}`), statusBadge(o.status)),
    h('div', { class: 'order-meta' },
      `${o.name} · ${formatDate(o.createdAt)} · chce: ${wanted} · `, swatch(o.filament.color), ` ${o.filament.name} · ${o.quantity} szt.`),
    h('div', { class: 'order-meta' },
      `${o.fileName} (${formatSize(o.fileSize)}) · wymiary: ${formatDims(o.dims)}${fitInfo ? ` · mieści się — ${fitInfo}` : ''}`),
    o.notes && h('div', { class: 'order-note' }, `Uwagi ucznia: ${o.notes}`),
    h('div', { class: 'admin-row' },
      h('div', {}, h('label', {}, 'Status'), status),
      h('div', {}, h('label', {}, 'Drukarka'), printer),
      h('div', {}, h('label', {}, 'Wiadomość dla ucznia'), note)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'small primary', onclick: save }, 'Zapisz'),
      o.status === 'new' && quick('▶ Drukuj', 'printing'),
      o.status === 'printing' && quick('✓ Gotowe', 'done'),
      o.status === 'done' && quick('Odebrane', 'collected'),
      h('button', { type: 'button', class: 'small', onclick: () => download(o, message) }, 'Pobierz plik'),
      h('button', { type: 'button', class: 'small danger', onclick: () => remove(o, message) }, 'Usuń'),
      message));
}

async function download(o, message) {
  try {
    let blob;
    if (isDemo()) {
      blob = await (await import('./demo.js')).demoFile(o.id);
      if (!blob) throw new Error('Plik został usunięty.');
    } else {
      const res = await fetch(`${API}/api/admin/orders/${o.id}/file`, { headers: auth() });
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Nie udało się pobrać pliku.');
      blob = await res.blob();
    }
    const url = URL.createObjectURL(blob);
    h('a', { href: url, download: `${o.id}-${o.fileName}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) { message.textContent = err.message; }
}

async function remove(o, message) {
  if (!confirm(`Usunąć zamówienie #${o.id} razem z plikiem? Tego nie da się cofnąć.`)) return;
  try {
    await adminApi(`/api/admin/orders/${o.id}`, { method: 'DELETE' });
    orders = orders.filter((x) => x.id !== o.id);
    renderOrders();
  } catch (err) { message.textContent = err.message; }
}

// ---------- ustawienia ----------
function filamentRow(f = { id: '', name: '', color: '#fa6831', available: true }) {
  const row = h('div', { class: 'filament-row' },
    h('input', { type: 'color', value: f.color, title: 'Kolor' }),
    h('input', { type: 'text', value: f.name, maxLength: 40, placeholder: 'np. PLA czerwony', required: true }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.available }), 'dostępny'),
    h('button', { type: 'button', class: 'small danger', title: 'Usuń filament', onclick: () => row.remove() }, '✕'));
  row.dataset.id = f.id;
  return row;
}

function fillSettings(s) {
  $('#class-code').value = s.classCode;
  $('#max-active').value = s.maxActive;
  $('#max-file').value = s.maxFileMB;
  $('#printers').replaceChildren(...PRINTERS.map((p) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p.id, checked: !!s.printers[p.id] }), p.name)));
  $('#filaments').replaceChildren(...s.filaments.map(filamentRow));
}
$('#add-filament').addEventListener('click', () => {
  const row = filamentRow();
  $('#filaments').append(row);
  row.querySelector('input[type=text]').focus();
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#settings-error').textContent = $('#settings-success').textContent = '';
  const body = {
    classCode: $('#class-code').value,
    maxActive: Number($('#max-active').value),
    maxFileMB: Number($('#max-file').value),
    printers: Object.fromEntries([...document.querySelectorAll('#printers input')].map((i) => [i.value, i.checked])),
    filaments: [...document.querySelectorAll('.filament-row')].map((row) => ({
      id: row.dataset.id,
      color: row.querySelector('input[type=color]').value,
      name: row.querySelector('input[type=text]').value,
      available: row.querySelector('input[type=checkbox]').checked,
    })),
    newPassword: $('#new-password').value,
  };
  try {
    fillSettings((await adminApi('/api/admin/settings', { method: 'PUT', json: body })).settings);
    $('#new-password').value = '';
    $('#settings-success').textContent = 'Zapisano.';
  } catch (err) {
    $('#settings-error').textContent = err.message;
  }
});

// odświeżanie listy co 30 s (nie nadpisuje pól, które są właśnie edytowane)
setInterval(async () => {
  if (!token || $('#app').hidden || document.hidden) return;
  if ($('#orders').contains(document.activeElement)) return;
  try { orders = (await adminApi('/api/admin/orders')).orders; renderOrders(); } catch { /* spróbujemy ponownie */ }
}, 30000);

showDemoBanner();
start();
