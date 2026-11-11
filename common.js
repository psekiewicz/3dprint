// Wspólne funkcje strony kupującego i panelu sprzedawcy.
export const API = (window.API_URL || '').replace(/\/$/, '');

export const STATUS = {
  new: 'Do wyceny',
  confirm: 'Czeka na potwierdzenie',
  accepted: 'Potwierdzone',
  printing: 'Drukuje się',
  done: 'Do odbioru',
  collected: 'Odebrane',
  rejected: 'Odrzucone',
  cancelled: 'Anulowane',
};
export const ACTIVE = ['new', 'confirm', 'accepted', 'printing'];
export const KIND = {
  link: 'model z linku',
  file: 'własny plik',
  find: 'szukamy modelu',
  design: 'projekt na zamówienie',
};

// Wersja pokazowa: włącza ją kod klasy (albo hasło sprzedawcy) „demo".
export const DEMO_CODE = 'demo';
// Flaga jest też trzymana w pamięci, bo niektóre przeglądarki (tryb prywatny, blokada danych witryn) nie pozwalają na localStorage.
let demoInMemory = false;
export const isDemo = () => { try { return demoInMemory || localStorage.getItem('demo') === '1'; } catch { return demoInMemory; } };
export function setDemo(on) {
  demoInMemory = on;
  try { on ? localStorage.setItem('demo', '1') : localStorage.removeItem('demo'); } catch { /* tryb prywatny */ }
  showDemoBanner();
}
export function showDemoBanner() {
  const banner = document.querySelector('#demo-banner');
  if (banner) banner.hidden = !isDemo();
}

export async function api(path, options = {}) {
  if (isDemo()) return (await import('./demo.js')).demoApi(path, options);
  const { method = 'GET', headers = {}, json, body } = options;
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
  } catch {
    throw new Error('Brak połączenia z serwerem. Sprawdź, czy jesteś w sieci szkolnej.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Odpowiedź bez JSON-a z błędem 404/405 oznacza samą stronę (np. GitHub Pages) bez serwera zamówień.
    const noServer = !data && [404, 405, 501].includes(res.status);
    const err = new Error(noServer
      ? 'Ta strona nie ma podłączonego serwera zamówień. Możesz otworzyć wersję pokazową.'
      : (data && data.error) || `Błąd serwera (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

// h('div', { class: 'x', onclick: fn }, 'tekst', element) — treść zawsze trafia jako tekst.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export const $ = (selector) => document.querySelector(selector);

export const formatDate = (iso) =>
  new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const formatSize = (bytes) =>
  bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

export const formatDims = (dims) => (dims ? `${dims.map((d) => d.toFixed(1)).join(' × ')} mm` : 'nieznane');

// Czy model mieści się w drukarce: 'yes', 'rotated' (po obróceniu o 90°) albo 'no'.
export function fits(dims, volume) {
  if (!dims) return 'yes';
  const ok = (d) => d[0] <= volume[0] && d[1] <= volume[1] && d[2] <= volume[2];
  if (ok(dims)) return 'yes';
  const [x, y, z] = dims;
  const rotations = [[y, x, z], [x, z, y], [z, y, x], [y, z, x], [z, x, y]];
  return rotations.some(ok) ? 'rotated' : 'no';
}

// ---------- e-mail: sprawdzenie i podpowiedź przy literówce w domenie ----------
const MAIL_DOMAINS = [
  'gmail.com', 'wp.pl', 'onet.pl', 'op.pl', 'vp.pl', 'o2.pl', 'interia.pl', 'interia.eu', 'poczta.onet.pl', 'gazeta.pl', 'tlen.pl',
  'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'yahoo.com', 'proton.me', 'mail.com', 'email.com',
];
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
// Musi być @, coś przed nią i kropka w domenie.
export function emailError(email) {
  const at = email.lastIndexOf('@');
  if (/\s/.test(email)) return 'W adresie e-mail nie może być spacji.';
  if (at < 1) return 'W adresie brakuje @ (np. jan@gmail.com).';
  const domain = email.slice(at + 1);
  if (!/^[^.@]+(\.[^.@]+)+$/.test(domain)) return `Po @ musi być pełna domena z kropką, np. ${email.slice(0, at)}@gmail.com.`;
  return '';
}
// Zwraca poprawiony adres, gdy domena wygląda na literówkę znanej (gmial.com, gmail.con, samo „gmail"), inaczej null.
export function suggestEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).toLowerCase().replace(/,/g, '.').replace(/\.+$/, '');
  if (!domain || MAIL_DOMAINS.includes(domain) && domain === email.slice(at + 1)) return null;
  let best = MAIL_DOMAINS.find((d) => d === domain) // ta sama domena, tylko z przecinkiem albo wielkimi literami
    || MAIL_DOMAINS.find((d) => d.split('.')[0] === domain); // sama nazwa bez końcówki: „gmail"
  if (!best) {
    const limit = domain.length <= 6 ? 1 : 2;
    const ranked = MAIL_DOMAINS.map((d) => [distance(domain, d), d]).sort((a, b) => a[0] - b[0]);
    if (ranked[0][0] <= limit && ranked[0][0] < ranked[1][0]) best = ranked[0][1];
  }
  const fixed = best && `${email.slice(0, at)}@${best}`;
  return fixed && fixed !== email ? fixed : null;
}

const zl = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
export const formatPrice = (value) => zl.format(value);
export const formatRate = (rate) => `${(rate || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} zł/min`;
export function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
// Opis ceny zamówienia albo null, gdy sprzedawca jeszcze jej nie ustalił.
export function priceText(o) {
  if (o.price == null) return null;
  const parts = [];
  if (o.printMinutes) parts.push(`druk ${formatMinutes(o.printMinutes)}`);
  if (o.serviceFee) parts.push(`usługa ${formatPrice(o.serviceFee)}`);
  return `${formatPrice(o.price)}${parts.length ? ` (${parts.join(' + ')})` : ''}`;
}
export const orderRate = (o) => Math.max(0, ...(o.filaments || []).map((f) => f.pricePerMinute || 0));
export const orderNumber = (o) => `#${String(o.id).padStart(3, '0')}`;

// Kolory zamówienia jako kropki z nazwami.
export function colors(o) {
  return h('span', { class: 'colors' }, ...(o.filaments || []).map((f) => h('span', {}, swatch(f.color), ` ${f.name}`)));
}

export function swatch(color) {
  return h('span', { class: 'swatch', style: `background:${color}` });
}

export function statusBadge(status) {
  return h('span', { class: `badge badge-${status}` }, STATUS[status] || status);
}
