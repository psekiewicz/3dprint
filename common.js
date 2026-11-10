// Wspólne funkcje strony kupującego i panelu sprzedawcy.
export const API = (window.API_URL || '').replace(/\/$/, '');

export const STATUS = {
  new: 'Oczekuje',
  printing: 'Drukuje się',
  done: 'Gotowe do odbioru',
  collected: 'Odebrane',
  rejected: 'Odrzucone',
  cancelled: 'Anulowane',
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
      ? 'Ta strona nie ma podłączonego serwera zamówień. Wpisz „demo", aby otworzyć wersję pokazową.'
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

const zl = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
export const formatPrice = (value) => zl.format(value);
export const formatRate = (rate) => `${(rate || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} zł/min`;
export function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
// Opis ceny zamówienia albo null, gdy sprzedawca jeszcze jej nie ustalił.
export const priceText = (o) =>
  (o.price == null ? null : `Cena: ${formatPrice(o.price)} (czas druku ${formatMinutes(o.printMinutes)})`);

export function swatch(color) {
  return h('span', { class: 'swatch', style: `background:${color}` });
}

export function statusBadge(status) {
  return h('span', { class: `badge badge-${status}` }, STATUS[status] || status);
}
