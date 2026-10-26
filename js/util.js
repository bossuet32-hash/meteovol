// Outils communs : réseau avec cache hors ligne, réglages, géographie, formats.

export const $ = (sel, root = document) => root.querySelector(sel);
// remplace le contenu d'un élément en ignorant les valeurs vides (null, false)
export const fill = (root, ...kids) => root.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

// ---------------------------------------------------------------- réglages (par appareil)
const DEFAULTS = {
  site: { name: 'Toulouse', lat: 43.6045, lon: 1.444 },
  stations: [],             // vide = aérodromes les plus proches du site
  maxWind: 38,              // km/h, vent ou rafales max de la machine
  radiusKm: 10,
  zonesSite: null,          // null = même lieu que le site météo
};
export function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('mv.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
// Lieu de vol commun à tous les onglets (+ historique des lieux récents)
export function setSite(p) {
  const S = settings();
  const recent = [p, ...(S.recent || []).filter((r) => Math.abs(r.lat - p.lat) > 1e-4 || Math.abs(r.lon - p.lon) > 1e-4)].slice(0, 8);
  return saveSettings({ site: { name: p.name, lat: p.lat, lon: p.lon }, zonesSite: null, recent });
}
export function saveSettings(patch) {
  const s = { ...settings(), ...patch };
  try { localStorage.setItem('mv.settings', JSON.stringify(s)); } catch { /* stockage indisponible */ }
  return s;
}

// ---------------------------------------------------------------- réseau + cache (IndexedDB)
const DBN = 'meteovol', VER = 1;
let dbp = null;
export function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DBN, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache');
      if (!d.objectStoreNames.contains('missions')) d.createObjectStore('missions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function dbGet(store, key) {
  const d = await idb();
  return new Promise((res, rej) => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function dbPut(store, val, key) {
  const d = await idb();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); const q = key === undefined ? tx.objectStore(store).put(val) : tx.objectStore(store).put(val, key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function dbDel(store, key) {
  const d = await idb();
  return new Promise((res, rej) => { const q = d.transaction(store, 'readwrite').objectStore(store).delete(key); q.onsuccess = () => res(); q.onerror = () => rej(q.error); });
}
export async function dbAll(store) {
  const d = await idb();
  return new Promise((res, rej) => { const q = d.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

// Récupère une URL ; en cas d'échec réseau, renvoie la dernière réponse connue (avec son âge).
export async function fetchCached(url, { as = 'json', key = url, timeout = 20000, init } = {}) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = as === 'json' ? await r.json() : await r.text();
    dbPut('cache', { t: Date.now(), data }, key).catch(() => {});
    return { data, t: Date.now(), live: true };
  } catch (e) {
    const c = await dbGet('cache', key).catch(() => null);
    if (c) return { data: c.data, t: c.t, live: false };
    throw e;
  } finally { clearTimeout(tm); }
}

// ---------------------------------------------------------------- géographie
export function distKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
export function bearing(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const dir8 = (deg) => (deg == null ? '' : DIRS[Math.floor(((deg % 360) + 22.5) / 45) % 8]);

// Lambert-93 (EPSG:2154) depuis WGS84 — formules IGN (ellipsoïde GRS80)
export function toL93(lat, lon) {
  const a = 6378137, e = 0.0818191910428158, n = 0.725607765053267, C = 11754255.426096, xs = 700000, ys = 12655612.049876;
  const r = Math.PI / 180, phi = lat * r;
  const L = 0.5 * Math.log((1 + Math.sin(phi)) / (1 - Math.sin(phi))) - (e / 2) * Math.log((1 + e * Math.sin(phi)) / (1 - e * Math.sin(phi)));
  const R = C * Math.exp(-n * L), g = n * (lon - 3) * r;
  return { E: xs + R * Math.sin(g), N: ys - R * Math.cos(g) };
}

// Géocodage IGN (ville, adresse, lieu-dit) ou coordonnées tapées
export async function locate(txt) {
  const nums = (txt.match(/-?\d+[.,]\d+/g) || []).map((x) => +x.replace(',', '.'));
  if (nums.length >= 2 && Math.abs(nums[0]) <= 90 && Math.abs(nums[1]) <= 180) return [{ name: `${nums[0].toFixed(4)}, ${nums[1].toFixed(4)}`, lat: nums[0], lon: nums[1] }];
  const q = encodeURIComponent(txt);
  let js;
  try { js = (await fetchCached(`https://data.geopf.fr/geocodage/search?q=${q}&limit=6`)).data; }
  catch { js = (await fetchCached(`https://api-adresse.data.gouv.fr/search/?q=${q}&limit=6`)).data; }
  return (js.features || []).map((f) => ({
    name: f.properties.label + (f.properties.context ? ` (${f.properties.context.split(',')[0]})` : ''),
    lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
  }));
}

export function gps() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('GPS indisponible'));
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => rej(new Error(e.code === 1 ? 'Accès à la position refusé' : 'Position introuvable')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}

// ---------------------------------------------------------------- formats
const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}h${pad(d.getMinutes())}`; };
export const hh = (t) => `${pad(new Date(t).getHours())}h`;
export const jour = (t) => JOURS[new Date(t).getDay()];
export const dateFr = (t) => { const d = new Date(t); return `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`; };
export const fmtNum = (v, d = 1) => (v == null ? '—' : v.toFixed(d).replace('.', ','));
export function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const hh2 = Math.round(m / 60);
  return hh2 < 48 ? `il y a ${hh2} h` : `il y a ${Math.round(hh2 / 24)} j`;
}
export function fmtDist(m) {
  if (m === 0) return 'sur place';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('on'), ms);
}

// Feuille de choix d'un lieu : recherche, GPS, liste de résultats. Renvoie {name, lat, lon} ou null.
export function pickPlace(title = 'Choisir un lieu') {
  return new Promise((resolve) => {
    const list = h('div', { class: 'pick-list' });
    const input = h('input', { type: 'search', placeholder: 'Ville, adresse, ou « 43.488, 1.330 »', autocomplete: 'off', enterkeyhint: 'search' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const show = (items) => {
      list.replaceChildren(...(items.length ? items.map((it) => h('button', { class: 'pick-item', onclick: () => close(it) }, it.name)) : [h('p', { class: 'muted' }, 'Aucun résultat')]));
    };
    const search = async () => {
      if (!input.value.trim()) return;
      list.replaceChildren(h('p', { class: 'muted' }, 'Recherche…'));
      try { show(await locate(input.value.trim())); } catch { list.replaceChildren(h('p', { class: 'muted' }, 'Recherche impossible (pas de réseau ?)')); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    const dlg = h('dialog', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('strong', {}, title), h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Fermer')),
      h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: search }, 'Chercher')),
      h('button', { class: 'btn wide', onclick: async () => {
        list.replaceChildren(h('p', { class: 'muted' }, 'Lecture du GPS…'));
        try { const p = await gps(); close({ name: `Position GPS (±${Math.round(p.acc)} m)`, lat: p.lat, lon: p.lon }); }
        catch (e) { list.replaceChildren(h('p', { class: 'muted' }, e.message)); }
      } }, '📍 Ma position'),
      list);
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => input.focus(), 50);
  });
}

// ---------------------------------------------------------------- jours ouvrés (France métropolitaine)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const hh2 = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh2 - k) % 7, m = Math.floor((a + 11 * hh2 + 22 * l) / 451);
  const month = Math.floor((hh2 + l - 7 * m + 114) / 31), day = ((hh2 + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
export function isHoliday(d) {
  const y = d.getFullYear(), md = `${d.getMonth() + 1}-${d.getDate()}`;
  if (['1-1', '5-1', '5-8', '7-14', '8-15', '11-1', '11-11', '12-25'].includes(md)) return true;
  const e = easter(y);
  for (const off of [1, 39, 50]) { const x = new Date(e); x.setDate(x.getDate() + off); if (x.getMonth() === d.getMonth() && x.getDate() === d.getDate()) return true; }
  return false;
}
export const isWorkingDay = (d) => d.getDay() !== 0 && d.getDay() !== 6 && !isHoliday(d);
// ajoute (ou retire si n < 0) n jours ouvrés à une date
export function addWorkingDays(date, n) {
  const d = new Date(date); d.setHours(12, 0, 0, 0);
  const s = Math.sign(n); let k = Math.abs(n);
  while (k > 0) { d.setDate(d.getDate() + s); if (isWorkingDay(d)) k--; }
  return d;
}
export const dateLongFr = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
