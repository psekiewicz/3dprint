import {
  API, api, h, $, formatDate, DEMO_CODE, isDemo, setDemo, showDemoBanner, STATUS, KIND, fits, colors, orderRate, orderNumber,
  formatRate, formatPrice, formatMinutes, statusBadge, formatDims, formatSize,
} from './common.js';

const PRINTERS = [
  { id: 'mini', name: 'Prusa MINI+', volume: [180, 180, 180] },
  { id: 'mk4s', name: 'Prusa MK4S', volume: [250, 210, 220] },
];
const FILTERS = {
  new: ['Do wyceny', (o) => o.status === 'new'],
  confirm: ['Czekają na OK', (o) => o.status === 'confirm'],
  accepted: ['Do druku', (o) => o.status === 'accepted'],
  printing: ['W druku', (o) => o.status === 'printing'],
  done: ['Do odbioru', (o) => o.status === 'done'],
  closed: ['Zakończone', (o) => ['collected', 'rejected', 'cancelled'].includes(o.status)],
  all: ['Wszystkie', () => true],
};
const MAIL = {
  sent: 'Zapisane, mail poszedł.',
  off: 'Zapisane, ale mail NIE poszedł (brak skrzynki SMTP albo adresu kupującego).',
  failed: 'Zapisane, ale maila nie udało się wysłać. Sprawdź logi serwera.',
};

let token = sessionStorage.getItem('adminToken');
let orders = [];
let users = [];
let sellers = [];
let me = null;
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
  $('#who').textContent = '';
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  setDemo($('#password').value === DEMO_CODE);
  try {
    token = (await api('/api/admin/login', { method: 'POST', json: { name: $('#seller-name').value.trim(), password: $('#password').value } })).token;
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
    const [o, s, u, a] = await Promise.all([adminApi('/api/admin/orders'), adminApi('/api/admin/settings'), adminApi('/api/admin/users'), adminApi('/api/admin/sellers')]);
    sellers = a.sellers;
    me = a.me;
    orders = o.orders;
    users = u.users;
    fillSettings(s.settings);
    $('#mail-off').hidden = s.mail || isDemo();
  } catch (err) {
    if (err.status !== 401) { showLogin(); $('#login-error').textContent = err.message; }
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  $('#who').textContent = sellers.find((x) => x.id === me)?.name || '';
  renderOrders();
  renderUsers();
  renderSellers();
}

// ---------- zamówienia ----------
function renderOrders() {
  $('#tabs').replaceChildren(...Object.entries(FILTERS).map(([key, [label, test]]) =>
    h('button', {
      type: 'button', class: `small ${key === filter ? 'active' : ''}`,
      onclick: () => { filter = key; renderOrders(); },
    }, `${label} (${orders.filter(test).length})`)));

  const live = orders.filter((o) => o.price != null && !['rejected', 'cancelled'].includes(o.status));
  const sum = (list) => formatPrice(list.reduce((total, o) => total + o.price, 0));
  $('#totals').textContent = `Do zapłaty: ${sum(live.filter((o) => !o.paid))} · Zapłacono: ${sum(live.filter((o) => o.paid))}`;

  const visible = orders.filter(FILTERS[filter][1]);
  visible.sort((a, b) => (['closed', 'all'].includes(filter) ? b.id - a.id : a.id - b.id));
  $('#orders').replaceChildren(...(visible.length ? visible.map(orderCard) : [h('div', { class: 'empty' }, 'Brak zamówień.')]));
}

function orderCard(o) {
  const buyer = users.find((u) => u.id === o.userId);
  const wanted = PRINTERS.find((p) => p.id === o.printer)?.name || 'wszystko jedno';
  const fitInfo = o.dims
    ? PRINTERS.map((p) => `${p.name}: ${{ yes: 'tak', rotated: 'po obróceniu', no: 'nie' }[fits(o.dims, p.volume)]}`).join(', ')
    : '';
  const status = h('select', {}, ...Object.entries(STATUS).map(([value, label]) => h('option', { value, selected: value === o.status }, label)));
  const printer = h('select', {},
    h('option', { value: '' }, 'nie przypisano'),
    ...PRINTERS.map((p) => h('option', { value: p.id, selected: p.id === o.assignedPrinter }, p.name)));
  const minutes = h('input', { type: 'number', min: 1, step: 1, value: o.printMinutes ?? '', placeholder: 'z PrusaSlicer' });
  const fee = h('input', { type: 'number', min: 0, step: 0.5, value: o.serviceFee || '', placeholder: '0' });
  const link = h('input', { type: 'url', maxLength: 500, value: o.link || '', placeholder: 'https://… (np. model, który znaleźliśmy)' });
  const note = h('input', { type: 'text', maxLength: 500, value: o.teacherNote, placeholder: 'np. znalazłem taki model, pasuje?' });
  const paid = h('input', { type: 'checkbox', checked: !!o.paid });
  const price = h('span', { class: 'order-price' });
  const message = h('span', { class: 'hint' });
  const rate = orderRate(o);
  const showPrice = () => {
    const m = Math.round(Number(minutes.value)) || 0;
    const f = Number(fee.value) || 0;
    const parts = [`${formatRate(rate)} × ${m} min`];
    if (f) parts.push(`usługa ${formatPrice(f)}`);
    price.textContent = m || f ? `${parts.join(' + ')} = ${formatPrice(Math.round((m * rate + f) * 100) / 100)}` : `Stawka: ${formatRate(rate)}. Wpisz czas druku.`;
  };
  minutes.addEventListener('input', showPrice);
  fee.addEventListener('input', showPrice);
  showPrice();

  const save = async (nextStatus) => {
    if (nextStatus) status.value = nextStatus;
    try {
      const result = await adminApi(`/api/admin/orders/${o.id}`, {
        method: 'PATCH',
        json: {
          status: status.value, assignedPrinter: printer.value || null, teacherNote: note.value, link: link.value,
          printMinutes: minutes.value === '' ? null : Number(minutes.value), serviceFee: Number(fee.value) || 0, paid: paid.checked,
        },
      });
      orders = orders.map((x) => (x.id === result.order.id ? result.order : x));
      renderOrders();
      if (result.mail) flash(MAIL[result.mail]);
    } catch (err) {
      status.value = o.status;
      message.textContent = err.message;
    }
  };
  const quick = (label, next) => h('button', { type: 'button', class: 'small primary', onclick: () => save(next) }, label);

  return h('div', { class: 'order' },
    h('div', { class: 'order-head' }, h('span', { class: 'num' }, orderNumber(o)), h('span', { class: 'title' }, o.title), statusBadge(o.status)),
    h('div', { class: 'order-meta' }, `${o.name}`, buyer?.email && [' · ', h('a', { href: `mailto:${buyer.email}` }, buyer.email)],
      ` · ${formatDate(o.createdAt)} · ${KIND[o.kind] || ''} · ${o.quantity} szt. · drukarka: ${wanted}`),
    h('div', { class: 'order-meta' }, 'Kolory: ', colors(o), o.colorPlan && ` · ${o.colorPlan}`),
    o.link && h('div', { class: 'order-meta' }, 'Model: ', h('a', { href: o.link, target: '_blank', rel: 'noopener' }, o.link)),
    o.hasFile && h('div', { class: 'order-meta' },
      `Plik: ${o.fileName} (${formatSize(o.fileSize)}) · ${formatDims(o.dims)}${fitInfo ? ` · mieści się: ${fitInfo}` : ''}`),
    o.notes && h('div', { class: 'order-note' }, h('b', {}, 'Kupujący pisze: '), o.notes),
    o.handledBy && h('div', { class: 'order-meta' }, `Ostatnio ruszał(a): ${o.handledBy}${o.printMinutes ? ` · druk ${formatMinutes(o.printMinutes)}` : ''}`),
    h('div', { class: 'admin-row' },
      h('div', {}, h('label', {}, 'Status'), status),
      h('div', {}, h('label', {}, 'Drukarka'), printer),
      h('div', {}, h('label', {}, 'Czas druku (min)'), minutes),
      h('div', {}, h('label', {}, 'Opłata za usługę (zł)'), fee),
      h('div', { class: 'wide' }, h('label', {}, 'Link do modelu'), link),
      h('div', { class: 'wide' }, h('label', {}, 'Wiadomość dla kupującego'), note)),
    h('div', { class: 'actions' }, price, h('label', { class: 'check' }, paid, 'zapłacone')),
    h('div', { class: 'actions' },
      o.status === 'new' && quick('Wyślij do potwierdzenia', 'confirm'),
      o.status === 'accepted' && quick('Drukuj', 'printing'),
      o.status === 'printing' && quick('Gotowe', 'done'),
      o.status === 'done' && quick('Odebrane', 'collected'),
      h('button', { type: 'button', class: 'small', onclick: () => save() }, 'Zapisz'),
      o.hasFile && h('button', { type: 'button', class: 'small', onclick: () => download(o, message) }, 'Pobierz plik'),
      h('button', { type: 'button', class: 'small danger', onclick: () => remove(o, message) }, 'Usuń'),
      message));
}

function flash(text) {
  $('#totals').textContent = text;
  setTimeout(renderOrders, 6000);
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

// ---------- konta ----------
function renderUsers() {
  $('#users').replaceChildren(...(users.length ? users.map((u) => {
    const message = h('span', { class: 'hint' });
    const count = orders.filter((o) => o.userId === u.id).length;
    return h('div', { class: 'order' },
      h('div', { class: 'order-head' }, h('span', { class: 'title' }, u.name),
        h('button', { type: 'button', class: 'small', onclick: () => resetPassword(u, message) }, 'Nowe hasło'),
        h('button', { type: 'button', class: 'small danger', onclick: () => removeUser(u, message) }, 'Usuń')),
      h('div', { class: 'order-meta' }, u.email && [h('a', { href: `mailto:${u.email}` }, u.email), ' · '], `konto od ${formatDate(u.createdAt)} · zamówień: ${count} `, message));
  }) : [h('div', { class: 'empty' }, 'Nikt jeszcze nie założył konta.')]));
}

async function resetPassword(u, message) {
  const password = prompt(`Nowe hasło dla: ${u.name} (co najmniej 6 znaków)`);
  if (password == null) return;
  try {
    await adminApi(`/api/admin/users/${u.id}/password`, { method: 'PUT', json: { password } });
    message.textContent = '· hasło zmienione';
  } catch (err) { message.textContent = `· ${err.message}`; }
}

async function removeUser(u, message) {
  if (!confirm(`Usunąć konto: ${u.name}? Ta osoba będzie mogła założyć je ponownie.`)) return;
  try {
    await adminApi(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    users = users.filter((x) => x.id !== u.id);
    renderUsers();
  } catch (err) { message.textContent = `· ${err.message}`; }
}

// ---------- sprzedawcy ----------
function renderSellers() {
  $('#sellers').replaceChildren(...sellers.map((s) => {
    const message = h('span', { class: 'hint' });
    const mine = s.id === me;
    return h('div', { class: 'order' },
      h('div', { class: 'order-head' }, h('span', { class: 'title' }, mine ? `${s.name} (Ty)` : s.name),
        mine
          ? h('button', { type: 'button', class: 'small', onclick: () => changeMyPassword(message) }, 'Zmień moje hasło')
          : h('button', { type: 'button', class: 'small danger', onclick: () => removeSeller(s, message) }, 'Usuń'),
        message));
  }));
}

async function changeMyPassword(message) {
  const password = prompt('Twoje nowe hasło (co najmniej 8 znaków)');
  if (password == null) return;
  try {
    await adminApi(`/api/admin/sellers/${me}/password`, { method: 'PUT', json: { password } });
    message.textContent = 'hasło zmienione';
  } catch (err) { message.textContent = err.message; }
}

async function removeSeller(s, message) {
  if (!confirm(`Odebrać dostęp do panelu sprzedawcy: ${s.name}?`)) return;
  try {
    await adminApi(`/api/admin/sellers/${s.id}`, { method: 'DELETE' });
    sellers = sellers.filter((x) => x.id !== s.id);
    renderSellers();
  } catch (err) { message.textContent = err.message; }
}

$('#seller-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#seller-message');
  try {
    const { seller } = await adminApi('/api/admin/sellers', {
      method: 'POST', json: { name: $('#new-seller-name').value, password: $('#new-seller-password').value },
    });
    sellers.push(seller);
    renderSellers();
    event.target.reset();
    message.textContent = `Dodano: ${seller.name}`;
  } catch (err) { message.textContent = err.message; }
});

// ---------- ustawienia ----------
function filamentRow(f = { id: '', name: '', note: '', color: '#fa6831', available: true, pricePerMinute: 0.1 }) {
  const row = h('div', { class: 'filament-row' },
    h('input', { type: 'color', value: f.color, title: 'Kolor' }),
    h('input', { type: 'text', class: 'name', value: f.name, maxLength: 40, placeholder: 'np. PLA czerwony', required: true }),
    h('input', { type: 'number', class: 'rate', min: 0, max: 100, step: 0.001, value: f.pricePerMinute ?? 0, title: 'Stawka w zł za minutę druku', required: true }),
    h('span', { class: 'hint' }, 'zł/min'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.available }), 'jest'),
    h('button', { type: 'button', class: 'small danger', title: 'Usuń filament', onclick: () => row.remove() }, '✕'),
    h('input', { type: 'text', class: 'note', value: f.note || '', maxLength: 80, placeholder: 'opis dla kupujących, np. zwykły plastik, pasuje do większości rzeczy' }));
  row.dataset.id = f.id;
  return row;
}

function fillSettings(s) {
  $('#design-fee').value = s.designFeeFrom;
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
  row.querySelector('input.name').focus();
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#settings-error').textContent = $('#settings-success').textContent = '';
  const body = {
    designFeeFrom: Number($('#design-fee').value),
    classCode: $('#class-code').value,
    maxActive: Number($('#max-active').value),
    maxFileMB: Number($('#max-file').value),
    printers: Object.fromEntries([...document.querySelectorAll('#printers input')].map((i) => [i.value, i.checked])),
    filaments: [...document.querySelectorAll('.filament-row')].map((row) => ({
      id: row.dataset.id,
      color: row.querySelector('input[type=color]').value,
      name: row.querySelector('input.name').value,
      note: row.querySelector('input.note').value,
      pricePerMinute: Number(row.querySelector('input.rate').value),
      available: row.querySelector('input[type=checkbox]').checked,
    })),
  };
  try {
    fillSettings((await adminApi('/api/admin/settings', { method: 'PUT', json: body })).settings);
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
