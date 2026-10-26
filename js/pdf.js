// Rapport PDF « météo + bulletin + zones » d'un lieu, pour l'archive du dossier mission (jsPDF, A4 portrait).
import * as M from './metar.js';
import { pickStations } from './meteo.js';
import * as B from './bulletin.js';
import * as Z from './zones.js';
import { fetchCached, settings, toL93, hhmm, hh, jour, dateFr, fmtDist, dir8, fmtNum } from './util.js';

// Helvetica (jsPDF) ne connaît que le jeu Windows-1252 : on remplace le reste
const T = (s) => String(s ?? '').replace(/→/g, '->').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/[–—]/g, '-').replace(/[’]/g, "'")
  .replace(/[⌖📍⛈🌦🌧🌫☁️⛅🌤☀]/gu, '').replace(/[^\x20-\x7E\xA0-\xFF€œŒ•…]/g, '');
const COL = { ok: [46, 125, 50], warn: [239, 108, 0], bad: [198, 40, 40], na: [150, 150, 150] };
const LV = ['ok', 'warn', 'bad'];

function tileXY(lat, lon, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}
const loadImg = (url) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });

// Carte statique des zones (canvas) : fond Plan IGN + limites, zones, point de vol
export async function zonesMapImage(R, W = 1400, Hh = 1400) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Hh;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, Hh);
  const z = 12;
  const [cx, cy] = tileXY(R.lat, R.lon, z);
  const mpp = (40075016 * Math.cos((R.lat * Math.PI) / 180)) / (256 * 2 ** z);
  const scale = (W / (2 * R.radius)) * mpp;       // pixels canvas par pixel de tuile
  const toPx = (lat, lon) => { const [x, y] = tileXY(lat, lon, z); return [W / 2 + (x - cx) * 256 * scale, Hh / 2 + (y - cy) * 256 * scale]; };
  const half = R.radius / mpp / 256;
  const tiles = [];
  for (let ty = Math.floor(cy - half); ty <= Math.floor(cy + half); ty++) for (let tx = Math.floor(cx - half); tx <= Math.floor(cx + half); tx++) tiles.push([tx, ty]);
  const url = (layer, tms, tx, ty) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=${tms}&TILEMATRIX=${z}&TILEROW=${ty}&TILECOL=${tx}`;
  const ims = await Promise.all(tiles.map(([tx, ty]) => loadImg(url('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'PM_0_19', tx, ty))));
  const lims = await Promise.all(tiles.map(([tx, ty]) => loadImg(url('LIMITES_ADMINISTRATIVES_EXPRESS.LATEST', 'PM_6_16', tx, ty))));
  g.globalAlpha = 0.55;
  tiles.forEach(([tx, ty], i) => { if (ims[i]) g.drawImage(ims[i], W / 2 + (tx - cx) * 256 * scale, Hh / 2 + (ty - cy) * 256 * scale, 256 * scale + 1, 256 * scale + 1); });
  g.globalAlpha = 1;
  tiles.forEach(([tx, ty], i) => { if (lims[i]) g.drawImage(lims[i], W / 2 + (tx - cx) * 256 * scale, Hh / 2 + (ty - cy) * 256 * scale, 256 * scale + 1, 256 * scale + 1); });
  const path = (geom) => {
    g.beginPath();
    if (geom.t === 'C') {
      const [px, py] = toPx(geom.c[1], geom.c[0]);
      g.arc(px, py, geom.r / mpp * scale, 0, 2 * Math.PI);
    } else for (const ring of geom.rings) ring.forEach((p, i) => { const [x, y] = toPx(p[1], p[0]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath();
  };
  for (const e of [...R.list].sort((a, b) => a.sev - b.sev)) {
    if (e.above120) continue;
    for (const v of e.z.vols || []) {
      const st = Z.volStyle(e, v, R.ground);
      if (!st) continue;
      path(v.g);
      if (st.fill !== false) { g.globalAlpha = st.fillOpacity; g.fillStyle = st.fillColor; g.fill('evenodd'); g.globalAlpha = 1; }
      if (st.buffer) { g.setLineDash([]); g.globalAlpha = 0.25; g.lineJoin = 'round'; g.lineWidth = (2 * st.buffer / mpp) * scale; g.strokeStyle = st.color; g.stroke(); g.globalAlpha = 1; }
      g.setLineDash(st.dashArray ? st.dashArray.split(' ').map((x) => +x * 1.6) : []);
      g.lineWidth = st.weight * 1.6; g.strokeStyle = st.color; g.stroke();
    }
  }
  g.setLineDash([3, 5]);
  for (const p of R.protected || []) { path(p.geom); g.lineWidth = 2; g.strokeStyle = '#2e7d32'; g.stroke(); }
  g.setLineDash([6, 6]); g.lineWidth = 2; g.strokeStyle = '#000';
  g.beginPath(); g.arc(W / 2, Hh / 2, (1000 / mpp) * scale, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]);
  g.beginPath(); g.arc(W / 2, Hh / 2, 14, 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 6; g.stroke();
  g.beginPath(); g.arc(W / 2, Hh / 2, 4, 0, 2 * Math.PI); g.fillStyle = '#000'; g.fill();
  const km = 3, bar = (km * 1000 / mpp) * scale;
  g.fillStyle = '#000'; g.fillRect(W - bar - 40, Hh - 50, bar, 8); g.font = 'bold 28px sans-serif'; g.fillText(`${km} km`, W - bar / 2 - 70, Hh - 62);
  g.fillText('N ↑', 30, Hh - 40);
  g.lineWidth = 4; g.strokeRect(0, 0, W, Hh);
  try { return cv.toDataURL('image/jpeg', 0.85); } catch { return null; }
}

export async function report(site, title = 'Dossier mission', flightDate = null) {
  const { jsPDF } = window.jspdf;
  const S = settings();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, m = 14;
  let y = 0;
  const l93 = toL93(site.lat, site.lon);
  const head = (sub) => {
    doc.setFillColor(20, 20, 20); doc.rect(0, 0, W, 20, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(T(title), m, 9);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(T(`${site.name} · ${site.lat.toFixed(5)}, ${site.lon.toFixed(5)} · L93 ${Math.round(l93.E)} / ${Math.round(l93.N)}`), m, 15);
    doc.text(T(`${sub} · établi le ${new Date().toLocaleDateString('fr-FR')} à ${hhmm(Date.now())}`), W - m, 15, { align: 'right' });
    doc.setTextColor(0); y = 28;
  };
  const txt = (s, size = 10, bold = false, x = m, maxw = W - 2 * m) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size);
    const lines = doc.splitTextToSize(T(s), maxw);
    if (y + lines.length * size * 0.42 > 285) { doc.addPage(); y = 20; }
    doc.text(lines, x, y); y += lines.length * size * 0.42 + 1.2;
  };
  const pill = (x, yy, lvl, label) => {
    const c = COL[lvl == null ? 'na' : LV[lvl]] || COL.na;
    doc.setFillColor(...c); doc.roundedRect(x, yy - 4, doc.getTextWidth(T(label)) + 5, 5.6, 1.2, 1.2, 'F');
    doc.setTextColor(255); doc.text(T(label), x + 2.5, yy); doc.setTextColor(0);
  };
  const footer = () => {
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(110); doc.text(T(`Météo vol · géovigilance, ne remplace ni l'AIP, ni les SUP AIP, ni les NOTAM · page ${i}/${n}`), W / 2, 292, { align: 'center' }); doc.setTextColor(0); }
  };

  // ---- 1. METAR / TAF
  head('Météo aéronautique');
  let sts = [];
  try { sts = await pickStations(site); } catch { /* hors ligne */ }
  const sun = M.sun(site.lat, site.lon);
  txt(`Soleil : lever ${sun.rise ? hhmm(sun.rise) : '-'} · coucher ${sun.set ? hhmm(sun.set) : '-'} · vent max machine ${S.maxWind} km/h`, 9.5);
  y += 2;
  if (!sts.length) txt('Aucun METAR disponible (pas de réseau ?).', 11, true);
  for (const st of sts) {
    const c = st.metar, v = M.verdict(c, S.maxWind);
    const sp = M.kmh(c.wspd || 0), gu = c.wgst != null ? M.kmh(c.wgst) : null;
    if (y > 240) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(T(`${st.icao} ${(st.name || '').replace(/ Airport$/, '')}`), m, y);
    pill(W - m - 22, y, v.lvl, M.LVL_TXT[v.lvl]); y += 5.5;
    txt(`Observé à ${st.obs ? hhmm(st.obs) : '-'}${st.d != null ? ` · ${fmtNum(st.d)} km` : ''} · vent ${typeof c.wdir === 'number' ? 'du ' + String(c.wdir).padStart(3, '0') + '°' : 'variable'} ${sp}${gu ? '-' + gu : ''} km/h · visi ${c.visib >= 10000 ? '> 10 km' : fmtNum((c.visib || 0) / 1000) + ' km'} · plafond ${M.ceiling(c.clouds) ?? 'dégagé'}${M.ceiling(c.clouds) != null ? ' ft' : ''} · ${c.temp ?? '-'}°/${c.dew ?? '-'}° · QNH ${c.qnh ?? '-'}`, 9.5);
    if (v.why.length) txt('Limitant : ' + v.why.join(', '), 9.5, true);
    doc.setFont('courier', 'normal'); doc.setFontSize(8); const rl = doc.splitTextToSize(c.raw, W - 2 * m); doc.text(rl, m, y); y += rl.length * 3.4 + 1;
    if (st.taf) {
      const sl = M.slots(st.taf, S.maxWind, 24);
      const cw = (W - 2 * m) / 24;
      (sl || []).forEach((s, i) => {
        doc.setFillColor(...COL[s.lvl == null ? 'na' : LV[s.lvl]]);
        doc.rect(m + i * cw, y, cw - 0.4, 5, 'F');
        if (i % 3 === 0) { doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(String(new Date(s.t).getHours()), m + i * cw + 0.6, y + 8); }
      });
      y += 11;
      const tl = doc.splitTextToSize(st.taf.raw, W - 2 * m); doc.setFont('courier', 'normal'); doc.setFontSize(8); doc.text(tl, m, y); y += tl.length * 3.4 + 1;
      const win = M.windows(sl);
      txt(win.length ? 'Créneaux favorables (TAF) : ' + win.map((w) => `${jour(w.s)} ${hh(w.s)}-${hh(w.e)}`).join(', ') : 'Pas de créneau favorable de 2 h dans le TAF.', 9);
    }
    y += 3;
  }

  // ---- 2. Bulletin
  doc.addPage(); head('Bulletin météo');
  try {
    const F = B.parse((await fetchCached(B.forecastUrl(site.lat, site.lon))).data, S.maxWind);
    for (const d of F.days) {
      const s = B.summary(F, d.t, S.maxWind);
      if (!s) continue;
      if (y > 235) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(T(dateFr(d.t)), m, y);
      pill(W - m - 22, y, s.lvl, ['FAVORABLE', 'MITIGÉ', 'DÉFAVORABLE'][s.lvl]); y += 5;
      txt(`${Math.round(s.tmin)}° / ${Math.round(s.tmax)}° · vent dominant ${s.dom != null ? dir8(s.dom) : '-'} · rafales max ${Math.round(s.gmax)} km/h · vent 100 m ${Math.round(s.w100)} km/h · pluie ${fmtNum(s.rain)} mm`, 9.5);
      txt(s.win.length ? 'Créneaux favorables : ' + s.win.map((w) => `${hh(w.s)}-${hh(w.e)}`).join(', ') : 'Pas de créneau favorable de 2 h entre 6h et 21h.', 9.5, true);
      txt('Lignes : heure, T° (°C), vent moyen et rafales (km/h), direction, pluie (mm) · bandeau : vert OK, orange limite, rouge no-go', 7);
      // tableau horaire
      const cols = s.hs.length, cw = (W - 2 * m) / cols;
      const rows = [['h', (x) => new Date(x.t).getHours()], ['T°', (x) => Math.round(x.temp ?? 0)], ['vent', (x) => Math.round(x.w10 ?? 0)], ['raf.', (x) => Math.round(x.g10 ?? 0)], ['dir', (x) => dir8(x.d10)], ['mm', (x) => (x.precip ? fmtNum(x.precip) : '')]];
      doc.setFontSize(7);
      s.hs.forEach((x, i) => { doc.setFillColor(...COL[LV[x.lvl]]); doc.rect(m + i * cw, y, cw - 0.4, 3, 'F'); });
      y += 6;
      for (const [lab, fn] of rows) {
        s.hs.forEach((x, i) => { doc.setFont('helvetica', lab === 'h' ? 'bold' : 'normal'); doc.text(T(String(fn(x))), m + i * cw + cw / 2, y, { align: 'center' }); });
        y += 3.6;
      }
      y += 4;
    }
    txt('Source : Open-Meteo, modèles Météo-France (AROME 1,3 km puis ARPEGE). Vent en km/h.', 8);
  } catch { txt('Prévisions indisponibles (pas de réseau ?).', 11, true); }

  // ---- 3. Zones
  doc.addPage(); head('Zones de vol');
  try {
    const R = await Z.collect(site, (S.radiusKm || 10) * 1000);
    const BI = Z.bannerInfo(R);
    doc.setFillColor(...COL[BI.cls]); doc.rect(m, y - 5, W - 2 * m, 13, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(T(BI.lab), m + 3, y + 3);
    doc.setFontSize(9.5); doc.text(T(BI.l1), m + 48, y); doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(T(BI.l2), W - 2 * m - 50), m + 48, y + 4.5);
    doc.setTextColor(0); y += 13;
    const PI = Z.peupleeInfo(R, flightDate);
    if (PI && (PI.inside || PI.dist < 1000)) {
      txt(PI.inside
        ? `ZONE PEUPLÉE : déclaration en préfecture au moins ${Z.PEUPLEE_DELAI} jours ouvrés avant le vol (AlphaTango)` + (PI.deadline ? ` · pour un vol le ${new Date(flightDate + 'T12:00').toLocaleDateString('fr-FR')} : au plus tard le ${PI.deadline.toLocaleDateString('fr-FR')}${PI.late ? ' (DÉLAI DÉPASSÉ)' : ''}` : '')
        : `Agglomération à ${fmtDist(PI.dist)} ${PI.dir || ''} : rester hors du tampon de 50 m ou déclarer le vol en préfecture.`, 9.5, true);
    }
    const img = await zonesMapImage(R);
    if (img) { doc.addImage(img, 'JPEG', m + 22, y, 138, 138); y += 141; }
    txt('Rouge : interdit · orange : accord · bleu : conditions · violet : ZICAD · tireté : au-delà d\'une hauteur · vert : espace protégé', 7.5);
    const rows = R.list.filter((e) => !e.above120);
    for (const e of rows) {
      if (y > 275) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
      doc.text(T(`${e.inside ? 'AU POINT' : fmtDist(e.dist) + ' ' + (e.dir || '')}  ${Z.zname(e.z)}`), m, y);
      doc.setFont('helvetica', 'normal'); doc.text(T(`${Z.LABEL[e.restriction]}${e.temp && e.restriction === 'PROHIBITED' ? ' si active' : ''} · ${Z.heightTxt(e)}`), W - m, y, { align: 'right' });
      y += 4;
      txt(`${e.z.typeLabel || ''}${e.z.detail ? ' · ' + e.z.detail : ''} · ${e.z.cond || ''} · contact : ${e.z.authShort || e.z.auth?.name || '-'}${e.z.auth?.phone ? ' ' + e.z.auth.phone : ''}`, 8);
    }
    const info = R.list.filter((e) => e.above120);
    if (info.length) txt('Sans effet sous 120 m : ' + info.map((e) => `${Z.zname(e.z)} (dès ${Math.round(e.floor)} m)`).join(' · '), 8);
    if (R.protected && R.protected.length) txt('Espaces protégés : ' + R.protected.slice(0, 6).map((p) => `${p.label} ${p.name} (${fmtDist(p.dist)})`).join(' · '), 8);
    if (R.osm && R.osm.length) txt('Vigilance OSM : ' + R.osm.slice(0, 8).map((o) => `${o.label}${o.name ? ' ' + o.name : ''} (${fmtDist(o.dist)} ${o.dir || ''})`).join(' · '), 8);
    txt(`NOTAM non intégrés : vérifier SOFIA-Briefing pour la date du vol. Données SIA ${R.meta?.source || '-'} (AIRAC ${R.meta?.airac || '-'})${R.outdated ? ' PÉRIMÉES' : ''}, ZICAD, OSM, INPN, IGN · sol ${R.ground != null ? Math.round(R.ground) + ' m' : 'inconnu'}.`, 8);
  } catch (e) { txt('Zones indisponibles : ' + e.message, 11, true); }
  footer();
  return doc.output('blob');
}
