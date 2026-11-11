import {
  api, h, $, setDemo, showDemoBanner, fits, swatch, statusBadge, colors, priceText, orderNumber,
  formatPrice, formatDate, formatDims, formatSize, ACTIVE, KIND, emailError, suggestEmail,
} from './common.js';

const store = {
  get: (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* tryb prywatny */ } },
};

let user = store.get('user', null); // { id, name, token }
if (user && !user.token) user = null; // zapis ze starszej wersji
let config = null;
let orders = [];
let model = null; // { file, dims }
let viewer = null;
let viewerModule = null;
let filter = 'mine';

const authHeaders = () => ({ Authorization: `Bearer ${user.token}` });
const isMine = (o) => o.userId === user.id;
const isActive = (o) => ACTIVE.includes(o.status);
const checked = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
const kind = () => checked('kind')[0];

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
  $('#login-title').textContent = on ? 'Załóż konto' : 'Zaloguj się';
  $('#login-submit').textContent = on ? 'Załóż konto' : 'Zaloguj';
  $('#toggle-register').textContent = on ? 'Mam już konto' : 'Nie mam konta';
  $('#register-fields').hidden = $('#register-email').hidden = !on;
  $('#forgot').hidden = on;
  $('#login-code').required = $('#login-email').required = on;
  $('#login-password').autocomplete = on ? 'new-password' : 'current-password';
  $('#login-error').textContent = '';
}
$('#toggle-register').addEventListener('click', () => setRegistering(!registering));

// „Czy chodziło Ci o jan@gmail.com?" — podpowiedź przy literówce w domenie.
let keptEmail = ''; // adres, przy którym ktoś świadomie odrzucił podpowiedź
function checkEmail() {
  const input = $('#login-email');
  const box = $('#email-suggest');
  const email = input.value.trim();
  const fixed = email && email !== keptEmail ? suggestEmail(email) : null;
  box.hidden = !fixed;
  if (!fixed) return false;
  box.replaceChildren(
    h('div', {}, 'Czy chodziło Ci o ', h('b', {}, fixed), '?'),
    h('button', { type: 'button', class: 'small', onclick: () => { input.value = fixed; checkEmail(); } }, 'Tak, popraw'),
    h('button', { type: 'button', class: 'small', onclick: () => { keptEmail = email; checkEmail(); } }, 'Nie, jest dobrze'));
  return true;
}
// Pokazujemy ją chwilę po przerwaniu pisania, a nie przy wyjściu z pola:
// inaczej wyskakiwałaby w momencie kliknięcia „Załóż konto" i przesuwała przycisk spod palca.
let emailTimer;
$('#login-email').addEventListener('input', () => {
  $('#email-suggest').hidden = true;
  $('#login-error').textContent = '';
  clearTimeout(emailTimer);
  emailTimer = setTimeout(checkEmail, 800);
});

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
  clearTimeout(emailTimer);
  $('#login-error').textContent = '';
  try {
    if (registering) {
      if (checkEmail()) { $('#login-error').textContent = 'Sprawdź e-mail.'; return; }
      const problem = emailError($('#login-email').value.trim());
      if (problem) { $('#login-error').textContent = problem; return; }
      await signIn('/api/register', { ...body, email: $('#login-email').value.trim() },
        { 'X-Class-Code': encodeURIComponent($('#login-code').value.trim()) });
    } else {
      await signIn('/api/login', body);
    }
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
  const fee = formatPrice(config.designFeeFrom);
  $('#design-tag').textContent = `od ${fee}`;
  renderKind();
  renderChoices();
}

async function loadOrders() {
  orders = (await api('/api/orders', { headers: authHeaders() })).orders;
  renderOrders();
}

// ---------- formularz ----------
function chip(type, group, value, label, { isChecked = false, disabled = false } = {}) {
  return h('label', { class: 'choice' },
    h('input', { type, name: group, value, checked: isChecked, disabled }),
    h('span', {}, label));
}

const NOTES = {
  link: ['Uwagi', 'np. 8 cm, na piątek'],
  file: ['Uwagi', 'np. na piątek'],
  find: ['Czego szukamy?', 'np. podstawka pod telefon z kotem, ok. 10 cm'],
  design: ['Co mamy zaprojektować?', 'np. brelok z napisem KUBA, 5 cm'],
};
function renderKind() {
  const current = kind();
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.kind !== current;
  $('#link').required = current === 'link';
  $('#notes-label').textContent = NOTES[current][0];
  $('#notes').placeholder = NOTES[current][1];
  $('#notes').required = current === 'find' || current === 'design';
  renderChoices();
}
$('#kinds').addEventListener('change', renderKind);

// Filamenty leżą przy konkretnej drukarce, więc wybrane kolory wyznaczają drukarkę.
const printerById = (id) => config.printers.find((p) => p.id === id && p.enabled);
function pickedPrinter() {
  const first = config.filaments.find((f) => f.id === checked('filament')[0]);
  return first ? printerById(first.printer) : null;
}

function renderChoices() {
  if (!config) return;
  const dims = kind() === 'file' ? model?.dims : null;
  const tooBig = (p) => fits(dims, p.volume) === 'no';
  const available = config.filaments.filter((f) => f.available && printerById(f.printer));
  // odznacz kolory z drukarki, w której wgrany model się nie zmieści
  let picked = checked('filament').filter((id) => !tooBig(printerById(available.find((f) => f.id === id)?.printer) || { volume: [0, 0, 0] }));
  const current = printerById(available.find((f) => f.id === picked[0])?.printer);
  if (current) picked = picked.filter((id) => available.find((f) => f.id === id).printer === current.id); // tylko kolory z jednej drukarki

  const groups = config.printers.filter((p) => p.enabled && available.some((f) => f.printer === p.id));
  $('#filaments').replaceChildren(...(groups.length ? groups.map((p) => {
    const blocked = tooBig(p) || (current && current.id !== p.id);
    const info = [`do ${p.volume.map((v) => v / 10).join(' × ')} cm`, p.maxColors > 1 ? `do ${p.maxColors} kolorów naraz` : '1 kolor'];
    return h('div', { class: `filament-group ${blocked ? 'blocked' : ''}` },
      h('div', { class: 'group-label' }, tooBig(p) ? 'model się nie zmieści' : info.join(' · ')),
      h('div', { class: 'choices' }, ...available.filter((f) => f.printer === p.id).map((f) => chip('checkbox', 'filament', f.id,
        [swatch(f.color), h('span', {}, h('b', {}, f.name), f.note && h('small', {}, f.note))],
        { isChecked: picked.includes(f.id), disabled: !picked.includes(f.id) && (blocked || picked.length >= p.maxColors) }))));
  }) : [h('span', { class: 'hint' }, 'Brak filamentu.')]));
  $('#filaments').onchange = renderChoices;
  $('#color-plan-box').hidden = picked.length < 2;
  $('#color-plan').required = picked.length > 1;

  // przykładowe ceny
  const rates = (picked.length ? available.filter((f) => picked.includes(f.id)) : available).map((f) => f.pricePerMinute || 0);
  const rate = picked.length ? Math.max(0, ...rates) : Math.min(...(rates.length ? rates : [0]));
  $('#price-examples').replaceChildren(...[
    ['brelok', 30], ['figurka', 180], ['coś dużego', 480],
  ].map(([what, minutes]) => h('li', {},
    h('span', {}, `${what} (${minutes < 60 ? `${minutes} min` : `${minutes / 60} h`})`),
    h('b', {}, `~${formatPrice(Math.max(config.minPrice || 0, minutes * rate))}`))));
  $('#price-hint').textContent = `${config.minPrice ? `Minimum ${formatPrice(config.minPrice)}. ` : ''}Cenę potwierdzasz przed drukiem.`;

  const mine = orders.filter((o) => isMine(o) && isActive(o)).length;
  $('#limit-info').textContent = mine >= config.maxActive
    ? `Limit: ${config.maxActive} zamówienia naraz.`
    : '';
  $('#submit').disabled = mine >= config.maxActive;
  updateBed();
}

function bedVolume() {
  const printer = pickedPrinter()
    || config.printers.find((p) => p.enabled && fits(model?.dims, p.volume) !== 'no'); // bez koloru: pierwsza, w której się mieści
  return printer ? printer.volume : null;
}
function updateBed() {
  if (viewer && model) viewer.setVolume(bedVolume());
}

function renderFit() {
  const list = $('#fit');
  if (!model?.dims) return list.replaceChildren();
  const words = { yes: 'zmieści się', rotated: 'zmieści się po obróceniu', no: 'za duże' };
  list.replaceChildren(
    h('li', {}, `Wymiary: ${formatDims(model.dims)}`),
    ...config.printers.filter((p) => p.enabled).map((p) => {
      const result = fits(model.dims, p.volume);
      return h('li', { class: result }, `${p.name}: ${words[result]}`);
    }),
  );
}

async function selectFile(file) {
  $('#order-error').textContent = '';
  $('#order-success').textContent = '';
  model = null;
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['stl', '3mf'].includes(extension)) return fileError('Tylko STL i 3MF.');
  if (file.size > config.maxFileMB * 1048576) return fileError(`Za duży plik (limit ${config.maxFileMB} MB).`);

  $('#file-info').textContent = `${file.name} · ${formatSize(file.size)}`;
  if (!$('#title').value) $('#title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  model = { file, dims: null };
  const preview = $('#preview');
  preview.hidden = false;
  if (!viewer) preview.textContent = 'Wczytuję model…';

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
      preview.textContent = 'Brak podglądu 3D w tej przeglądarce.';
    }
  } catch {
    if (model?.file !== file) return;
    viewer = null;
    fileError('Nie da się otworzyć tego pliku.');
  }
}

function fileError(message) {
  model = null;
  $('#file').value = '';
  $('#file-info').textContent = '';
  if (!viewer) $('#preview').hidden = true;
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
  const current = kind();
  const filaments = checked('filament');
  if (current === 'file' && !model) { error.textContent = 'Wybierz plik z modelem.'; return; }
  if (!filaments.length) { error.textContent = 'Wybierz kolor.'; return; }

  const meta = {
    kind: current,
    title: $('#title').value,
    link: $('#link').value.trim(),
    quantity: Number($('#quantity').value),
    filaments,
    colorPlan: filaments.length > 1 ? $('#color-plan').value : '',
    notes: $('#notes').value,
    fileName: current === 'file' ? model.file.name : '',
    dims: current === 'file' ? model.dims : null,
  };
  const button = $('#submit');
  button.disabled = true;
  button.textContent = 'Wysyłam…';
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-Order': encodeURIComponent(JSON.stringify(meta)), 'Content-Type': 'application/octet-stream' },
      body: current === 'file' ? model.file : undefined,
    });
    success.textContent = `Zamówienie ${orderNumber(result.order)} wysłane. Cenę dostaniesz mailem.`;
    for (const id of ['#title', '#notes', '#link', '#color-plan', '#file']) $(id).value = '';
    for (const box of document.querySelectorAll('input[name=filament]')) box.checked = false;
    $('#quantity').value = 1;
    $('#file-info').textContent = '';
    model = null;
    renderFit();
    filter = 'mine';
    await loadOrders();
  } catch (err) {
    if (err.status === 401) return showLogin('Zaloguj się jeszcze raz.');
    error.textContent = err.message;
  } finally {
    button.textContent = 'Wyślij zamówienie';
    renderChoices();
  }
});

// ---------- zamówienia ----------
const FILTERS = {
  mine: ['Moje', (o) => isMine(o)],
  queue: ['Kolejka', (o) => isActive(o)],
  all: ['Wszystkie', () => true],
};
const HINT = {
  done: 'Odbierz w szkole.',
};

function renderOrders() {
  $('#tabs').replaceChildren(...Object.entries(FILTERS).map(([key, [label, test]]) =>
    h('button', {
      type: 'button', class: `small ${key === filter ? 'active' : ''}`,
      onclick: () => { filter = key; renderOrders(); },
    }, `${label} (${orders.filter(test).length})`)));

  const visible = orders.filter(FILTERS[filter][1]);
  // kolejka: od najstarszego (kolejność druku); reszta: od najnowszego
  const waits = (o) => (isMine(o) && o.status === 'confirm' ? 0 : 1); // to, co czeka na kliknięcie, zawsze na górze
  visible.sort((a, b) => waits(a) - waits(b) || (filter === 'queue' ? a.id - b.id : b.id - a.id));
  const pending = orders.filter((o) => waits(o) === 0).length;
  $('#pending').hidden = !pending;
  $('#pending').textContent = `Do potwierdzenia: ${pending} ↓`;
  const empty = 'Pusto.';
  $('#orders').replaceChildren(...(visible.length ? visible.map(orderCard) : [h('div', { class: 'empty' }, empty)]));
}

function orderCard(o) {
  const mine = isMine(o);
  const waiting = mine && o.status === 'confirm';
  return h('div', { class: `order ${mine ? 'mine' : ''} ${waiting ? 'waiting' : ''}` },
    h('div', { class: 'order-head' },
      h('span', { class: 'num' }, orderNumber(o)),
      h('span', { class: 'title' }, o.title),
      statusBadge(o.status)),
    h('div', { class: 'order-meta' }, `${mine ? 'Ty' : o.name} · ${formatDate(o.createdAt)} · ${KIND[o.kind] || ''} · ${o.quantity} szt. · `, colors(o)),
    mine && o.link && h('div', { class: 'order-meta' }, 'Model: ', h('a', { href: o.link, target: '_blank', rel: 'noopener' }, o.link)),
    mine && o.teacherNote && h('div', { class: 'order-note' }, h('b', {}, 'Od nas: '), o.teacherNote),
    mine && o.price != null && h('div', { class: 'order-price' }, `Cena: ${priceText(o)} `,
      h('span', { class: `badge ${o.paid ? 'badge-done' : 'badge-new'}` }, o.paid ? 'zapłacone' : 'do zapłaty')),
    waiting && h('div', { class: 'confirm-box' },
      h('div', { class: 'actions' },
        h('button', { class: 'primary', type: 'button', onclick: () => act(o, 'confirm') }, 'Potwierdzam'),
        h('button', { class: 'danger', type: 'button', onclick: () => act(o, 'cancel') }, 'Rezygnuję'))),
    mine && !waiting && HINT[o.status] && h('div', { class: 'hint' }, HINT[o.status]),
    mine && o.status === 'new' && h('div', { class: 'actions' },
      h('button', { class: 'small danger', type: 'button', onclick: () => act(o, 'cancel') }, 'Anuluj')));
}

async function act(order, action) {
  if (action === 'cancel' && !confirm(`Na pewno rezygnujesz z „${order.title}"?`)) return;
  try {
    await api(`/api/orders/${order.id}/${action}`, { method: 'POST', headers: authHeaders() });
  } catch (err) {
    alert(err.message);
  }
  await loadOrders().catch(() => {});
  renderChoices();
}

// odświeżanie co 30 s, gdy karta jest widoczna
setInterval(() => {
  if (user && !$('#app').hidden && !document.hidden) loadOrders().then(renderChoices).catch(() => {});
}, 30000);

showDemoBanner();
start();
