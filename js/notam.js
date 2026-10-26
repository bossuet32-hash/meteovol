// NOTAM utiles aux drones autour du point de vol (liste publiée par le dépôt, source FAA NMS, mise à jour horaire).
import { fetchCached } from './util.js';
import { proj, geomDist } from './zones.js';

const NM = 1852;
const KIND = {
  QRT: ['Zone réglementée temporaire (ZRT)', 3], QRR: ['Zone réglementée activée', 3], QRD: ['Zone dangereuse activée', 3],
  QRP: ['Zone interdite', 3], QRA: ['Réservation d\'espace', 3], QRM: ['Zone d\'opérations militaires', 3], QRO: ['Survol interdit', 3],
  QWU: ['Activité drones', 2], QWZ: ['Aéromodélisme', 2], QWP: ['Parachutage / parapente', 2], QWB: ['Voltige', 2],
  QWE: ['Exercice', 2], QWG: ['Vol à voile / treuillage', 2], QWM: ['Tirs', 3], QWA: ['Meeting aérien', 3], QWC: ['Ballon captif / cerf-volant', 2],
  QWL: ['Lâcher de ballon', 2], QWH: ['Tirs de mines', 2], QWT: ['Trafic aérien intense', 2], QWY: ['Prise de vues aériennes', 1],
  QWO: ['Activité aérienne', 1], QOB: ['Obstacle (grue…)', 1],
};
export function kind(q) {
  const k = KIND[(q || '').slice(0, 3)];
  return k ? { label: k[0], sev: k[1] } : { label: 'Avertissement', sev: 1 };
}

let cache = null;
export async function loadNotams() {
  if (!cache) cache = fetchCached('data/notam_fr.json', { timeout: 20000 }).then((r) => ({ ...r.data, live: r.live, t: r.t })).catch(() => null);
  return cache;
}

const tparse = (s) => (!s || s === 'PERM' ? null : Date.parse(s));

// NOTAM actifs sur [start, end] à moins de `radius` m du point (zone du NOTAM comprise)
export function nearby(data, lat, lon, radius, start = Date.now(), end = Date.now() + 48 * 3600e3) {
  if (!data || !Array.isArray(data.notams)) return [];
  const P = proj(lat, lon);
  const out = [];
  for (const n of data.notams) {
    const f = tparse(n.from), t = tparse(n.to);
    if (f && f > end) continue;
    if (t && t < start) continue;
    let d, area;
    if (n.poly) { area = { t: 'P', rings: [n.poly] }; [d] = geomDist(area, P); }
    else {
      const r = n.q && n.q.startsWith('QOB') ? 0 : Math.min(n.r || 1, 10) * NM;   // obstacles : le point lui-même
      area = { t: 'C', c: [n.lon, n.lat], r: Math.max(r, 1) };
      [d] = geomDist(area, P);
    }
    if (d > radius) continue;
    const [x, y] = P(n.lon, n.lat);
    const k = kind(n.q);
    const h = (n.text || '').match(/(?:HEIGHT|HGT)\s*:?\s*(\d+)\s*FT/i);
    out.push({ ...n, dist: d, inside: d === 0, area, kind: k.label, sev: k.sev, heightFt: h ? +h[1] : null, perm: n.to === 'PERM',
      dir: ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.floor((((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 + 22.5) / 45) % 8] });
  }
  out.sort((a, b) => (a.inside !== b.inside ? (a.inside ? -1 : 1) : b.sev - a.sev || a.dist - b.dist));
  return out;
}

const fr = (s) => { if (!s) return ''; const d = new Date(s); return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }); };
export function period(n) {
  return `${n.from ? 'du ' + fr(n.from) : ''}${n.perm ? ' · permanent' : n.to ? ' au ' + fr(n.to) : ''}${n.sched ? ' · horaires ' + n.sched + ' UTC' : ''}`;
}
export function limits(n) {
  if (n.heightFt) return `hauteur ${n.heightFt} ft (${Math.round(n.heightFt * 0.3048)} m)`;
  if (n.lo || n.up) return `${n.lo || '?'} → ${n.up || '?'}`;
  return '';
}
