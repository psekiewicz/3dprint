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
      if (checkEmail()) { $('#login-error').textContent = 'Zerknij na adres e-mail wyżej.'; return; }
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
    return showLogin(err.status === 401 ? 'Zaloguj się jeszcze raz.' : err.message);
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  $('#who').textContent = user.name;
  $('#shop-name').textContent = config.shopName;
  document.title = config.shopName;
  const fee = formatPrice(config.designFeeFrom);
  $('#design-tag').textContent = `od ${fee}`;
  $('#design-info').textContent = `Projekt kosztuje od ${fee}, zależnie od tego, jak jest trudny.`;
  const biggest = config.printers.filter((p) => p.enabled).sort((a, b) => b.volume[0] - a.volume[0])[0];
  $('#size-info').textContent = biggest
    ? `Maksymalnie około ${biggest.volume.map((v) => v / 10).join(' × ')} cm. Większe rzeczy da się czasem wydrukować w częściach i skleić.`
    : 'Drukarki mają teraz przerwę. Zapytaj nas, kiedy wracają.';
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
  link: ['Uwagi (jak chcesz)', 'np. ma mieć ok. 8 cm, potrzebuję na piątek'],
  file: ['Uwagi (jak chcesz)', 'np. potrzebuję na piątek'],
  find: ['Czego szukamy?', 'np. podstawka pod telefon z kotem, taka żeby stała na biurku, ok. 10 cm'],
  design: ['Co mamy zaprojektować?', 'np. brelok z napisem KUBA, 5 cm, z dziurką na kółko'],
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

function renderChoices() {
  if (!config) return;
  const enabled = config.printers.filter((p) => p.enabled);
  const maxColors = Math.max(1, ...enabled.map((p) => p.maxColors));
  const dims = kind() === 'file' ? model?.dims : null;

  // kolory
  const picked = checked('filament');
  const available = config.filaments.filter((f) => f.available);
  $('#filaments').replaceChildren(...(available.length
    ? available.map((f) => chip('checkbox', 'filament', f.id,
      [swatch(f.color), h('span', {}, h('b', {}, f.name), f.note && h('small', {}, f.note))],
      { isChecked: picked.includes(f.id), disabled: !picked.includes(f.id) && picked.length >= maxColors }))
    : [h('span', { class: 'hint' }, 'Chwilowo nie mamy żadnego filamentu. Daj nam znać!')]));
  $('#filaments').onchange = renderChoices;
  $('#color-hint').textContent = maxColors > 1
    ? `Jeden kolor w zupełności wystarczy. Możesz zaznaczyć do ${maxColors}, ale wielokolorowy wydruk trwa dłużej, więc wychodzi drożej.`
    : 'Wybierz jeden kolor.';
  $('#color-plan-box').hidden = picked.length < 2;
  $('#color-plan').required = picked.length > 1;

  // drukarka (ukryta w „Znam się")
  const selected = checked('printer')[0] ?? 'any';
  const ok = (p) => fits(dims, p.volume) !== 'no' && p.maxColors >= Math.max(1, picked.length);
  const options = [
    { id: 'any', name: 'Wszystko jedno', ok: enabled.some(ok) },
    ...enabled.map((p) => ({ id: p.id, name: `${p.name} (do ${p.volume.map((v) => v / 10).join(' × ')} cm${p.maxColors > 1 ? `, do ${p.maxColors} kolorów` : ''})`, ok: ok(p) })),
  ];
  const pick = options.find((o) => o.id === selected && o.ok) || options.find((o) => o.ok);
  $('#printers').replaceChildren(...options.map((o) => chip('radio', 'printer', o.id, o.name, { isChecked: o === pick, disabled: !o.ok })));
  $('#printers').onchange = updateBed;

  // przykładowe ceny
  const rates = (picked.length ? available.filter((f) => picked.includes(f.id)) : available).map((f) => f.pricePerMinute || 0);
  const rate = picked.length ? Math.max(0, ...rates) : Math.min(...(rates.length ? rates : [0]));
  $('#price-examples').replaceChildren(...[
    ['mały brelok', 30], ['figurka wielkości dłoni', 180], ['coś dużego', 480],
  ].map(([what, minutes]) => h('li', {}, h('span', {}, `${what}, ok. ${minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}`), h('b', {}, `ok. ${formatPrice(minutes * rate)}`))));

  const mine = orders.filter((o) => isMine(o) && isActive(o)).length;
  $('#limit-info').textContent = mine >= config.maxActive
    ? `Masz już ${mine} zamówienia w toku. Kolejne złożysz, gdy któreś będzie gotowe.`
    : '';
  $('#submit').disabled = mine >= config.maxActive;
  updateBed();
}

function bedVolume() {
  const id = checked('printer')[0];
  const enabled = config.printers.filter((p) => p.enabled);
  const printer = enabled.find((p) => p.id === id)
    || enabled.find((p) => fits(model?.dims, p.volume) !== 'no'); // „Wszystko jedno": pierwsza, w której się mieści
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
  if (!['stl', '3mf'].includes(extension)) return fileError('Przyjmujemy tylko pliki STL i 3MF. Masz coś innego? Wklej link albo opisz, co to jest.');
  if (file.size > config.maxFileMB * 1048576) return fileError(`Ten plik jest za duży (limit to ${config.maxFileMB} MB).`);

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
      preview.textContent = 'Podgląd 3D nie działa w tej przeglądarce, ale zamówienie i tak możesz wysłać.';
    }
  } catch {
    if (model?.file !== file) return;
    viewer = null;
    fileError('Nie umiemy otworzyć tego pliku. Jest uszkodzony albo to nie STL/3MF.');
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
  const printer = checked('printer')[0];
  if (current === 'file' && !model) { error.textContent = 'Wybierz plik z modelem.'; return; }
  if (!filaments.length) { error.textContent = 'Zaznacz chociaż jeden kolor.'; return; }
  if (!printer) {
    error.textContent = current === 'file' && model?.dims
      ? 'Ten model jest za duży na nasze drukarki. Napisz do nas, może da się go zmniejszyć albo podzielić.'
      : 'Tylu kolorów naraz nie damy rady wydrukować.';
    return;
  }

  const meta = {
    kind: current,
    title: $('#title').value,
    link: $('#link').value.trim(),
    quantity: Number($('#quantity').value),
    printer, filaments,
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
    success.textContent = `Mamy to! Zamówienie ${orderNumber(result.order)} poszło. Odezwiemy się z ceną${user.email ? ` na ${user.email}` : ''}.`;
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
  new: 'Sprawdzamy i liczymy cenę. Odezwiemy się mailem.',
  accepted: 'Potwierdzone. Czeka na swoją kolej do druku.',
  printing: 'Drukarka właśnie nad tym pracuje.',
  done: 'Gotowe! Złap nas w szkole i odbierz.',
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
  $('#pending').textContent = pending === 1 ? 'Masz wycenę do potwierdzenia. Zjedź na dół strony ↓' : `Masz ${pending} wyceny do potwierdzenia. Zjedź na dół strony ↓`;
  const empty = filter === 'mine' ? 'Nic tu jeszcze nie ma. Zamów coś wyżej!' : 'Pusto.';
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
      h('p', {}, 'Zerknij na model i cenę. Pasuje? Bez Twojego kliknięcia nie ruszamy.'),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', type: 'button', onclick: () => act(o, 'confirm') }, 'Potwierdzam, drukujcie'),
        h('button', { class: 'danger', type: 'button', onclick: () => act(o, 'cancel') }, 'Rezygnuję'))),
    mine && !waiting && HINT[o.status] && h('div', { class: 'hint' }, HINT[o.status]),
    mine && o.status === 'new' && h('div', { class: 'actions' },
      h('button', { class: 'small danger', type: 'button', onclick: () => act(o, 'cancel') }, 'Anuluj zamówienie')));
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
