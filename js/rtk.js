// Onglet « RTK » : bases du réseau Centipède les plus proches du point de vol, carte et réglages NTRIP.
import { h, fill, settings, fetchCached, distKm, bearing, dir8, fmtNum, ago, toast } from './util.js';
import { ignLayer, orthoLayer } from './map.js';

let map = null, hl = null;
const CASTER = { host: 'crtk.net', port: 2101, user: 'centipede', pass: 'centipede' };

function quality(d) {
  if (d <= 20) return ['ok', 'idéale'];
  if (d <= 35) return ['ok', 'bonne'];
  if (d <= 50) return ['warn', 'limite'];
  return ['bad', 'trop loin'];
}

async function copy(txt) {
  try { await navigator.clipboard.writeText(txt); toast('Copié : ' + txt); } catch { toast(txt); }
}

export async function render(root) {
  const S = settings();
  const site = S.site;
  fill(root, h('p', { class: 'muted' }, 'Chargement des bases Centipède…'));
  let res;
  try { res = await fetchCached('data/centipede.json'); } catch (e) { fill(root, h('p', { class: 'warn-txt' }, 'Liste des bases indisponible : ' + e.message)); return; }
  const all = res.data.bases.map((b) => ({ ...b, d: distKm(site.lat, site.lon, b.lat, b.lon), dir: dir8(bearing(site.lat, site.lon, b.lat, b.lon)) }));
  const near = all.filter((b) => b.d <= 80).sort((a, b) => a.d - b.d);
  const act = near.filter((b) => b.on);
  const best = act[0];
  const mapBox = h('div', { class: 'map rtk-map' });
  const rows = new Map();
  const focus = (b) => {
    if (!map) return;
    if (hl) hl.remove();
    hl = L.layerGroup([L.polyline([[site.lat, site.lon], [b.lat, b.lon]], { color: '#000', weight: 2.5, dashArray: '6 5', interactive: false }),
      L.circleMarker([b.lat, b.lon], { radius: 13, color: '#000', weight: 3, fill: false, interactive: false })]).addTo(map);
    map.fitBounds(L.latLngBounds([[site.lat, site.lon], [b.lat, b.lon]]).pad(0.3), { maxZoom: 12 });
    mapBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const row = (b) => {
    const [cls, q] = quality(b.d);
    const r = h('div', { class: 'zrow click', onclick: () => focus(b) },
      h('div', { class: 'zd' }, h('b', {}, fmtNum(b.d) + ' km'), h('div', { class: 'small muted' }, b.dir)),
      h('div', { class: 'zn' }, h('b', {}, b.mp), ' ', h('span', { class: `badge ${b.on ? cls : 'na'} sm` }, b.on ? q : 'éteinte')),
      h('div', { class: 'zc small' }, [b.rx, b.gnss].filter(Boolean).join(' · '), h('div', { class: 'muted' }, `${b.alt != null ? 'alt. ' + fmtNum(b.alt, 1) + ' m · ' : ''}${b.chk ? 'vérifiée ' + ago(b.chk * 1000) : ''}`)),
      h('div', { class: 'zgo small' }, h('button', { class: 'linklike', onclick: (e) => { e.stopPropagation(); copy(b.mp); } }, 'Copier le point de montage'), ' · Voir sur la carte ›'));
    rows.set(b.mp, r);
    return r;
  };
  fill(root,
    h('section', { class: `banner ${best ? quality(best.d)[0] : 'bad'}` },
      h('div', { class: 'ban-lab' }, best ? best.mp : 'AUCUNE'),
      h('div', { class: 'ban-txt' }, best ? h('b', {}, `Base active la plus proche : ${fmtNum(best.d)} km ${best.dir}`) : h('b', {}, 'Aucune base active à moins de 80 km'),
        h('div', { class: 'small' }, best ? `Ligne de base ${quality(best.d)[1]} · précision attendue ≈ 1 cm + 1 mm/km (${fmtNum(10 + best.d, 0)} mm environ)` : 'Prévoir une base locale (UM980 en base fixe) ou un post-traitement'))),
    h('section', { class: 'card' },
      h('div', { class: 'lbl' }, 'Réglages NTRIP (rover, logiciel de levé)'),
      h('div', { class: 'grid2 small' },
        h('div', {}, h('div', { class: 'lbl' }, 'Caster'), h('b', {}, `${CASTER.host}:${CASTER.port}`)),
        h('div', {}, h('div', { class: 'lbl' }, 'Point de montage'), h('b', {}, best ? best.mp : '—')),
        h('div', {}, h('div', { class: 'lbl' }, 'Identifiant / mot de passe'), h('b', {}, `${CASTER.user} / ${CASTER.pass}`)),
        h('div', {}, h('div', { class: 'lbl' }, 'Système'), h('b', {}, 'RGF93 (ETRS89)'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => copy(`${CASTER.host}:${CASTER.port}`) }, 'Copier le caster'),
        best ? h('button', { class: 'btn small', onclick: () => copy(best.mp) }, 'Copier ' + best.mp) : null),
      h('p', { class: 'small muted' }, 'Identifiants publics du réseau ouvert Centipède. Les coordonnées obtenues sont en RGF93 ; hauteur ellipsoïdale à convertir en NGF-IGN69 (grille RAF20) pour les GCP.')),
    h('div', { class: 'map-wrap' }, mapBox),
    h('p', { class: 'small muted' }, 'Cercles : 20, 35 et 50 km autour du point de vol · vert : base active · gris : éteinte'),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, `Bases actives à moins de 80 km · ${act.length}`),
      act.length ? act.slice(0, 15).map(row) : h('p', { class: 'small' }, 'Aucune.')),
    near.length > act.length ? h('section', { class: 'card' }, h('div', { class: 'lbl' }, `Bases éteintes à proximité · ${near.length - act.length}`),
      near.filter((b) => !b.on).slice(0, 8).map(row)) : null,
    h('p', { class: 'foot' }, `Source : réseau Centipède (map.centipede-rtk.org), ${res.data.bases.length} bases, liste mise à jour ${ago(res.data.generated * 1000)}${res.live ? '' : ' (hors ligne)'}. L'état « active » vient du dernier contrôle du réseau : vérifier la connexion sur le terrain.`));
  // carte
  if (map) { map.remove(); map = null; }
  map = L.map(mapBox, { preferCanvas: true }).setView([site.lat, site.lon], 9);
  const plan = ignLayer().addTo(map);
  L.control.layers({ 'Plan IGN': plan, 'Photo aérienne': orthoLayer() }, null, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  for (const [r, c] of [[20, '#2e7d32'], [35, '#2e7d32'], [50, '#c25e00']]) L.circle([site.lat, site.lon], { radius: r * 1000, color: c, weight: 1.2, dashArray: '5 5', fill: false, interactive: false }).addTo(map);
  for (const b of all.filter((x) => x.d <= 200)) {
    L.circleMarker([b.lat, b.lon], { radius: b.on ? 7 : 5, color: '#000', weight: 1.5, fillColor: b.on ? '#2e9d4a' : '#9aa4b0', fillOpacity: 1 })
      .bindPopup(`<b>${b.mp}</b> · ${b.on ? 'active' : 'éteinte'}<br>${fmtNum(b.d)} km ${b.dir}<br><small>${b.rx || ''}${b.gnss ? ' · ' + b.gnss : ''}</small>`)
      .on('click', () => { const r = rows.get(b.mp); if (r) { r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); } })
      .addTo(map);
  }
  L.circleMarker([site.lat, site.lon], { radius: 8, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map).bindPopup('Point de vol');
  if (best) map.fitBounds(L.latLngBounds([[site.lat, site.lon], ...act.slice(0, 4).map((b) => [b.lat, b.lon])]).pad(0.25), { maxZoom: 11 });
  if (window.ResizeObserver) new ResizeObserver(() => map && map.invalidateSize()).observe(mapBox);
}
