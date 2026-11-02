// Onglet « Vol 3D » : plan de vol autour d'un bâtiment (façades, orbites, toiture) pour DJI Fly (Air 3S, radiocommande RC 2).
// Bâtiments et hauteurs : BD TOPO IGN ; altitude du décollage : RGE ALTI IGN. Sortie : KMZ DJI Fly + CSV.
import { h, fill, settings, fetchCached, toast, fmtNum } from './util.js';
import { ignLayer, orthoLayer } from './map.js';
import * as Pl from './planner.js';
import { buildKmz, readTemplate } from './kmz.js';

const WFS = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&SRSNAME=CRS:84&OUTPUTFORMAT=application/json&TYPENAMES=BDTOPO_V3:batiment';
const ALTI = (lat, lon) => `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&resource=ign_rge_alti_wld&zonly=true`;
const KEY = 'mv.p3d';

const S = {
  feats: new Map(),      // cleabs -> feature
  sel: [],               // cleabs sélectionnés
  takeoff: null,         // { lat, lon, z }
  over: {},              // corrections { zg, zt }
  P: { ...Pl.DEFAUTS },
  tpl: [],               // modèles DJI Fly
  R: null,
};
try { Object.assign(S.P, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* */ }
const saveP = () => { try { localStorage.setItem(KEY, JSON.stringify(S.P)); } catch { /* */ } };

let map, bLayer, pathLayer, tkMarker, els = {};

// ---------------------------------------------------------------- données IGN
const zOf = (p) => ({
  zg: p.altitude_minimale_sol ?? null,
  zt: p.altitude_maximale_toit ?? (p.altitude_minimale_sol != null && p.hauteur != null ? p.altitude_minimale_sol + p.hauteur : null),
});
function outer(g) {
  if (!g) return null;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiPolygon') {
    let best = null, ba = -1;
    for (const poly of g.coordinates) {
      const r = poly[0];
      const a = Math.abs(Pl.area(r.map((p) => [p[0] * 80000, p[1] * 111000])));
      if (a > ba) { ba = a; best = r; }
    }
    return best;
  }
  return null;
}

async function loadBuildings() {
  if (!map || map.getZoom() < 16) { els.hint && (els.hint.textContent = 'Zoomez sur le bâtiment pour afficher les contours (BD TOPO).'); return; }
  const b = map.getBounds();
  const url = `${WFS}&COUNT=1500&BBOX=${b.getWest().toFixed(5)},${b.getSouth().toFixed(5)},${b.getEast().toFixed(5)},${b.getNorth().toFixed(5)},CRS:84`;
  els.hint.textContent = 'Chargement des bâtiments…';
  try {
    const js = (await fetchCached(url, { timeout: 30000 })).data;
    let n = 0;
    for (const f of js.features || []) {
      const id = f.properties?.cleabs || f.id;
      if (!S.feats.has(id)) { S.feats.set(id, f); n++; }
    }
    drawBuildings();
    els.hint.textContent = 'Touchez un ou plusieurs bâtiments, puis placez le point de décollage (D).';
  } catch (e) {
    els.hint.textContent = 'BD TOPO indisponible (' + e.message + ').';
  }
}

function drawBuildings() {
  bLayer.clearLayers();
  for (const [id, f] of S.feats) {
    const on = S.sel.includes(id);
    L.geoJSON(f, {
      style: { color: on ? '#d32f2f' : '#ffd54f', weight: on ? 3 : 1, fillOpacity: on ? 0.35 : 0.08, fillColor: on ? '#d32f2f' : '#ffd54f' },
      onEachFeature: (_, lyr) => lyr.on('click', (e) => { L.DomEvent.stop(e); toggle(id); }),
    }).addTo(bLayer);
  }
}

function toggle(id) {
  const i = S.sel.indexOf(id);
  if (i >= 0) S.sel.splice(i, 1); else S.sel.push(id);
  S.over = {};
  drawBuildings();
  if (S.sel.length && !S.takeoff) {
    // décollage proposé à 35 m au sud du bâtiment
    const f = S.feats.get(S.sel[0]); const r = outer(f.geometry);
    const lat = Math.min(...r.map((p) => p[1])) - 35 / 110540, lon = r.reduce((s, p) => s + p[0], 0) / r.length;
    setTakeoff(lat, lon);
  }
  recompute();
}

async function setTakeoff(lat, lon) {
  S.takeoff = { lat, lon, z: null };
  if (!tkMarker) {
    tkMarker = L.marker([lat, lon], { draggable: true, icon: L.divIcon({ className: 'p3d-tk', html: 'D', iconSize: [28, 28] }) }).addTo(map);
    tkMarker.on('dragend', () => { const p = tkMarker.getLatLng(); setTakeoff(p.lat, p.lng); });
  } else tkMarker.setLatLng([lat, lon]);
  try {
    const z = (await fetchCached(ALTI(lat, lon))).data.elevations?.[0];
    if (typeof z === 'number' && z > -100) S.takeoff.z = z;
  } catch { /* */ }
  recompute();
}

// ---------------------------------------------------------------- calcul
function building() {
  if (!S.sel.length) return null;
  const fs = S.sel.map((id) => S.feats.get(id)).filter(Boolean);
  const rings = fs.map((f) => outer(f.geometry)).filter(Boolean);
  const all = rings.flat();
  const lat0 = all.reduce((s, p) => s + p[1], 0) / all.length, lon0 = all.reduce((s, p) => s + p[0], 0) / all.length;
  const F = Pl.frame(lat0, lon0);
  const loc = (r) => { const q = r.map((p) => F.xy(p[1], p[0])); if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop(); return q; };
  const ring = rings.length === 1 ? loc(rings[0]) : Pl.hull(rings.flatMap(loc));
  const zs = fs.map((f) => zOf(f.properties));
  const zgs = zs.map((z) => z.zg).filter((v) => v != null), zts = zs.map((z) => z.zt).filter((v) => v != null);
  const B = {
    F, ring, multi: rings.length > 1,
    zg: S.over.zg ?? (zgs.length ? Math.min(...zgs) : null),
    zt: S.over.zt ?? (zts.length ? Math.max(...zts) : null),
    props: fs.map((f) => f.properties),
  };
  B.voisins = [];
  for (const [id, f] of S.feats) {
    if (S.sel.includes(id)) continue;
    const r = outer(f.geometry); if (!r) continue;
    const q = loc(r);
    const d = Math.min(...q.map((p) => Pl.distPoly(p, ring)), ...ring.map((p) => Pl.distPoly(p, q)));
    if (d > 120) continue;
    const z = zOf(f.properties);
    B.voisins.push({ ring: q, zt: z.zt ?? (B.zt ?? 0), dist: d });
  }
  return B;
}

let tmr = null;
function recompute() { clearTimeout(tmr); tmr = setTimeout(compute, 150); }
function compute() {
  const B = building();
  S.B = B;
  if (!B) { S.R = null; renderAll(); return; }
  if (B.zg == null || B.zt == null || !S.takeoff || S.takeoff.z == null) { S.R = null; renderAll(); return; }
  const T = { ...S.takeoff };
  [T.x, T.y] = B.F.xy(T.lat, T.lon);
  try {
    S.R = Pl.plan(B, B.voisins, T, S.P); S.R.T = T;
    if (Pl.inside([T.x, T.y], B.ring) || B.voisins.some((v) => Pl.inside([T.x, T.y], v.ring))) S.R.alertes.unshift('Le point de décollage est sur un bâtiment : le déplacer au sol (appui long sur la carte ou glisser le repère D)');
  } catch (e) { console.error(e); S.R = { err: e.message }; }
  renderAll();
}

// ---------------------------------------------------------------- export
function wpsGeo(R, B, list = R.wps) {
  return list.map((w) => { const [lat, lon] = B.F.ll(w.x, w.y); return { ...w, lat, lon, h: w.z - R.T.z, speed: w.transit ? S.P.transit : S.P.vitesse }; });
}
async function share(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && /iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}
function baseName() {
  const p = S.B?.props?.[0];
  return 'vol3d_' + (p?.cleabs ? p.cleabs.slice(-6) : 'batiment') + '_' + new Date().toISOString().slice(0, 10);
}
async function exportKmz() {
  const R = S.R, B = S.B;
  const parts = Pl.split(R.wps, S.P.maxParMission, R.zSafe).map((part) => wpsGeo(R, B, part));
  for (let i = 0; i < parts.length; i++) {
    const tp = S.tpl[i] || S.tpl[0];
    const wps = parts[i];
    let Lg = 0; for (let k = 1; k < wps.length; k++) Lg += Math.hypot(wps[k].x - wps[k - 1].x, wps[k].y - wps[k - 1].y, wps[k].z - wps[k - 1].z);
    const k = buildKmz({ wps, speed: S.P.vitesse, transit: S.P.transit, length: Lg, duration: Lg / S.P.vitesse },
      tp ? { droneEnumValue: tp.droneEnumValue, droneSubEnumValue: tp.droneSubEnumValue, ns: tp.ns } : {}, { straight: S.P.droite !== false });
    const name = (S.tpl[i] ? S.tpl[i].name : baseName() + (parts.length > 1 ? `_partie${i + 1}` : '')) + '.kmz';
    await share(k.blob, name);
  }
}
function exportCsv() {
  const rows = [['n', 'groupe', 'lat', 'lon', 'hauteur_decollage_m', 'altitude_ngf_m', 'cap_deg', 'nacelle_deg', 'photo']];
  wpsGeo(S.R, S.B).forEach((w, i) => rows.push([i, w.groupe || (w.transit ? 'transit' : ''), w.lat.toFixed(7), w.lon.toFixed(7), w.h.toFixed(1), w.z.toFixed(1), Math.round(w.yaw), w.pitch, w.photo ? 1 : 0]));
  share(new Blob([rows.map((r) => r.join(';')).join('\n')], { type: 'text/csv' }), baseName() + '.csv');
}

// ---------------------------------------------------------------- vue 3D
function view3d(canvas, R, B) {
  const ctx = canvas.getContext('2d');
  let az = -35, el = 28, drag = null;
  const dpr = window.devicePixelRatio || 1;
  const pts = [];
  const add = (x, y, z) => pts.push([x, y, z]);
  B.ring.forEach((p) => { add(p[0], p[1], B.zg); add(p[0], p[1], B.zt); });
  R.wps.forEach((w) => add(w.x, w.y, w.z));
  add(R.T.x, R.T.y, R.T.z);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const cz = (Math.min(...pts.map((p) => p[2])) + Math.max(...pts.map((p) => p[2]))) / 2;
  const rad = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz))) || 1;
  const col = { toit: '#1e88e5', orbite: '#8e24aa', facade: '#e53935' };
  const grp = {}; (R.groups || []).forEach((g) => (grp[g.nom] = g.type));
  function draw() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180, s = (Math.min(W, H) / 2.2) / rad;
    const P = (x, y, z) => {
      const X = x - cx, Y = y - cy, Z = z - cz;
      const xr = X * Math.cos(a) - Y * Math.sin(a), yr = X * Math.sin(a) + Y * Math.cos(a);
      return [W / 2 + xr * s, H / 2 - (Z * Math.cos(e) + yr * Math.sin(e)) * s, yr * Math.cos(e) - Z * Math.sin(e)];
    };
    const line = (p, q, c, w = 1) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
    // sol et voisins
    ctx.globalAlpha = 0.6;
    for (const v of B.voisins) {
      if (v.dist > 60) continue;
      ctx.fillStyle = '#9e9e9e'; ctx.beginPath();
      v.ring.forEach((p, i) => { const q = P(p[0], p[1], v.zt); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // bâtiment
    const n = B.ring.length;
    ctx.fillStyle = 'rgba(211,47,47,.18)'; ctx.beginPath();
    B.ring.forEach((p, i) => { const q = P(p[0], p[1], B.zt); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill();
    for (let i = 0; i < n; i++) {
      const p = B.ring[i], q = B.ring[(i + 1) % n];
      line(P(p[0], p[1], B.zg), P(q[0], q[1], B.zg), '#b71c1c', 1);
      line(P(p[0], p[1], B.zt), P(q[0], q[1], B.zt), '#b71c1c', 1.5);
      line(P(p[0], p[1], B.zg), P(p[0], p[1], B.zt), '#b71c1c', 1);
    }
    // trajet
    let prev = P(R.T.x, R.T.y, R.T.z);
    for (const w of R.wps) {
      const q = P(w.x, w.y, w.z);
      line(prev, q, w.transit ? '#888' : (col[grp[w.groupe]] || '#333'), w.transit ? 1 : 1.4);
      prev = q;
    }
    line(prev, P(R.T.x, R.T.y, R.T.z), '#888', 1);
    for (const w of R.wps) {
      if (!w.photo) continue;
      const q = P(w.x, w.y, w.z);
      const yr = (w.yaw * Math.PI) / 180, pr = (w.pitch * Math.PI) / 180, k = 3;
      const t = P(w.x + Math.sin(yr) * Math.cos(pr) * k, w.y + Math.cos(yr) * Math.cos(pr) * k, w.z + Math.sin(pr) * k);
      line(q, t, '#333', 0.8);
      ctx.fillStyle = col[grp[w.groupe]] || '#333'; ctx.beginPath(); ctx.arc(q[0], q[1], 2.2, 0, 7); ctx.fill();
    }
    const t = P(R.T.x, R.T.y, R.T.z);
    ctx.fillStyle = '#2e7d32'; ctx.beginPath(); ctx.arc(t[0], t[1], 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('D', t[0], t[1] + 3);
  }
  canvas.onpointerdown = (e) => { drag = [e.clientX, e.clientY, az, el]; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => { if (!drag) return; az = drag[2] + (e.clientX - drag[0]) * 0.5; el = Math.max(2, Math.min(89, drag[3] + (e.clientY - drag[1]) * 0.4)); draw(); };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
  draw();
  if (window.ResizeObserver) new ResizeObserver(draw).observe(canvas);
}

// ---------------------------------------------------------------- affichage
function num(label, key, step, min, max, unit) {
  return h('label', {}, h('div', { class: 'lbl' }, label + (unit ? ` (${unit})` : '')),
    h('input', { type: 'number', inputmode: 'decimal', step, min, max, value: S.P[key], onchange: (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (!isNaN(v)) { S.P[key] = Math.min(max, Math.max(min, v)); saveP(); recompute(); } } }));
}
function chk(label, key) {
  return h('label', { class: 'p3d-chk' }, h('input', { type: 'checkbox', checked: !!S.P[key], onchange: (e) => { S.P[key] = e.target.checked; saveP(); recompute(); } }), ' ', label);
}

function renderAll() {
  const B = S.B, R = S.R;
  // bâtiment
  if (!B) {
    fill(els.bat, h('p', { class: 'small muted' }, 'Aucun bâtiment choisi.'));
  } else {
    const p = B.props[0] || {};
    const H = B.zt != null && B.zg != null ? B.zt - B.zg : null;
    fill(els.bat,
      h('div', { class: 'row space' }, h('b', {}, B.multi ? `${B.props.length} bâtiments (enveloppe commune)` : (p.usage_1 || p.nature || 'Bâtiment')),
        h('button', { class: 'btn small ghost', onclick: () => { S.sel = []; S.over = {}; drawBuildings(); recompute(); } }, 'Effacer')),
      h('p', { class: 'small' }, `Hauteur ${H != null ? fmtNum(H, 1) + ' m' : 'inconnue'}`
        + (p.nombre_d_etages ? ` · ${p.nombre_d_etages} niveau(x)` : '')
        + (p.precision_altimetrique ? ` · précision altimétrique ±${fmtNum(p.precision_altimetrique, 1)} m` : '')
        + (p.methode_d_acquisition_altimetrique ? ` · ${p.methode_d_acquisition_altimetrique}` : '')),
      h('div', { class: 'grid2' },
        h('label', {}, h('div', { class: 'lbl' }, 'Sol (m NGF)'), h('input', { type: 'number', step: 0.1, value: B.zg != null ? B.zg.toFixed(1) : '', onchange: (e) => { S.over.zg = parseFloat(e.target.value); recompute(); } })),
        h('label', {}, h('div', { class: 'lbl' }, 'Point le plus haut du toit (m NGF)'), h('input', { type: 'number', step: 0.1, value: B.zt != null ? B.zt.toFixed(1) : '', onchange: (e) => { S.over.zt = parseFloat(e.target.value); recompute(); } }))),
      h('p', { class: 'small muted' }, `Décollage : ${S.takeoff?.z != null ? 'sol ' + fmtNum(S.takeoff.z, 1) + ' m NGF (RGE ALTI)' : 'altitude en cours…'} · déplacer le repère D sur la carte.`
        + ' Ajouter cheminées, antennes, arbres à la main : corriger le point le plus haut.'));
  }
  // résultat
  if (pathLayer) pathLayer.clearLayers();
  if (!R || R.err) {
    fill(els.res, h('p', { class: R?.err ? 'warn-txt' : 'small muted' }, R?.err ? 'Calcul impossible : ' + R.err : (B ? 'Altitudes du bâtiment ou du décollage manquantes.' : 'Choisissez un bâtiment sur la carte.')));
    return;
  }
  const st = R.stats;
  const col = { toit: '#1e88e5', orbite: '#8e24aa', facade: '#e53935' };
  const geo = wpsGeo(R, B);
  L.polyline([[S.takeoff.lat, S.takeoff.lon], ...geo.map((w) => [w.lat, w.lon]), [S.takeoff.lat, S.takeoff.lon]], { color: '#fff', weight: 1, opacity: 0.8, dashArray: '4 4' }).addTo(pathLayer);
  const grp = {}; R.groups.forEach((g) => (grp[g.nom] = g.type));
  geo.forEach((w) => { if (w.photo) L.circleMarker([w.lat, w.lon], { radius: 3, weight: 1, color: '#fff', fillColor: col[grp[w.groupe]] || '#333', fillOpacity: 1 }).bindTooltip(`${w.groupe} · ${Math.round(w.h)} m · cap ${Math.round(w.yaw)}° · nacelle ${w.pitch}°`).addTo(pathLayer); });
  const canvas = h('canvas', { class: 'p3d-canvas' });
  const min = Math.round(st.duree / 60);
  fill(els.res,
    h('div', { class: 'p3d-stats' },
      h('div', {}, h('b', {}, st.photos), h('span', {}, 'photos')),
      h('div', {}, h('b', {}, '~' + min + ' min'), h('span', {}, `${st.batteries} batterie(s)`)),
      h('div', {}, h('b', {}, Math.round(st.hMax) + ' m'), h('span', {}, 'haut. max')),
      h('div', {}, h('b', {}, st.points), h('span', {}, `points${st.parts > 1 ? ' · ' + st.parts + ' fichiers' : ''}`))),
    h('p', { class: 'small' }, `Façades à ${fmtNum(st.dF, 1)} m du mur (${fmtNum(st.gsdF, 1)} mm/px) · altitude de sécurité ${Math.round(R.zSafe - R.T.z)} m au-dessus du décollage.`),
    h('ul', { class: 'p3d-groups small' }, ...R.groups.map((g) => h('li', {}, h('span', { class: 'dot', style: `background:${col[g.type]}` }), `${g.nom} · ${g.n} photos`))),
    R.alertes.length ? h('ul', { class: 'small warn-txt' }, ...R.alertes.map((a) => h('li', {}, a))) : null,
    canvas,
    h('p', { class: 'small muted' }, 'Vue 3D : glisser pour tourner. Rouge : façades, violet : orbites, bleu : toiture, gris : déplacements sans photo.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: exportKmz }, st.parts > 1 ? `Télécharger les ${st.parts} KMZ` : 'Télécharger le KMZ (DJI Fly)'),
      h('button', { class: 'btn ghost small', onclick: exportCsv }, 'CSV des points')));
  view3d(canvas, R, B);
}

function tplCard() {
  const inp = h('input', { type: 'file', accept: '.kmz,application/vnd.google-earth.kmz,application/zip', multiple: true, hidden: true });
  const info = h('p', { class: 'small' });
  const show = () => fill(info, S.tpl.length
    ? S.tpl.map((t, i) => h('div', {}, `Partie ${i + 1} → ${t.name}.kmz · drone ${t.droneEnumValue}/${t.droneSubEnumValue}`))
    : 'Aucun modèle : fichier nommé automatiquement, drone 68/0 (valeur DJI Fly courante).');
  inp.onchange = async () => {
    S.tpl = [];
    for (const f of inp.files) { try { S.tpl.push(await readTemplate(f)); } catch (e) { toast('Modèle illisible : ' + e.message); } }
    show();
  };
  show();
  return h('section', { class: 'card' },
    h('div', { class: 'lbl' }, 'Transfert vers la RC 2'),
    h('ol', { class: 'small p3d-steps' },
      h('li', {}, 'Dans DJI Fly (RC 2) : créer une mission par points factice (2 points), l\'enregistrer, quitter DJI Fly.'),
      h('li', {}, 'Brancher la RC 2 au PC en USB (mode transfert de fichiers) : Android › data › dji.go.v5 › files › waypoint › un dossier par mission (nom = identifiant).'),
      h('li', {}, 'Copier le .kmz de la mission factice sur le PC et le charger ci-dessous : le fichier produit prendra son nom et ses réglages drone.'),
      h('li', {}, 'Remplacer le .kmz dans le dossier de la mission par celui produit ici (même nom), relancer DJI Fly, ouvrir la mission et vérifier le tracé.'),
      h('li', {}, 'Premier essai : petit bâtiment dégagé, hauteur de retour (RTH) réglée au-dessus de l\'altitude de sécurité, prêt à reprendre la main.')),
    h('div', { class: 'row' }, inp, h('button', { class: 'btn small', onclick: () => inp.click() }, 'Charger la mission factice (.kmz)…')),
    info);
}

export async function render(root) {
  const site = settings().site;
  const mapBox = h('div', { class: 'map p3d-map' });
  els.hint = h('p', { class: 'small muted' }, '');
  els.bat = h('div', {});
  els.res = h('div', {});
  fill(root,
    h('section', { class: 'card' },
      h('div', { class: 'lbl' }, 'Bâtiment (BD TOPO IGN) et point de décollage'),
      els.hint, h('div', { class: 'map-wrap' }, mapBox)),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'Bâtiment'), els.bat),
    h('section', { class: 'card' },
      h('div', { class: 'lbl' }, 'Acquisition · DJI Air 3S, caméra grand-angle 1" 50 Mpx'),
      h('div', { class: 'row' }, chk('Façades', 'facade'), chk('Orbites', 'orbite'), chk('Toiture', 'toit'), chk('Rangée haute oblique', 'rangHaute')),
      h('div', { class: 'grid2' },
        num('Résolution façades', 'gsdFacade', 0.5, 1, 20, 'mm/px'),
        num('Résolution toiture', 'gsdToit', 0.5, 2, 30, 'mm/px'),
        num('Recouvrement horizontal', 'ovH', 5, 50, 90, '%'),
        num('Recouvrement vertical', 'ovV', 5, 40, 90, '%'),
        num('Anneaux d\'orbite', 'orbiteAnneaux', 1, 1, 4, ''),
        num('Distance des orbites (0 = auto)', 'orbiteDist', 1, 0, 150, 'm'),
        num('Marge au-dessus du toit', 'marge', 1, 3, 30, 'm'),
        num('Distance mini aux bâtiments', 'distMin', 1, 5, 50, 'm'),
        num('Vitesse entre photos', 'vitesse', 0.5, 1, 10, 'm/s'),
        num('Points max par mission', 'maxParMission', 10, 20, 200, '')),
      h('p', { class: 'small muted' }, 'Arrêt à chaque point pour la photo (netteté maximale). Hauteurs relatives au décollage.')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'Plan de vol'), els.res),
    tplCard(),
    h('p', { class: 'foot' }, 'Outil d\'aide à la préparation : vérifier le tracé dans DJI Fly avant le vol, rester en vue du drone et prêt à reprendre la main. Arbres, câbles, grues et antennes ne sont pas dans la BD TOPO. Les zones de vol et autorisations restent à vérifier dans l\'onglet Zones.'));

  map = L.map(mapBox, { zoomControl: true, maxZoom: 20 }).setView([site.lat, site.lon], 17);
  const ortho = orthoLayer().addTo(map);
  L.control.layers({ 'Photo aérienne': ortho, 'Plan IGN': ignLayer() }, {}, { collapsed: true }).addTo(map);
  bLayer = L.layerGroup().addTo(map);
  pathLayer = L.layerGroup().addTo(map);
  tkMarker = null;
  map.on('moveend', loadBuildings);
  map.on('contextmenu', (e) => setTakeoff(e.latlng.lat, e.latlng.lng));
  if (S.takeoff) setTakeoff(S.takeoff.lat, S.takeoff.lon);
  setTimeout(() => map.invalidateSize(), 50);
  if (window.ResizeObserver) new ResizeObserver(() => map && map.invalidateSize()).observe(mapBox);
  if (S.sel.length) {
    const f = S.feats.get(S.sel[0]);
    if (f) map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 18, padding: [60, 60] });
  }
  loadBuildings();
  drawBuildings();
  compute();
}
