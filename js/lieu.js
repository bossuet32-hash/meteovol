// Onglet « Lieu » : choix du point de vol (recherche, GPS, carte, lieux récents, missions), utilisé par tous les onglets,
// et résumé de la situation au point (météo, bulletin, zones).
import { h, fill, settings, setSite, locate, gps, toL93, fetchCached, dbAll, fmtNum, hh, toast } from './util.js';
import { ignLayer, orthoLayer, limitesLayer } from './map.js';
import * as M from './metar.js';
import { pickStations } from './meteo.js';
import * as B from './bulletin.js';
import * as Z from './zones.js';

let map = null;
const go = (tab) => window.dispatchEvent(new CustomEvent('mv-go', { detail: tab }));
const LV = ['ok', 'warn', 'bad'];

async function reverse(lat, lon) {
  try {
    const js = (await fetchCached(`https://data.geopf.fr/geocodage/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&limit=1`)).data;
    const p = js.features?.[0]?.properties;
    return p ? `${p.city || p.name}${p.postcode ? ' (' + p.postcode.slice(0, 2) + ')' : ''}` : null;
  } catch { return null; }
}

function card(tab, title) {
  const body = h('div', { class: 'small muted' }, 'Calcul…');
  const badge = h('span', { class: 'badge na' }, '…');
  const el = h('button', { class: 'card sumcard', onclick: () => go(tab) },
    h('div', { class: 'sum-row' }, h('div', { class: 'lbl' }, title), badge), body, h('div', { class: 'zgo small' }, 'Ouvrir ›'));
  return { el, set(cls, lab, ...txt) { badge.className = `badge ${cls}`; badge.textContent = lab; fill(body, ...txt); body.classList.remove('muted'); } };
}

async function summaries(site, cards) {
  const S = settings();
  // zones (hors ligne, rapide)
  (async () => {
    try {
      const { zones } = await Z.loadZones(site.lat, site.lon, (S.radiusKm || 10) * 1000);
      let ground = null;
      try { ground = (await fetchCached(`https://api.open-meteo.com/v1/elevation?latitude=${site.lat.toFixed(5)}&longitude=${site.lon.toFixed(5)}`)).data.elevation[0]; } catch { /* */ }
      const an = Z.analyse(zones, site.lat, site.lon, (S.radiusKm || 10) * 1000, ground);
      const BI = Z.bannerInfo({ verdict: an.V });
      const near = an.list.filter((e) => !e.inside && !e.above120).length;
      cards.zones.set(BI.cls, BI.lab, h('b', {}, BI.l1), h('div', {}, BI.l2), h('div', { class: 'muted' }, `${near} autre(s) zone(s) dans ${S.radiusKm || 10} km`));
    } catch (e) { cards.zones.set('na', '—', 'Zones indisponibles : ' + e.message); }
  })();
  // METAR
  (async () => {
    try {
      const sts = await pickStations(site, 2);
      if (!sts.length) return cards.meteo.set('na', '—', 'Aucun METAR à proximité.');
      const st = sts[0], c = st.metar, v = M.verdict(c, S.maxWind);
      const sp = M.kmh(c.wspd || 0), gu = c.wgst != null ? M.kmh(c.wgst) : null;
      const sl = st.taf ? M.slots(st.taf, S.maxWind, 24) : null;
      const win = M.windows(sl);
      cards.meteo.set(LV[v.lvl], M.LVL_TXT[v.lvl], h('b', {}, `${st.icao} à ${fmtNum(st.d)} km : vent ${sp}${gu ? '–' + gu : ''} km/h`),
        h('div', {}, v.why.length ? 'Limitant : ' + v.why.join(', ') : `visi ${c.visib >= 10000 ? '> 10 km' : fmtNum((c.visib || 0) / 1000) + ' km'}, plafond ${M.ceiling(c.clouds) ?? 'dégagé'}${M.ceiling(c.clouds) != null ? ' ft' : ''}`),
        sl ? h('div', { class: 'muted' }, win.length ? 'TAF favorable : ' + win.slice(0, 2).map((w) => `${hh(w.s)}–${hh(w.e)}`).join(', ') : 'Pas de créneau TAF de 2 h') : null);
    } catch (e) { cards.meteo.set('na', '—', 'METAR indisponibles : ' + e.message); }
  })();
  // bulletin
  (async () => {
    try {
      const F = B.parse((await fetchCached(B.forecastUrl(site.lat, site.lon))).data, S.maxWind);
      const day0 = new Date().getHours() >= 19 ? Date.now() + 86400e3 : Date.now();
      const s = B.summary(F, day0, S.maxWind);
      if (!s) return cards.bulletin.set('na', '—', 'Pas de prévision.');
      cards.bulletin.set(LV[s.lvl], ['FAVORABLE', 'MITIGÉ', 'DÉFAVORABLE'][s.lvl],
        h('b', {}, `${new Date(day0).getDate() === new Date().getDate() ? "Aujourd'hui" : 'Demain'} : ${Math.round(s.tmin)}°/${Math.round(s.tmax)}°, rafales ${Math.round(s.gmax)} km/h`),
        h('div', {}, s.win.length ? 'Créneaux : ' + s.win.map((w) => `${hh(w.s)}–${hh(w.e)}`).join(', ') : 'Pas de créneau favorable de 2 h'),
        h('div', { class: 'muted' }, `pluie ${fmtNum(s.rain)} mm · vent 100 m ${Math.round(s.w100)} km/h`));
    } catch (e) { cards.bulletin.set('na', '—', 'Prévisions indisponibles : ' + e.message); }
  })();
}

export async function render(root) {
  const S = settings();
  const site = S.site;
  const l93 = toL93(site.lat, site.lon);
  const results = h('div', { class: 'pick-list' });
  const input = h('input', { type: 'search', placeholder: 'Ville, adresse, lieu-dit ou « 43.488, 1.330 »', autocomplete: 'off', enterkeyhint: 'search' });
  const choose = (p) => { setSite(p); toast('Lieu de vol : ' + p.name); render(root); };
  const search = async () => {
    if (!input.value.trim()) return;
    fill(results, h('p', { class: 'muted small' }, 'Recherche…'));
    try {
      const it = await locate(input.value.trim());
      fill(results, ...(it.length ? it.map((p) => h('button', { class: 'pick-item', onclick: () => choose(p) }, p.name)) : [h('p', { class: 'muted small' }, 'Aucun résultat')]));
    } catch { fill(results, h('p', { class: 'muted small' }, 'Recherche impossible (pas de réseau ?)')); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const missions = (await dbAll('missions').catch(() => [])).filter((m) => m.site).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);
  const recent = (S.recent || []).filter((r) => Math.abs(r.lat - site.lat) > 1e-4 || Math.abs(r.lon - site.lon) > 1e-4);
  const where = h('div', { class: 'small muted' }, '');
  const mapBox = h('div', { class: 'map lieu-map' });
  const moved = h('div', { class: 'row', hidden: true });
  const cards = { meteo: card('meteo', 'Météo aéronautique'), bulletin: card('bulletin', 'Bulletin'), zones: card('zones', 'Zones de vol') };
  fill(root,
    h('section', { class: 'card' },
      h('div', { class: 'lbl' }, 'Point de vol (utilisé par tous les onglets)'),
      h('div', { class: 'site-name' }, site.name),
      h('div', { class: 'small muted' }, `${site.lat.toFixed(5)}, ${site.lon.toFixed(5)} · Lambert-93 ${Math.round(l93.E)} / ${Math.round(l93.N)}`),
      where,
      h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: search }, 'Chercher')),
      h('button', { class: 'btn wide', onclick: async (ev) => {
        ev.target.disabled = true; ev.target.textContent = 'Lecture du GPS…';
        try { const p = await gps(); const name = (await reverse(p.lat, p.lon)) || 'Position GPS'; choose({ name: `${name} · GPS ±${Math.round(p.acc)} m`, lat: p.lat, lon: p.lon }); }
        catch (e) { toast(e.message); ev.target.disabled = false; ev.target.textContent = '📍 Ma position (GPS)'; }
      } }, '📍 Ma position (GPS)'),
      results,
      recent.length ? h('div', {}, h('div', { class: 'lbl' }, 'Lieux récents'), ...recent.map((r) => h('button', { class: 'chip', onclick: () => choose(r) }, r.name))) : null,
      missions.length ? h('div', {}, h('div', { class: 'lbl' }, 'Lieux des missions'), ...missions.map((m) => h('button', { class: 'chip', onclick: () => choose({ ...m.site, name: m.name + ' · ' + m.site.name }) }, m.name))) : null),
    h('div', { class: 'map-wrap' }, mapBox),
    moved,
    h('p', { class: 'small muted' }, 'Touchez la carte ou déplacez le repère pour affiner le point, puis validez.'),
    h('div', { class: 'lbl' }, 'Situation au point'),
    cards.meteo.el, cards.bulletin.el, cards.zones.el);
  // carte
  if (map) { map.remove(); map = null; }
  map = L.map(mapBox, { zoomControl: true }).setView([site.lat, site.lon], 13);
  const plan = ignLayer().addTo(map);
  L.control.layers({ 'Plan IGN': plan, 'Photo aérienne': orthoLayer() }, { 'Limites communales': limitesLayer().addTo(map) }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const mk = L.marker([site.lat, site.lon], { draggable: true, icon: L.divIcon({ className: 'site-ic', iconSize: [28, 28] }) }).addTo(map);
  const propose = async (ll) => {
    mk.setLatLng(ll);
    moved.hidden = false;
    fill(moved, h('span', { class: 'small' }, `Nouveau point ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`),
      h('button', { class: 'btn small', onclick: async () => { const name = (await reverse(ll.lat, ll.lng)) || 'Point'; choose({ name: `${name} · ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`, lat: ll.lat, lon: ll.lng }); } }, 'Valider ce point'),
      h('button', { class: 'btn small ghost', onclick: () => { mk.setLatLng([site.lat, site.lon]); moved.hidden = true; } }, 'Annuler'));
  };
  mk.on('dragend', () => propose(mk.getLatLng()));
  map.on('click', (e) => propose(e.latlng));
  if (window.ResizeObserver) new ResizeObserver(() => map && map.invalidateSize()).observe(mapBox);
  reverse(site.lat, site.lon).then((c) => { if (c) where.textContent = 'Commune : ' + c; });
  summaries(site, cards);
}
