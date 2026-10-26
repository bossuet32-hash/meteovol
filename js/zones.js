// Onglet « Zones » : restrictions SIA (ED-269) + ZICAD hors ligne, espaces protégés INPN et vigilance OSM en ligne.
// L'analyse reprend celle de la Kobo (zones.lua).
import { h, fill, settings, saveSettings, fetchCached, fmtDist, pickPlace, ago, toast, toL93, setSite } from './util.js';
import { ignLayer, orthoLayer, limitesLayer } from './map.js';

export const SEV = { PROHIBITED: 4, ZICAD: 4, REQ_AUTHORISATION: 3, NOTAM: 3, CONDITIONAL: 2, INFO: 1 };
export const LABEL = { PROHIBITED: 'INTERDIT', REQ_AUTHORISATION: 'AUTORISATION', CONDITIONAL: 'CONDITIONS', ZICAD: 'PRISE DE VUE INTERDITE', NOTAM: 'TEMPORAIRE', INFO: 'INFO', NONE: 'AUCUNE ZONE' };
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

// ---------------------------------------------------------------- géométrie locale (mètres)
export function proj(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];
}
function segdist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = 0;
  if (L2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return [Math.hypot(px - qx, py - qy), qx, qy];
}
export function geomDist(g, P) {
  if (g.t === 'C') {
    const [cx, cy] = P(g.c[0], g.c[1]);
    const d = Math.hypot(cx, cy);
    if (d <= g.r) return [0, 0, 0];
    const k = (d - g.r) / d;
    return [d - g.r, cx * k, cy * k];
  }
  let inside = false, best = Infinity, bx = 0, by = 0;
  for (const ring of g.rings || []) {
    const pts = ring.map((p) => P(p[0], p[1]));
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] > 0) !== (b[1] > 0) && 0 < ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      const [d, qx, qy] = segdist(0, 0, a[0], a[1], b[0], b[1]);
      if (d < best) { best = d; bx = qx; by = qy; }
    }
  }
  if (inside) return [0, 0, 0];
  return [best, bx, by];
}
const bearing = (x, y) => DIRS[Math.floor(((((Math.atan2(x, y) * 180) / Math.PI + 360) % 360) + 22.5) / 45) % 8];

export function agl(v, ref, ground) {
  if (v == null) return null;
  if (ref === 'AMSL' || ref === 'MSL') return ground == null ? null : Math.max(0, v - ground);
  return v;
}

// ---------------------------------------------------------------- données hors ligne (tuiles)
let META = null;
const tileCache = new Map();
export async function meta() {
  if (!META) META = (await fetchCached('data/zones/meta.json')).data;
  return META;
}
export async function loadZones(lat, lon, radius) {
  const m = await meta();
  const T = m.tile_deg || 2;
  const dlat = radius / 110540, dlon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const seen = new Set(), out = [];
  const jobs = [];
  for (let i = Math.floor((lon - dlon) / T); i <= Math.floor((lon + dlon) / T); i++) {
    for (let j = Math.floor((lat - dlat) / T); j <= Math.floor((lat + dlat) / T); j++) {
      const name = `t_${i}_${j}`;
      if (m.tile_list && !m.tile_list.includes(name)) continue;
      if (!tileCache.has(name)) tileCache.set(name, fetchCached(`data/zones/${name}.json`).then((r) => r.data).catch(() => []));
      jobs.push(tileCache.get(name));
    }
  }
  for (const arr of await Promise.all(jobs)) for (const z of arr || []) if (!seen.has(z.id)) { seen.add(z.id); out.push(z); }
  return { zones: out, meta: m };
}

// ---------------------------------------------------------------- analyse
export function analyse(zones, lat, lon, radius, ground) {
  const P = proj(lat, lon);
  const list = [];
  for (const z of zones) {
    let zd = Infinity, zx = 0, zy = 0;
    const at = [];
    for (const v of z.vols || []) {
      const [d, qx, qy] = geomDist(v.g, P);
      if (d < zd) { zd = d; zx = qx; zy = qy; }
      if (d === 0) at.push(v);
    }
    if (zd > radius) continue;
    const e = { z, dist: zd, inside: at.length > 0, restriction: z.type === 'ZICAD' ? 'ZICAD' : z.restriction || 'CONDITIONAL' };
    if (zd > 0) e.dir = bearing(zx, zy);
    e.qx = zx; e.qy = zy;
    let floor = null, known = true, ceil = null;
    for (const v of at.length ? at : z.vols) {
      const lo = agl(v.lo || 0, v.loRef, ground);
      if (lo == null) known = false; else if (floor == null || lo < floor) floor = lo;
      const up = agl(v.up, v.upRef, ground);
      if (up != null && (ceil == null || up > ceil)) ceil = up;
    }
    Object.assign(e, { floor, floor_known: known, ceil });
    e.above120 = floor != null && floor >= 120 && known;
    e.sev = e.above120 ? SEV.INFO : SEV[e.restriction] || 2;
    e.temp = z.permanent === false && ['R', 'D', 'P', 'ZIT'].includes(z.type);
    list.push(e);
  }
  list.sort((a, b) => (a.inside !== b.inside ? (a.inside ? -1 : 1) : a.sev !== b.sev ? b.sev - a.sev : a.dist - b.dist));
  const V = { level: 'NONE', maxh: 120, zones: [], ground: false, temp_only: true };
  let worst = 0;
  for (const e of list) {
    if (!e.inside || e.above120) continue;
    V.zones.push(e);
    const f = e.floor_known ? e.floor ?? 0 : 0;
    const blocking = e.restriction !== 'CONDITIONAL' && e.restriction !== 'ZICAD';
    const eff = blocking && f > 0 ? 2.5 : e.sev;
    if (eff > worst) { worst = eff; V.level = e.restriction; V.main = e; }
    if (blocking) {
      if (f < V.maxh || (f === V.maxh && V.limiting && V.limiting.temp && !e.temp)) { V.maxh = f; V.limiting = e; }
      if (f <= 0) { V.ground = true; if (!e.temp) V.temp_only = false; }
    }
  }
  if (!V.ground) V.temp_only = false;
  if (V.level !== 'NONE' && worst === 2.5) V.capped = true;
  return { list, V };
}

export function heightTxt(e) {
  if (e.restriction === 'ZICAD') return 'toute hauteur';
  if (e.above120) return `dès ${Math.round(e.floor)} m (sans effet ≤ 120 m)`;
  if (!e.floor_known) { const v = e.z.vols && e.z.vols[0]; return v ? `plancher ${Math.round(v.lo || 0)} m mer` : '?'; }
  if ((e.floor || 0) <= 0) return 'dès le sol';
  return `libre < ${Math.round(e.floor)} m`;
}
export const zname = (z) => (z.name || '?').replace(/^\[[^\]]+\]\s*/, '');

// ---------------------------------------------------------------- en ligne : OSM, INPN, altitude
function overpassQuery(lat, lon, r) {
  const a = `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:25];(nwr["aeroway"="helipad"]${a};nwr["aeroway"="heliport"]${a};nwr["aeroway"="aerodrome"]${a};way["aeroway"="airstrip"]${a};`
    + `nwr["amenity"="prison"]${a};nwr["power"="plant"]["plant:source"="nuclear"]${a};node["generator:source"="wind"]${a};nwr["military"]${a};);out tags center qt 400;`
    + `way["power"="line"]["voltage"]${a};out geom qt 80;`;
}
function osmKind(t) {
  if (t.aeroway === 'helipad' || t.aeroway === 'heliport') return ['HEL', 'hélistation'];
  if (t.aeroway === 'aerodrome') { const u = t.aerodrome === 'ultralight' || /ULM/i.test(t.name || ''); return [u ? 'ULM' : 'AD', u ? 'terrain ULM' : 'aérodrome / terrain']; }
  if (t.aeroway === 'airstrip') return ['ULM', 'piste (ULM, privée)'];
  if (t.amenity === 'prison') return ['PRI', 'établissement pénitentiaire'];
  if (t.power === 'plant') return ['NUC', 'centrale nucléaire'];
  if (t['generator:source'] === 'wind') return ['EOL', 'éolienne'];
  if (t.power === 'line') return ['HT', 'ligne haute tension'];
  if (t.military) return ['MIL', 'terrain militaire'];
  return ['?', 'site'];
}
export function parseOSM(js, lat, lon) {
  const P = proj(lat, lon);
  const out = [], lines = [];
  const seen = new Set();
  let wind = { n: 0 };
  for (const el of js.elements || []) {
    const t = el.tags || {};
    const [k, label] = osmKind(t);
    if (el.geometry && k === 'HT') {
      const kv = parseInt(t.voltage, 10);
      if (kv >= 63000) lines.push({ pts: el.geometry.map((g) => [g.lon, g.lat]), kv: Math.round(kv / 1000), name: t.name });
      continue;
    }
    const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
    if (la == null || k === 'HT') continue;
    const [x, y] = P(lo, la);
    const d = Math.hypot(x, y);
    if (k === 'EOL') { wind.n++; if (wind.d == null || d < wind.d) Object.assign(wind, { d, x, y }); continue; }
    const key = k + (t.name || '') + Math.floor(d / 300);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: k, label, name: t.name || t.operator, icao: t.icao, lat: la, lon: lo, dist: d, dir: bearing(x, y) });
  }
  let lmin = null;
  for (const l of lines) {
    for (let i = 0; i < l.pts.length - 1; i++) {
      const [ax, ay] = P(...l.pts[i]), [bx, by] = P(...l.pts[i + 1]);
      const [d] = segdist(0, 0, ax, ay, bx, by);
      if (l.d == null || d < l.d) l.d = d;
    }
    if (l.d != null && (!lmin || l.d < lmin.d)) lmin = l;
  }
  if (lmin) out.push({ kind: 'HT', label: `ligne haute tension ${lmin.kv} kV`, name: lmin.name, dist: lmin.d, dir: '' });
  if (wind.n) out.push({ kind: 'EOL', label: `${wind.n} éolienne(s)`, dist: wind.d, dir: bearing(wind.x, wind.y) });
  out.sort((a, b) => a.dist - b.dist);
  return { osm: out, lines };
}

export const PROTECTED = [
  ['patrinat_apb:apb', 'arrêté de protection de biotope'], ['patrinat_rnn:rnn', 'réserve naturelle nationale'],
  ['patrinat_rnr:rnr', 'réserve naturelle régionale'], ['patrinat_pn:parc_national', 'parc national'],
  ['patrinat_zps:zps', 'Natura 2000 (oiseaux, ZPS)'], ['patrinat_sic:sic', 'Natura 2000 (habitats, ZSC)'],
];
function bboxTxt(lat, lon, r) {
  const dlat = r / 110540, dlon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  return `${(lon - dlon).toFixed(5)},${(lat - dlat).toFixed(5)},${(lon + dlon).toFixed(5)},${(lat + dlat).toFixed(5)}`;
}
const WFS = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&SRSNAME=CRS:84&OUTPUTFORMAT=application/json';
async function protectedAreas(lat, lon, r) {
  const P = proj(lat, lon);
  const out = [];
  let ok = false;
  await Promise.all(PROTECTED.map(async ([tn, label]) => {
    try {
      const js = (await fetchCached(`${WFS}&TYPENAMES=${tn}&COUNT=50&BBOX=${bboxTxt(lat, lon, r)},CRS:84`)).data;
      ok = true;
      for (const f of js.features || []) {
        const g = f.geometry || {}, rings = [];
        if (g.type === 'Polygon') rings.push(...g.coordinates);
        else if (g.type === 'MultiPolygon') for (const p of g.coordinates) rings.push(...p);
        if (!rings.length) continue;
        const geom = { t: 'P', rings };
        const [d, qx, qy] = geomDist(geom, P);
        const pr = f.properties || {};
        out.push({ label, name: pr.nom_site || pr.nom || '?', url: pr.url_fiche, dist: d, dir: d > 0 ? bearing(qx, qy) : '', geom });
      }
    } catch { /* couche indisponible */ }
  }));
  out.sort((a, b) => a.dist - b.dist);
  return ok ? out : null;
}

export async function collect(site, radius) {
  const R = { lat: site.lat, lon: site.lon, site: site.name, radius, updated: Date.now() };
  const { zones, meta: m } = await loadZones(site.lat, site.lon, radius);
  R.meta = m;
  const [el, ov, pr] = await Promise.allSettled([
    fetchCached(`https://api.open-meteo.com/v1/elevation?latitude=${site.lat.toFixed(5)}&longitude=${site.lon.toFixed(5)}`),
    fetchCached('https://overpass-api.de/api/interpreter', { key: `ovp:${site.lat.toFixed(3)},${site.lon.toFixed(3)},${radius}`, timeout: 30000,
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(overpassQuery(site.lat, site.lon, radius)) } }),
    protectedAreas(site.lat, site.lon, radius),
  ]);
  if (el.status === 'fulfilled' && Array.isArray(el.value.data.elevation)) R.ground = el.value.data.elevation[0];
  const an = analyse(zones, site.lat, site.lon, radius, R.ground);
  R.list = an.list; R.verdict = an.V;
  if (ov.status === 'fulfilled') Object.assign(R, parseOSM(ov.value.data, site.lat, site.lon));
  if (pr.status === 'fulfilled') R.protected = pr.value;
  if (m && m.airac) {
    const t = Date.parse(m.airac + 'T12:00:00Z');
    R.airac_age = Math.floor((Date.now() - t) / 86400e3);
    R.outdated = R.airac_age > 28;
  }
  return R;
}

// ---------------------------------------------------------------- verdict lisible (bandeau)
export function bannerInfo(R) {
  const V = R.verdict;
  let lab = LABEL[V.level];
  const e = (V.capped && V.limiting) || V.main || V.zones[0];
  if (V.capped && V.maxh < 120) lab = `MAX ${Math.round(V.maxh)} m`;
  let l1, l2, cls;
  if (V.level === 'NONE') { l1 = 'Aucune zone SIA / ZICAD au point de vol'; l2 = 'Hauteur max 120 m (catégorie Ouverte) · vérifier NOTAM et arrêtés locaux'; cls = 'ok'; }
  else {
    const auth = e && (e.z.authShort || e.z.auth?.name) || 'autorité de la zone';
    l1 = 'Au point : ' + (e ? zname(e.z) : '?') + (V.temp_only && e && e.temp ? ' (si active)' : '');
    if (V.level === 'ZICAD') { l2 = 'Captation de vues interdite · dérogation SGDSN'; cls = 'bad'; }
    else if (V.capped && V.maxh < 120) { l2 = `Vol libre jusqu'à ${Math.round(V.maxh)} m sol · au-delà : accord ${auth}`; cls = 'warn'; }
    else if (V.level === 'CONDITIONAL') { l2 = e?.z.cond || 'Vol possible sous conditions'; cls = 'warn'; }
    else if (V.temp_only) { l2 = 'Zone non permanente : vérifier son activation (NOTAM, SOFIA)'; cls = 'warn'; }
    else if (V.level === 'REQ_AUTHORISATION') { l2 = 'Accord nécessaire dès le sol · ' + auth; cls = 'bad'; }
    else { l2 = 'Interdit dès le sol sauf accord · ' + auth; cls = 'bad'; }
    if (V.zones.length > 1) l2 += ` · ${V.zones.length} zones au point`;
  }
  return { lab, l1, l2, cls };
}

// ---------------------------------------------------------------- styles carte
export function volStyle(e, v, ground) {
  const lo = agl(v.lo || 0, v.loRef, ground);
  if (lo != null && lo >= 120) return null;
  const step = (lo || 0) > 0 && e.restriction !== 'CONDITIONAL' && e.restriction !== 'ZICAD';
  const col = { PROHIBITED: '#d32f2f', REQ_AUTHORISATION: '#ef6c00', CONDITIONAL: '#1565c0', ZICAD: '#7b1fa2' }[e.restriction] || '#555';
  if (step) return { color: col, weight: 1.2, dashArray: '6 4', fill: false };
  if (e.temp && e.restriction === 'PROHIBITED') return { color: col, weight: 1.6, dashArray: '10 6', fillColor: col, fillOpacity: 0.1 };
  if (e.restriction === 'ZICAD') return { color: col, weight: 2, dashArray: '4 3', fillColor: col, fillOpacity: 0.35 };
  return { color: col, weight: 1.8, fillColor: col, fillOpacity: e.restriction === 'CONDITIONAL' ? 0.12 : 0.22 };
}

// ---------------------------------------------------------------- rendu de l'onglet
let map = null;
const TAG = (e) => h('span', { class: `tag ${e.sev >= 3 && !e.above120 ? 'solid' : ''} r-${e.restriction}` }, e.above120 ? 'INFO' : LABEL[e.restriction] + (e.temp && e.restriction === 'PROHIBITED' ? ' si active' : ''));

// ---------------------------------------------------------------- liste <-> carte
let hl = null;              // surbrillance de la zone choisie
const rowOf = new Map();    // id de zone -> ligne de la liste

function geomLayers(g, st) {
  return g.t === 'C' ? L.circle([g.c[1], g.c[0]], { radius: g.r, ...st }) : L.polygon(g.rings.map((r) => r.map((p) => [p[1], p[0]])), st);
}
function flashRow(id) {
  const row = rowOf.get(id);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}
// Affiche une zone (ou un espace protégé / point OSM) sur la carte : contour en surbrillance, cadrage, bulle
export function showOnMap(item) {
  if (!map) return;
  if (hl) { hl.remove(); hl = null; }
  hl = L.layerGroup().addTo(map);
  let bounds = null, at = null, html = '';
  if (item.z) {
    const e = item;
    for (const v of e.z.vols || []) {
      const casing = geomLayers(v.g, { color: '#fff', weight: 8, opacity: 0.9, fill: false, interactive: false }).addTo(hl);
      geomLayers(v.g, { color: '#000', weight: 3.5, fill: true, fillColor: '#ffd400', fillOpacity: 0.1, interactive: false }).addTo(hl);
      bounds = bounds ? bounds.extend(casing.getBounds()) : casing.getBounds();
    }
    const a = e.z.auth || {};
    html = `<b>${zname(e.z).replace(/</g, '&lt;')}</b><br>${e.z.typeLabel || ''}${e.z.detail ? ' · ' + e.z.detail : ''}<br><b>${LABEL[e.restriction]}</b> · ${heightTxt(e)}<br><small>${(e.z.cond || '').replace(/</g, '&lt;')}<br>${(e.z.authShort || a.name || '').replace(/</g, '&lt;')}${a.phone ? ' · ' + a.phone : ''}</small>`;
    at = e.inside ? [item.lat0, item.lon0] : null;
  } else if (item.geom) {
    const lay = geomLayers(item.geom, { color: '#000', weight: 3, fillColor: '#2e7d32', fillOpacity: 0.2, interactive: false }).addTo(hl);
    bounds = lay.getBounds();
    html = `<b>${item.name}</b><br>${item.label}`;
  } else if (item.lat != null) {
    L.circleMarker([item.lat, item.lon], { radius: 14, color: '#000', weight: 3, fill: false, interactive: false }).addTo(hl);
    bounds = L.latLngBounds([[item.lat, item.lon], [item.lat, item.lon]]);
    html = `<b>${item.label}</b>${item.name ? '<br>' + item.name : ''}`;
  }
  if (!bounds) return;
  document.querySelector('.zones-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  map.fitBounds(bounds, { maxZoom: 15, animate: true, paddingTopLeft: [20, 140], paddingBottomRight: [20, 50] });
  const pos = at && at[0] != null ? L.latLng(at[0], at[1]) : bounds.getCenter();
  setTimeout(() => L.popup({ autoPan: true, autoPanPaddingTopLeft: [10, 10], maxWidth: 260, className: 'zpop' }).setLatLng(L.latLng(bounds.getNorth(), pos.lng)).setContent(html).openOn(map), 350);
}

function zoneRow(e, withDist) {
  const a = e.z.auth || {};
  const row = h('div', { class: 'zrow click', role: 'button', tabindex: '0', title: 'Voir sur la carte',
    onclick: (ev) => { if (ev.target.closest('a')) return; showOnMap(e); },
    onkeydown: (ev) => { if (ev.key === 'Enter') showOnMap(e); } },
    withDist ? h('div', { class: 'zd' }, h('b', {}, fmtDist(e.dist)), h('div', { class: 'small muted' }, e.dir || '')) : null,
    h('div', { class: 'zn' }, h('b', {}, zname(e.z)), h('div', { class: 'small muted' }, (e.z.typeLabel || '') + (e.z.detail ? ' · ' + e.z.detail : ''))),
    h('div', { class: 'zt' }, TAG(e), h('div', { class: 'small' }, heightTxt(e))),
    h('div', { class: 'zc small' }, e.z.cond || e.z.message || '', h('div', { class: 'muted' }, h('b', {}, e.z.authShort || a.name || ''), a.phone ? ' · ' + a.phone : '', a.email ? ' · ' + a.email : '')),
    h('div', { class: 'zgo small' }, 'Voir sur la carte ›'));
  rowOf.set(e.z.id, row);
  return row;
}

export async function render(root) {
  const S = settings();
  const site = S.site;
  const radius = (S.radiusKm || 10) * 1000;
  fill(root, h('p', { class: 'muted' }, 'Analyse des zones…'));
  let R;
  try { R = await collect(site, radius); } catch (e) { fill(root, h('p', { class: 'warn-txt' }, 'Zones indisponibles : ' + e.message)); return; }
  const B = bannerInfo(R);
  const mapBox = h('div', { class: 'map zones-map' });
  const l93 = toL93(site.lat, site.lon);
  rowOf.clear(); hl = null;
  R.list.forEach((e) => { e.lat0 = R.lat; e.lon0 = R.lon; });
  const inside = R.list.filter((e) => e.inside && !e.above120), near = R.list.filter((e) => !e.inside && !e.above120), info = R.list.filter((e) => e.above120);
  fill(root, 
    h('section', { class: `banner ${B.cls}` }, h('div', { class: 'ban-lab' }, B.lab), h('div', { class: 'ban-txt' }, h('b', {}, B.l1), h('div', { class: 'small' }, B.l2))),
    h('div', { class: 'row space' },
      h('div', { class: 'small muted' }, `${site.name} · ${site.lat.toFixed(5)}, ${site.lon.toFixed(5)} · L93 ${Math.round(l93.E)} / ${Math.round(l93.N)}`),
      h('button', { class: 'btn small', onclick: async () => { const p = await pickPlace('Lieu de vol'); if (p) { setSite(p); render(root); } } }, 'Lieu…')),
    h('div', { class: 'map-wrap' }, mapBox),
    h('p', { class: 'small muted' }, 'Touchez une zone de la carte ou de la liste pour la mettre en évidence · appui long ou « Analyser le centre » pour un autre point · rouge : interdit · orange : accord · bleu : conditions · violet : ZICAD · tireté : au-delà d\'une hauteur'),
    R.outdated ? h('p', { class: 'warn-txt' }, `Données SIA périmées (AIRAC ${R.meta.airac}, ${R.airac_age} jours) : mettre à jour le dossier data/zones.`) : null,
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, `Au point de vol · ${inside.length} zone(s)`),
      inside.length ? inside.map((e) => zoneRow(e, false)) : h('p', {}, 'Aucune zone SIA / ZICAD au point de vol (sous 120 m).')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, `À proximité (${S.radiusKm || 10} km) · ${near.length} zone(s)`),
      near.length ? near.map((e) => zoneRow(e, true)) : h('p', {}, 'Aucune autre zone dans le rayon.'),
      info.length ? h('p', { class: 'small muted' }, 'Sans effet sous 120 m : ', ...info.map((e) => h('button', { class: 'chip', onclick: () => showOnMap(e) }, `${zname(e.z)} (dès ${Math.round(e.floor)} m)`))) : null),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'NOTAM'),
      h('p', { class: 'small' }, 'Les restrictions temporaires ne sont pas intégrées : vérifier avant le vol sur ', h('a', { href: 'https://sofia-briefing.aviation-civile.gouv.fr/', target: '_blank', rel: 'noopener' }, 'SOFIA-Briefing'), ' pour la date et l\'heure du vol.')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, `Vigilance OpenStreetMap · ${R.osm ? R.osm.length : '—'}`),
      R.osm ? (R.osm.length ? h('ul', { class: 'plain' }, ...R.osm.slice(0, 12).map((o) => h('li', o.lat != null ? { class: 'click', onclick: () => showOnMap(o) } : {}, h('b', {}, fmtDist(o.dist) + ' ' + (o.dir || '')), ' ', o.label, o.name ? ' · ' + o.name : '', o.icao ? ` (${o.icao})` : ''))) : h('p', { class: 'small' }, 'Rien de signalé (hélistations, ULM, lignes HT, éoliennes, prisons…).'))
        : h('p', { class: 'small muted' }, 'Non disponible (pas de réseau).')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'Espaces protégés (INPN) · survol possiblement réglementé'),
      R.protected ? (R.protected.length ? h('ul', { class: 'plain' }, ...R.protected.slice(0, 8).map((p) => h('li', { class: 'click', onclick: (ev) => { if (!ev.target.closest('a')) showOnMap(p); } }, h('b', {}, fmtDist(p.dist) + ' ' + (p.dir || '')), ' ', p.label, ' · ', p.name, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'small' }, ' fiche INPN') : ''))) : h('p', { class: 'small' }, 'Aucun espace protégé recensé dans le rayon.'))
        : h('p', { class: 'small muted' }, 'Non disponible (pas de réseau).')),
    h('p', { class: 'foot' }, `Données : SIA ${R.meta ? R.meta.source + ' (AIRAC ' + R.meta.airac + ')' : 'absentes'}, ZICAD, OSM, INPN, IGN · altitude du sol ${R.ground != null ? Math.round(R.ground) + ' m' : 'inconnue'} · analysé ${ago(R.updated)}. Géovigilance : ne remplace ni l'AIP, ni les SUP AIP, ni les NOTAM.`));
  drawMap(mapBox, R, root);
  return R;
}

function drawMap(box, R, root) {
  if (map) { map.remove(); map = null; }
  map = L.map(box, { preferCanvas: true, zoomControl: true }).setView([R.lat, R.lon], 11);
  const plan = ignLayer().addTo(map), ortho = orthoLayer();
  const lim = limitesLayer().addTo(map);
  const zl = L.layerGroup().addTo(map), pl = L.layerGroup().addTo(map), ol = L.layerGroup().addTo(map);
  L.control.layers({ 'Plan IGN': plan, 'Photo aérienne': ortho }, { 'Limites communales': lim, 'Zones SIA / ZICAD': zl, 'Espaces protégés': pl, 'Vigilance OSM': ol }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const order = [...R.list].sort((a, b) => a.sev - b.sev);
  for (const e of order) {
    if (e.above120) continue;
    for (const v of e.z.vols || []) {
      const st = volStyle(e, v, R.ground);
      if (!st) continue;
      const g = v.g;
      const lo = agl(v.lo || 0, v.loRef, R.ground);
      const pop = `<b>${zname(e.z).replace(/</g, '&lt;')}</b><br>${e.z.typeLabel || ''}<br>${LABEL[e.restriction]} · ${lo == null ? 'plancher ' + Math.round(v.lo) + ' m mer' : lo <= 0 ? 'dès le sol' : 'au-delà de ' + Math.round(lo) + ' m'}<br><small>${(e.z.cond || '').replace(/</g, '&lt;')}</small>`;
      const layer = geomLayers(g, st);
      const box2 = h('div', { html: pop });
      box2.append(h('div', {}, h('button', { class: 'linklike small', onclick: () => { map.closePopup(); flashRow(e.z.id); } }, 'Voir dans la liste ›')));
      layer.bindPopup(box2).addTo(zl);
    }
  }
  for (const p of R.protected || []) {
    L.polygon(p.geom.rings.map((r) => r.map((q) => [q[1], q[0]])), { color: '#2e7d32', weight: 1.4, dashArray: '2 4', fillColor: '#2e7d32', fillOpacity: 0.06 })
      .bindPopup(`<b>${p.name}</b><br>${p.label}`).addTo(pl);
  }
  const SYM = { HEL: 'H', ULM: 'U', AD: 'A', PRI: 'P', NUC: 'N', MIL: 'M' };
  for (const o of R.osm || []) {
    if (!o.lat || !SYM[o.kind]) continue;
    L.marker([o.lat, o.lon], { icon: L.divIcon({ className: 'osm-ic', html: SYM[o.kind], iconSize: [20, 20] }) }).bindPopup(`${o.label}${o.name ? '<br>' + o.name : ''}`).addTo(ol);
  }
  for (const l of R.lines || []) L.polyline(l.pts.map((p) => [p[1], p[0]]), { color: '#000', weight: 1.5, dashArray: '2 4' }).bindPopup(`Ligne ${l.kv} kV${l.name ? '<br>' + l.name : ''}`).addTo(ol);
  L.circle([R.lat, R.lon], { radius: 1000, color: '#000', weight: 1, dashArray: '3 3', fill: false, interactive: false }).addTo(map);
  L.circleMarker([R.lat, R.lon], { radius: 8, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map).bindPopup('Point de vol');
  const analyseAt = (ll) => {
    const p = { name: `Point ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`, lat: ll.lat, lon: ll.lng };
    setSite(p); toast('Analyse du nouveau point…'); render(root);
  };
  // appui long (ou clic droit) : analyser ce point ; bouton : analyser le centre (réticule)
  map.on('contextmenu', (ev) => analyseAt(ev.latlng));
  const Ctl = L.Control.extend({ onAdd() {
    const b = L.DomUtil.create('button', 'btn small map-btn');
    b.textContent = '⌖ Analyser le centre';
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => analyseAt(map.getCenter());
    return b;
  } });
  new Ctl({ position: 'bottomleft' }).addTo(map);
  box.append(h('div', { class: 'crosshair', 'aria-hidden': 'true' }));
  setTimeout(() => map.invalidateSize(), 50);
  if (window.ResizeObserver) new ResizeObserver(() => map && map.invalidateSize()).observe(box);
}
