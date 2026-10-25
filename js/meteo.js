// Onglet « Météo vol » : METAR / TAF des aérodromes (met.no), verdict drone, vent sur piste, soleil, Kp.
import * as M from './metar.js';
import { h, fill, settings, fetchCached, distKm, bearing, dir8, hhmm, hh, jour, ago, fmtNum } from './util.js';

let AD = null;
export async function aerodromes() {
  if (!AD) AD = await (await fetch('data/aerodromes.json')).json();
  return AD;
}

const MET = 'https://api.met.no/weatherapi/tafmetar/1.0/';

async function fetchStation(icao) {
  const [m, t] = await Promise.allSettled([
    fetchCached(`${MET}metar.txt?icao=${icao}`, { as: 'text' }),
    fetchCached(`${MET}taf.txt?icao=${icao}`, { as: 'text' }),
  ]);
  const out = { icao };
  if (m.status === 'fulfilled') {
    const raw = M.lastMessage(m.value.data);
    if (raw) { out.metar = M.parseMetar(raw); out.obs = M.obsTime(out.metar); out.live = m.value.live; out.fetched = m.value.t; }
  }
  if (t.status === 'fulfilled') {
    const raw = M.lastMessage(t.value.data);
    if (raw) out.taf = M.parseTaf(raw);
  }
  // secours : fichier mis à jour par le dépôt GitHub (aviationweather.gov), pour les terrains absents de met.no
  if (!out.metar) {
    try {
      const fb = (await fetchCached('data/metar_fr.json')).data;
      const s = fb && fb.stations && fb.stations[icao];
      if (s && s.metar) { out.metar = M.parseMetar(s.metar); out.obs = M.obsTime(out.metar); out.fallback = true; }
      if (s && s.taf && !out.taf) out.taf = M.parseTaf(s.taf);
    } catch { /* pas de secours */ }
  }
  return out;
}

// Stations à afficher : réglage manuel, sinon les plus proches qui publient un METAR
export async function pickStations(site, n = 4) {
  const ad = await aerodromes();
  const S = settings();
  if (S.stations && S.stations.length) {
    return Promise.all(S.stations.map(async (id) => ({ ...(ad.find((a) => a.icao === id) || { icao: id, name: id }), ...(await fetchStation(id)) })));
  }
  const cands = ad.filter((a) => a.type >= 2).map((a) => ({ ...a, d: distKm(site.lat, site.lon, a.lat, a.lon) }))
    .sort((a, b) => a.d - b.d).slice(0, 10);
  const res = await Promise.all(cands.map(async (a) => ({ ...a, ...(await fetchStation(a.icao)) })));
  return res.filter((r) => r.metar).slice(0, n);
}

const LVL_CLASS = ['ok', 'warn', 'bad'];
const badge = (lvl, txt) => h('span', { class: `badge ${lvl == null ? 'na' : LVL_CLASS[lvl]}` }, txt ?? (lvl == null ? '—' : M.LVL_TXT[lvl]));

function windArrow(dir) {
  if (typeof dir !== 'number') return h('span', { class: 'arrow vrb' }, 'VRB');
  // flèche dans le sens où va le vent (vent du 330° -> pointe vers 150°)
  return h('span', { class: 'arrow', style: `transform:rotate(${(dir + 180) % 360}deg)`, 'aria-label': `vent du ${dir}°` }, '↑');
}

function cloudsTxt(c) {
  if (c.cavok) return 'CAVOK';
  if (!c.clouds.length) return 'pas de nuages significatifs';
  const FR = { FEW: 'peu', SCT: 'épars', BKN: 'fragmenté', OVC: 'couvert', VV: 'ciel invisible' };
  return c.clouds.map((x) => `${FR[x.cover] || x.cover} ${x.base != null ? x.base + ' ft' : ''}${x.type ? ' ' + x.type : ''}`).join(' · ');
}

function timeline(sl) {
  if (!sl) return h('p', { class: 'muted' }, 'Pas de TAF pour ce terrain.');
  const bar = h('div', { class: 'tl' });
  sl.forEach((s, i) => {
    const cls = s.lvl == null ? 'na' : LVL_CLASS[s.lvl] + (s.risk ? ' risk' : '');
    bar.append(h('div', { class: `tl-c ${cls}`, title: `${hh(s.t)} : ${s.lvl == null ? 'hors TAF' : M.LVL_TXT[s.lvl]}${s.why && s.why.length ? ' — ' + s.why.join(', ') : ''}${s.risk_txt ? ' — risque ' + s.risk_txt : ''}` },
      i % 3 === 0 ? h('span', {}, new Date(s.t).getHours()) : null));
  });
  return bar;
}

function stationCard(st, maxw, siteLat, siteLon) {
  const c = st.metar;
  const v = M.verdict(c, maxw);
  const sp = M.kmh(c.wspd || 0), gu = c.wgst != null ? M.kmh(c.wgst) : null;
  const rw = (st.rwy || []).length ? M.runwayWind(st.rwy[0].h, c.wdir, sp, gu) : null;
  const age = st.obs ? Math.round((Date.now() - st.obs) / 60000) : null;
  const sl = st.taf ? M.slots(st.taf, maxw, 24) : null;
  const win = M.windows(sl);
  const ce = M.ceiling(c.clouds);
  const det = h('details', { class: 'raw' }, h('summary', {}, 'Messages bruts et détail du TAF'),
    h('code', {}, c.raw), st.taf ? h('code', {}, st.taf.raw) : null,
    st.taf ? h('ul', { class: 'periods' }, ...M.tafPeriods(st.taf, maxw).map((p) =>
      h('li', {}, badge(p.lvl), ` ${p.lab} ${jour(p.from)} ${hhmm(p.from)} → ${p.to ? jour(p.to) + ' ' + hhmm(p.to) : ''} : ${p.txt}`))) : null);
  return h('article', { class: `card st ${LVL_CLASS[v.lvl]}` },
    h('header', { class: 'st-head' },
      h('div', {}, h('div', { class: 'st-id' }, st.icao, h('small', {}, ' ' + (st.name || '').replace(/ Airport$/, ''))),
        h('div', { class: 'muted small' }, st.d != null ? `${fmtNum(st.d)} km ${dir8(bearing(siteLat, siteLon, st.lat, st.lon))} · ` : '',
          age != null ? `observé ${age < 90 ? 'il y a ' + age + ' min' : ago(st.obs)}` : '', st.live === false ? ' · hors ligne' : '', st.fallback ? ' · source secours' : '')),
      badge(v.lvl)),
    age != null && age > 90 ? h('p', { class: 'warn-txt' }, 'METAR ancien : le terrain ne publie peut-être pas en ce moment.') : null,
    h('div', { class: 'grid4' },
      h('div', { class: 'big' }, windArrow(c.wdir), h('div', {}, h('b', {}, `${sp}${gu ? '–' + gu : ''}`), ' km/h', h('div', { class: 'muted small' }, typeof c.wdir === 'number' ? `du ${String(c.wdir).padStart(3, '0')}° (${dir8(c.wdir)})` : 'variable', c.wvar ? ' ' + c.wvar : ''))),
      h('div', {}, h('div', { class: 'lbl' }, 'Visibilité'), h('b', {}, c.visib >= 10000 ? '> 10 km' : c.visib != null ? fmtNum(c.visib / 1000) + ' km' : '—')),
      h('div', {}, h('div', { class: 'lbl' }, 'Plafond'), h('b', {}, ce != null ? ce + ' ft' : 'dégagé')),
      h('div', {}, h('div', { class: 'lbl' }, 'T° / rosée'), h('b', {}, c.temp != null ? `${c.temp}° / ${c.dew ?? '—'}°` : '—'))),
    h('p', { class: 'small' }, cloudsTxt(c), M.wxFr(c.wxString) ? ' · ' + M.wxFr(c.wxString) : '', c.qnh ? ` · QNH ${c.qnh}` : '', c.trend ? ` · tendance ${c.trend}` : ''),
    v.why.length ? h('p', { class: 'why' }, 'Limitant : ' + v.why.join(', ')) : null,
    rw ? h('p', { class: 'small' }, `Piste ${rw.rwy} : face ${rw.head} km/h, travers ${rw.cross} km/h ${rw.side}${rw.gcross ? ` (rafales ${rw.gcross})` : ''}`) : null,
    h('div', { class: 'lbl' }, 'Prévision TAF heure par heure (heure locale)'),
    timeline(sl),
    sl ? h('p', { class: 'small' }, win.length ? 'Créneaux favorables ≥ 2 h : ' + win.map((w) => `${jour(w.s)} ${hh(w.s)}–${hh(w.e)}`).join(', ') : 'Aucun créneau favorable de 2 h dans les 24 h.') : null,
    det);
}

export async function render(root) {
  const S = settings();
  const site = S.site;
  fill(root, h('p', { class: 'muted' }, 'Chargement des METAR / TAF…'));
  let sts;
  try { sts = await pickStations(site); } catch (e) { fill(root, h('p', { class: 'warn-txt' }, 'Données indisponibles : ' + e.message)); return; }
  const sun = M.sun(site.lat, site.lon);
  let kp = null;
  try {
    const k = (await fetchCached('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')).data;
    const last = Array.isArray(k) ? k[k.length - 1] : null;
    kp = last ? (typeof last === 'object' && !Array.isArray(last) ? +last.Kp : +last[1]) : null;
  } catch { /* Kp facultatif */ }
  const best = sts.length ? Math.min(...sts.map((s) => M.verdict(s.metar, S.maxWind).lvl)) : null;
  const worst = sts.length ? Math.max(...sts.map((s) => M.verdict(s.metar, S.maxWind).lvl)) : null;
  fill(root, 
    h('section', { class: 'card summary' },
      h('div', { class: 'sum-row' },
        h('div', {}, h('div', { class: 'lbl' }, 'Synthèse autour de ' + site.name), h('div', { class: 'small muted' }, `vent max machine ${S.maxWind} km/h · ${sts.length} terrain(s)`)),
        badge(worst, worst == null ? 'SANS DONNÉES' : best !== worst ? `${M.LVL_TXT[best]} → ${M.LVL_TXT[worst]}` : M.LVL_TXT[worst])),
      h('div', { class: 'grid3 small' },
        h('div', {}, h('div', { class: 'lbl' }, 'Lever'), h('b', {}, sun.rise ? hhmm(sun.rise) : '—')),
        h('div', {}, h('div', { class: 'lbl' }, 'Coucher'), h('b', {}, sun.set ? hhmm(sun.set) : '—')),
        h('div', {}, h('div', { class: 'lbl' }, 'Indice Kp'), h('b', {}, kp != null ? fmtNum(kp) : '—'))),
      kp != null ? h('p', { class: 'small muted' }, 'GNSS : ' + M.kpNote(kp)) : null),
    ...(sts.length ? sts.map((s) => stationCard(s, S.maxWind, site.lat, site.lon)) : [h('p', { class: 'warn-txt' }, 'Aucun METAR trouvé près de ce lieu.')]),
    h('p', { class: 'foot' }, 'Sources : METAR/TAF via api.met.no (Institut météorologique norvégien), Kp NOAA SWPC. Vérifier avec AéroWeb / SOFIA avant le vol.'));
  return { sts, sun, kp, site, maxWind: S.maxWind };
}
