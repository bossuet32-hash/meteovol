// Onglet « Bulletin » : prévisions Météo-France (AROME/ARPEGE via Open-Meteo), créneaux volables, radar RainViewer.
import { h, fill, settings, fetchCached, dir8, hh, dateFr, jour, fmtNum, ago, pickPlace, saveSettings } from './util.js';
import { ignLayer } from './map.js';

const LVL = ['ok', 'warn', 'bad'];
const LVL_TXT = ['OK', 'LIMITE', 'NO-GO'];

export function forecastUrl(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + '&hourly=temperature_2m,dew_point_2m,apparent_temperature,precipitation,showers,weather_code,cloud_cover,cloud_cover_low,'
    + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_100m,wind_direction_100m,wind_speed_120m,wind_direction_120m,cape,visibility'
    + '&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset'
    + '&models=meteofrance_seamless&timezone=Europe%2FParis&forecast_days=4&wind_speed_unit=kmh&timeformat=unixtime';
}

export function hourVerdict(x, maxw) {
  let lvl = 0;
  const why = [];
  const add = (l, r) => { if (l > lvl) lvl = l; why.push(r); };
  const w = Math.max(x.g10 ?? x.w10 ?? 0, x.w100 ?? 0);
  if (w >= maxw) add(2, x.g10 != null && x.g10 >= (x.w100 ?? 0) ? `rafales ${Math.round(x.g10)}` : `vent 100 m ${Math.round(x.w100)}`);
  else if (w >= maxw * 0.8) add(1, `vent ${Math.round(w)}`);
  const code = x.code ?? 0;
  if (code >= 95) add(2, 'orage'); else if (code === 45 || code === 48) add(2, 'brouillard');
  const p = x.precip ?? 0, sh = x.showers ?? 0;
  if (sh >= 0.2 || p >= 0.5) add(2, sh >= 0.2 ? 'averses' : 'pluie'); else if (p >= 0.1) add(1, 'bruine');
  if (x.cape != null && x.cape >= 1000 && lvl < 2) add(1, 'instable');
  if (x.vis != null && x.vis < 1500) add(2, 'visibilité'); else if (x.vis != null && x.vis < 3000) add(1, 'visibilité');
  if (x.ceil != null && x.ceil < 150) add(2, 'plafond bas'); else if (x.ceil != null && x.ceil < 300) add(1, 'plafond bas');
  return { lvl, why };
}

export function parse(js, maxw) {
  const H = js.hourly, at = (k, i) => (H[k] && typeof H[k][i] === 'number' ? H[k][i] : null);
  const hours = H.time.map((t, i) => {
    const x = {
      t: t * 1000, temp: at('temperature_2m', i), dew: at('dew_point_2m', i), app: at('apparent_temperature', i),
      precip: at('precipitation', i), showers: at('showers', i), code: at('weather_code', i), cloud: at('cloud_cover', i), low: at('cloud_cover_low', i),
      w10: at('wind_speed_10m', i), d10: at('wind_direction_10m', i), g10: at('wind_gusts_10m', i),
      w100: at('wind_speed_100m', i) ?? at('wind_speed_120m', i), d100: at('wind_direction_100m', i) ?? at('wind_direction_120m', i),
      cape: at('cape', i), vis: at('visibility', i),
    };
    if (x.low != null && x.low >= 50 && x.temp != null && x.dew != null) x.ceil = Math.max(30, 125 * (x.temp - x.dew));
    Object.assign(x, hourVerdict(x, maxw));
    return x;
  }).filter((x) => x.temp != null || x.w10 != null);
  const D = js.daily || {};
  const days = (D.time || []).map((t, i) => ({
    t: t * 1000, tmin: D.temperature_2m_min?.[i], tmax: D.temperature_2m_max?.[i], psum: D.precipitation_sum?.[i],
    gmax: D.wind_gusts_10m_max?.[i], ddom: D.wind_direction_10m_dominant?.[i], sunrise: D.sunrise?.[i] * 1000, sunset: D.sunset?.[i] * 1000,
  }));
  return { hours, days };
}

const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
export const dayHours = (F, t, h0 = 6, h1 = 21) => F.hours.filter((x) => sameDay(x.t, t) && new Date(x.t).getHours() >= h0 && new Date(x.t).getHours() <= h1);

export function windows(hours) {
  const out = []; let s = null;
  hours.forEach((x, i) => {
    const good = x.lvl === 0;
    if (good && s == null) s = x.t;
    if ((!good || i === hours.length - 1) && s != null) {
      const e = good ? x.t + 3600e3 : x.t;
      if (e - s >= 2 * 3600e3) out.push({ s, e });
      s = null;
    }
  });
  return out;
}

function dominant(hours) {
  let sx = 0, sy = 0, n = 0;
  for (const x of hours) if (x.d10 != null && x.w10 != null) { sx += x.w10 * Math.sin((x.d10 * Math.PI) / 180); sy += x.w10 * Math.cos((x.d10 * Math.PI) / 180); n++; }
  return n ? ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360 : null;
}

const WMO = { 0: 'ciel clair', 1: 'peu nuageux', 2: 'nuageux', 3: 'couvert', 45: 'brouillard', 48: 'brouillard givrant', 51: 'bruine', 53: 'bruine', 55: 'bruine forte', 61: 'pluie faible', 63: 'pluie', 65: 'pluie forte', 80: 'averses', 81: 'averses', 82: 'averses fortes', 95: 'orage', 96: 'orage grêle', 99: 'orage grêle' };
const ICON = (c) => (c >= 95 ? '⛈' : c >= 80 ? '🌦' : c >= 61 ? '🌧' : c >= 51 ? '🌦' : c >= 45 ? '🌫' : c === 3 ? '☁️' : c === 2 ? '⛅' : c === 1 ? '🌤' : '☀️');

export function summary(F, t, maxw) {
  const hs = dayHours(F, t);
  if (!hs.length) return null;
  const gmax = Math.max(...hs.map((x) => x.g10 ?? 0)), w100 = Math.max(...hs.map((x) => x.w100 ?? 0));
  const tmin = Math.min(...hs.map((x) => x.temp ?? 99)), tmax = Math.max(...hs.map((x) => x.temp ?? -99));
  const rain = hs.reduce((a, x) => a + (x.precip ?? 0), 0);
  const nOk = hs.filter((x) => x.lvl === 0).length;
  return { hs, gmax, w100, tmin, tmax, rain, dom: dominant(hs), win: windows(hs), nOk, lvl: nOk >= 4 ? (hs.some((x) => x.lvl === 2) ? 1 : 0) : 2 };
}

function hourStrip(hs) {
  return h('div', { class: 'hours' }, ...hs.map((x) => h('div', { class: `hr ${LVL[x.lvl]}`, title: x.why.join(', ') },
    h('div', { class: 'hr-h' }, new Date(x.t).getHours() + 'h'),
    h('div', { class: 'hr-i' }, ICON(x.code ?? 0)),
    h('div', { class: 'hr-t' }, x.temp != null ? Math.round(x.temp) + '°' : ''),
    h('div', { class: 'hr-w' }, h('span', { class: 'arrow s', style: `transform:rotate(${((x.d10 ?? 0) + 180) % 360}deg)` }, '↑'), Math.round(x.w10 ?? 0)),
    h('div', { class: 'hr-g' }, Math.round(x.g10 ?? 0)),
    h('div', { class: 'hr-p' }, x.precip ? fmtNum(x.precip) : ''))));
}

// ---------------------------------------------------------------- radar
let radarMap = null, radarTimer = null;
async function radar(el, site) {
  if (radarTimer) { clearInterval(radarTimer); radarTimer = null; }
  if (radarMap) { radarMap.remove(); radarMap = null; }
  const box = h('div', { class: 'map radar-map' });
  const lab = h('div', { class: 'radar-lab' }, 'Radar…');
  const play = h('button', { class: 'btn small' }, 'Pause');
  fill(el, h('div', { class: 'map-wrap' }, box, lab), h('div', { class: 'row' }, play, h('span', { class: 'small muted' }, 'Précipitations des 2 dernières heures (RainViewer), animation 10 min')));
  radarMap = L.map(box, { zoomControl: true, attributionControl: true, maxZoom: 11, minZoom: 5 }).setView([site.lat, site.lon], 8);
  ignLayer().addTo(radarMap);
  L.circleMarker([site.lat, site.lon], { radius: 6, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(radarMap);
  let rv;
  try { rv = (await fetchCached('https://api.rainviewer.com/public/weather-maps.json')).data; } catch { lab.textContent = 'Radar indisponible (pas de réseau)'; return; }
  const frames = (rv.radar?.past || []).slice(-12);
  const layers = frames.map((f) => L.tileLayer(`${rv.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 11, zIndex: 10, attribution: 'RainViewer' }).addTo(radarMap));
  let k = layers.length - 1, on = true;
  const show = () => { layers.forEach((l, i) => l.setOpacity(i === k ? 0.75 : 0)); if (frames[k]) lab.textContent = `${hh(frames[k].time * 1000)}${String(new Date(frames[k].time * 1000).getMinutes()).padStart(2, '0')} (${ago(frames[k].time * 1000)})`; };
  show();
  radarTimer = setInterval(() => { if (!on || !layers.length) return; k = (k + 1) % layers.length; show(); }, 700);
  play.onclick = () => { on = !on; play.textContent = on ? 'Pause' : 'Lecture'; };
}

// ---------------------------------------------------------------- rendu
export async function render(root) {
  const S = settings();
  const site = S.site;
  fill(root, h('p', { class: 'muted' }, 'Chargement des prévisions…'));
  let res;
  try { res = await fetchCached(forecastUrl(site.lat, site.lon)); } catch (e) { fill(root, h('p', { class: 'warn-txt' }, 'Prévisions indisponibles : ' + e.message)); return; }
  const F = parse(res.data, S.maxWind);
  const now = new Date();
  const day0 = now.getHours() >= 19 ? Date.now() + 86400e3 : Date.now();
  const S0 = summary(F, day0, S.maxWind);
  const radarBox = h('div', {});
  fill(root, 
    h('section', { class: 'card' },
      h('div', { class: 'sum-row' },
        h('div', {}, h('div', { class: 'lbl' }, (sameDay(day0, Date.now()) ? "Aujourd'hui" : 'Demain') + ' · ' + dateFr(day0)),
          h('div', { class: 'small muted' }, `${site.name} · AROME 1,3 km puis ARPEGE (Météo-France) · ${res.live ? 'mis à jour ' + ago(res.t) : 'hors ligne, ' + ago(res.t)}`)),
        h('button', { class: 'btn small', onclick: async () => { const p = await pickPlace('Lieu du bulletin'); if (p) { saveSettings({ site: p }); render(root); } } }, 'Lieu…')),
      S0 ? h('div', {},
        h('div', { class: 'grid4' },
          h('div', {}, h('div', { class: 'lbl' }, 'Temp.'), h('b', {}, `${Math.round(S0.tmin)}° / ${Math.round(S0.tmax)}°`)),
          h('div', {}, h('div', { class: 'lbl' }, 'Vent dominant'), h('b', {}, S0.dom != null ? dir8(S0.dom) : '—')),
          h('div', {}, h('div', { class: 'lbl' }, 'Rafales max'), h('b', {}, Math.round(S0.gmax) + ' km/h')),
          h('div', {}, h('div', { class: 'lbl' }, 'Pluie'), h('b', {}, fmtNum(S0.rain) + ' mm'))),
        h('p', { class: `why ${LVL[S0.lvl]}` }, S0.win.length ? 'Créneaux favorables : ' + S0.win.map((w) => `${hh(w.s)}–${hh(w.e)}`).join(', ') : 'Pas de créneau favorable de 2 h (6h–21h)'),
        h('div', { class: 'lbl' }, 'Heure par heure : ciel, T°, vent moyen (km/h), rafales, pluie (mm)'),
        hourStrip(S0.hs),
        h('p', { class: 'small muted' }, `Vent à 100 m jusqu'à ${Math.round(S0.w100)} km/h · seuil machine ${S.maxWind} km/h`)) : h('p', {}, 'Pas de données pour cette journée.')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'Radar de précipitations'), radarBox),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, '4 jours'),
      h('div', { class: 'days' }, ...F.days.map((d) => {
        const s = summary(F, d.t, S.maxWind);
        return h('div', { class: `day ${s ? LVL[s.lvl] : 'na'}` },
          h('div', { class: 'day-h' }, jour(d.t) + ' ' + new Date(d.t).getDate()),
          h('div', {}, `${Math.round(d.tmin ?? 0)}° / ${Math.round(d.tmax ?? 0)}°`),
          h('div', { class: 'small' }, `raf. ${Math.round(d.gmax ?? 0)} ${d.ddom != null ? dir8(d.ddom) : ''}`),
          h('div', { class: 'small' }, `${fmtNum(d.psum ?? 0)} mm`),
          h('div', { class: 'small' }, s && s.win.length ? s.win.map((w) => `${hh(w.s)}–${hh(w.e)}`).join(' ') : 'pas de créneau'));
      }))),
    h('p', { class: 'foot' }, 'Sources : Open-Meteo (modèles Météo-France), RainViewer. Données indicatives : compléter par les sources officielles.'));
  radar(radarBox, site);
  return { F, site, maxWind: S.maxWind, day0, S0 };
}

export { WMO, ICON, LVL_TXT };
