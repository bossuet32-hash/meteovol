// Décodage METAR / TAF bruts (format OACI) et verdict de vol drone.
// Les sorties reprennent les champs utilisés par la version Kobo (wdir, wspd, wgst en nœuds, visib en m, clouds…).

const KT = 1.852;
export const kmh = (kt) => (kt == null ? null : Math.round(kt * KT));

// ---------------------------------------------------------------- groupes élémentaires
function parseWind(tok) {
  const m = tok.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/);
  if (!m) return null;
  const f = m[4] === 'MPS' ? 1.94384 : m[4] === 'KMH' ? 1 / KT : 1;
  return {
    wdir: m[1] === 'VRB' ? 'VRB' : +m[1],
    wspd: Math.round(+m[2] * f),
    wgst: m[3] ? Math.round(+m[3] * f) : null,
  };
}

function parseVis(tok) {
  if (tok === 'CAVOK') return { visib: 10000, cavok: true };
  if (/^\d{4}$/.test(tok)) return { visib: +tok === 9999 ? 10000 : +tok };
  if (/^\d{4}(N|NE|E|SE|S|SW|W|NW)$/.test(tok)) return { visibMin: +tok.slice(0, 4) };
  const sm = tok.match(/^(P)?(\d+)(?:\/(\d+))?SM$/);
  if (sm) return { visib: Math.round((sm[3] ? +sm[2] / +sm[3] : +sm[2]) * 1609) };
  return null;
}

const CLOUD = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;
const WX = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)?$/;

function isWx(tok) {
  if (!WX.test(tok) || tok.length < 2) return false;
  const m = tok.match(WX);
  return !!(m[2] || m[3]);
}

// ---------------------------------------------------------------- METAR
export function parseMetar(raw) {
  const txt = raw.replace(/=\s*$/, '').trim();
  const toks = txt.split(/\s+/);
  const o = { raw: txt, clouds: [], wx: [] };
  let i = 0;
  if (toks[i] === 'METAR' || toks[i] === 'SPECI') i++;
  o.icao = toks[i++];
  const tm = (toks[i] || '').match(/^(\d{2})(\d{2})(\d{2})Z$/);
  if (tm) { o.day = +tm[1]; o.hour = +tm[2]; o.min = +tm[3]; i++; }
  if (toks[i] === 'AUTO' || toks[i] === 'COR') { o.auto = toks[i] === 'AUTO'; i++; }
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'NOSIG' || t === 'TEMPO' || t === 'BECMG' || t === 'RMK') { o.trend = toks.slice(i).join(' '); break; }
    let w;
    if ((w = parseWind(t))) { Object.assign(o, w); continue; }
    if (/^\d{3}V\d{3}$/.test(t)) { o.wvar = t.replace('V', '–') + '°'; continue; }
    if ((w = parseVis(t))) { Object.assign(o, w); continue; }
    if (/^R\d{2}[LCR]?\//.test(t)) continue;                      // portée visuelle de piste
    const c = t.match(CLOUD);
    if (c) { o.clouds.push({ cover: c[1], base: c[2] === '///' ? null : +c[2] * 100, type: c[3] && c[3] !== '///' ? c[3] : null }); continue; }
    if (t === 'NSC' || t === 'NCD' || t === 'SKC' || t === 'CLR') continue;
    const tt = t.match(/^(M?\d{2})\/(M?\d{2})?$/);
    if (tt) { o.temp = +tt[1].replace('M', '-'); if (tt[2]) o.dew = +tt[2].replace('M', '-'); continue; }
    const q = t.match(/^Q(\d{4})$/);
    if (q) { o.qnh = +q[1]; continue; }
    const a = t.match(/^A(\d{4})$/);
    if (a) { o.qnh = Math.round(+a[1] / 100 * 33.8639); continue; }
    if (isWx(t)) { o.wx.push(t); continue; }
  }
  o.wxString = o.wx.join(' ');
  return o;
}

// Date du message (UTC) à partir du jour/heure du METAR, relativement à `now`.
export function obsTime(o, now = new Date()) {
  if (o.day == null) return null;
  let d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), o.day, o.hour, o.min);
  if (d > now.getTime() + 6 * 3600e3) d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, o.day, o.hour, o.min);
  return d;
}

// La réponse met.no contient tous les messages des dernières 24 h, un par ligne ; on garde le dernier.
export function lastMessage(txt) {
  const lines = (txt || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // un message peut tenir sur plusieurs lignes : on regroupe jusqu'au « = »
  const msgs = [];
  let cur = '';
  for (const l of lines) {
    cur = cur ? cur + ' ' + l : l;
    if (/=$/.test(l)) { msgs.push(cur); cur = ''; }
  }
  if (cur) msgs.push(cur);
  return msgs.length ? msgs[msgs.length - 1] : null;
}

// ---------------------------------------------------------------- TAF
function ddhh(s, ref) {
  // « 2518 » -> jour 25 à 18 h UTC ; « 2524 » -> lendemain 0 h
  const d = +s.slice(0, 2), h = +s.slice(2, 4);
  const now = new Date(ref);
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d, h);
  if (t < ref - 20 * 86400e3) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, d, h);
  if (t > ref + 20 * 86400e3) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, d, h);
  return t;
}

export function parseTaf(raw, now = Date.now()) {
  const txt = raw.replace(/=\s*$/, '').replace(/\s+/g, ' ').trim();
  const toks = txt.split(' ');
  let i = 0;
  if (toks[i] === 'TAF') i++;
  if (toks[i] === 'AMD' || toks[i] === 'COR') i++;
  const taf = { raw: txt, icao: toks[i++], fcsts: [] };
  if (/^\d{6}Z$/.test(toks[i] || '')) { taf.issued = toks[i]; i++; }
  const vp = (toks[i] || '').match(/^(\d{4})\/(\d{4})$/);
  if (!vp) return taf;
  taf.from = ddhh(vp[1], now); taf.to = ddhh(vp[2], now); i++;
  let cur = { fcstChange: null, timeFrom: taf.from, timeTo: taf.to, clouds: [], wx: [] };
  const push = () => { cur.wxString = cur.wx.join(' '); taf.fcsts.push(cur); };
  let prob = null;
  for (; i < toks.length; i++) {
    const t = toks[i];
    let m;
    if ((m = t.match(/^PROB(\d{2})$/))) { push(); prob = +m[1]; cur = { fcstChange: 'PROB', probability: prob, clouds: [], wx: [] }; continue; }
    if (t === 'TEMPO' || t === 'BECMG') {
      if (cur.fcstChange === 'PROB' && cur.timeFrom == null) { cur.fcstChange = t === 'TEMPO' ? 'PROB' : 'BECMG'; cur.tempo = t === 'TEMPO'; continue; }
      push(); cur = { fcstChange: t, clouds: [], wx: [] }; continue;
    }
    if ((m = t.match(/^FM(\d{2})(\d{2})(\d{2})$/))) {
      push();
      const base = ddhh(m[1] + m[2], now) + +m[3] * 60e3;
      cur = { fcstChange: 'FM', timeFrom: base, timeTo: taf.to, clouds: [], wx: [] }; continue;
    }
    if ((m = t.match(/^(\d{4})\/(\d{4})$/)) && cur.timeFrom == null) { cur.timeFrom = ddhh(m[1], now); cur.timeTo = ddhh(m[2], now); continue; }
    let w;
    if ((w = parseWind(t))) { Object.assign(cur, w); continue; }
    if ((w = parseVis(t))) { Object.assign(cur, w); continue; }
    const c = t.match(CLOUD);
    if (c) { cur.clouds.push({ cover: c[1], base: c[2] === '///' ? null : +c[2] * 100, type: c[3] && c[3] !== '///' ? c[3] : null }); continue; }
    if (t === 'NSW') { cur.wx = []; cur.nsw = true; continue; }
    if (t === 'NSC' || t === 'SKC') { cur.clouds = []; cur.nsc = true; continue; }
    if (isWx(t)) { cur.wx.push(t); continue; }
  }
  push();
  // le FM termine le groupe précédent
  for (let k = 0; k < taf.fcsts.length; k++) {
    const f = taf.fcsts[k];
    if (f.fcstChange === 'FM') {
      for (let j = k - 1; j >= 0; j--) {
        const p = taf.fcsts[j];
        if (p.fcstChange === null || p.fcstChange === 'FM') { p.timeTo = Math.min(p.timeTo, f.timeFrom); break; }
      }
    }
  }
  return taf;
}

// ---------------------------------------------------------------- verdict
export function ceiling(clouds) {
  let best = null;
  for (const c of clouds || []) {
    if ((c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV') && c.base != null) {
      if (best == null || c.base < best) best = c.base;
    }
  }
  return best;
}

const WXFR = [
  [/TS/, 'orage'], [/GR|GS/, 'grêle'], [/SQ/, 'grains'], [/FG/, 'brouillard'], [/BR/, 'brume'],
  [/SHRA/, 'averses de pluie'], [/SHSN/, 'averses de neige'], [/SH/, 'averses'], [/FZRA|FZDZ/, 'pluie verglaçante'],
  [/SN/, 'neige'], [/RA/, 'pluie'], [/DZ/, 'bruine'], [/HZ|FU/, 'brume sèche'],
];
export function wxFr(s) {
  if (!s) return null;
  for (const [rx, fr] of WXFR) if (rx.test(s)) {
    const int = /\+/.test(s) ? (fr === 'pluie' || fr === 'neige' || fr === 'bruine' ? ' forte' : '') : /(^|\s)-/.test(s) ? ' faible' : '';
    return fr + (/^(pluie|neige|bruine|averses.*)$/.test(fr) ? int : '');
  }
  return null;
}

// Niveau 0 OK, 1 LIMITE, 2 NO-GO (mêmes seuils que la Kobo)
export function verdict(c, maxw) {
  let lvl = 0;
  const why = [];
  const add = (l, r) => { if (l > lvl) lvl = l; why.push(r); };
  const sp = kmh(c.wspd || 0), gu = c.wgst != null ? kmh(c.wgst) : null;
  const w = Math.max(sp, gu || 0);
  const wtxt = gu ? `rafales ${gu} km/h` : `vent ${sp} km/h`;
  if (w >= maxw) add(2, wtxt); else if (w >= maxw * 0.8) add(1, wtxt);
  const wx = c.wxString || '';
  if (/TS|GR|SQ/.test(wx)) add(2, 'orage/grêle');
  else if (/FG/.test(wx)) add(2, 'brouillard');
  else if (/\+/.test(wx) && /RA|SN/.test(wx)) add(2, 'fortes précipitations');
  else if (/RA|SN|DZ|SH/.test(wx)) {
    if (/^-/.test(wx) && !/SH/.test(wx)) add(1, 'précipitations faibles'); else add(2, 'précipitations');
  } else if (/BR/.test(wx)) add(1, 'brume');
  const v = c.visib != null ? c.visib / 1000 : null;
  if (v != null && v < 1.5) add(2, `visibilité ${v.toFixed(1).replace('.', ',')} km`);
  else if (v != null && v < 3) add(1, `visibilité ${v.toFixed(1).replace('.', ',')} km`);
  const ce = ceiling(c.clouds);
  if (ce != null && ce < 300) add(2, `plafond ${ce} ft`);
  else if (ce != null && ce < 600) add(1, `plafond ${ce} ft`);
  return { lvl, why };
}
export const LVL_TXT = ['OK', 'LIMITE', 'NO-GO'];

// Composantes de vent sur la piste la plus face au vent
export function runwayWind(hdg, wdir, spd, gust) {
  if (hdg == null || typeof wdir !== 'number') return null;
  let best = null;
  for (const h of [hdg % 360, (hdg + 180) % 360]) {
    const d = ((wdir - h) * Math.PI) / 180;
    const head = spd * Math.cos(d), cross = spd * Math.sin(d);
    if (!best || head > best.head) {
      let n = Math.round(h / 10); if (n === 0) n = 36;
      best = { rwy: String(n).padStart(2, '0'), head, cross, gcross: gust != null ? gust * Math.sin(d) : null };
    }
  }
  best.side = best.cross < 0 ? 'de gauche' : 'de droite';
  best.head = Math.round(best.head);
  best.cross = Math.round(Math.abs(best.cross));
  if (best.gcross != null) best.gcross = Math.round(Math.abs(best.gcross));
  return best;
}

// ---------------------------------------------------------------- créneaux TAF heure par heure
// applique un groupe (BECMG / TEMPO / PROB) sur des conditions : seuls les éléments annoncés changent
function applyGroup(base, f) {
  const c = { ...base };
  if (f.wspd != null) { c.wdir = f.wdir; c.wspd = f.wspd; c.wgst = f.wgst; }
  if (f.visib != null) { c.visib = f.visib; c.cavok = f.cavok; }
  if (f.clouds && f.clouds.length) c.clouds = f.clouds;
  if (f.nsc || f.cavok) c.clouds = [];
  if (f.wx && f.wx.length) { c.wx = f.wx; c.wxString = f.wx.join(' '); }
  if (f.nsw || f.cavok) { c.wx = []; c.wxString = ''; }
  return c;
}

function prevailingAt(fcsts, t) {
  let cond = null;
  for (const f of fcsts) {
    if (f.fcstChange === 'TEMPO' || (f.fcstChange === 'PROB') || f.timeFrom == null) continue;
    if (f.fcstChange === 'BECMG') {
      if (cond && f.timeFrom <= t) cond = applyGroup(cond, f);
    } else if (f.timeFrom <= t && (f.timeTo == null || t < f.timeTo)) {
      cond = { ...f };
    }
  }
  return cond;
}

export function slots(taf, maxw, hours = 24, now = Date.now()) {
  if (!taf || !taf.fcsts.length) return null;
  const start = now - (now % 3600e3);
  const out = [];
  for (let i = 0; i < hours; i++) {
    const t = start + i * 3600e3;
    if (taf.to && t >= taf.to) { out.push({ t, lvl: null }); continue; }
    const c = prevailingAt(taf.fcsts, t);
    if (!c) { out.push({ t, lvl: null }); continue; }
    const v = verdict(c, maxw);
    let risk = false, risk_txt = null;
    for (const o of taf.fcsts) {
      if ((o.fcstChange === 'TEMPO' || o.fcstChange === 'PROB') && o.timeFrom <= t && t < o.timeTo) {
        const v2 = verdict(applyGroup(c, o), maxw);
        if (v2.lvl > v.lvl) {
          risk = true;
          risk_txt = (o.fcstChange === 'PROB' ? `PROB${o.probability}` : 'TEMPO') + ' ' + (wxFr(o.wxString) || v2.why[0] || '');
        }
      }
    }
    out.push({ t, lvl: v.lvl, why: v.why, risk, risk_txt, cond: c });
  }
  return out;
}

export function windows(sl) {
  const w = [];
  let s = null;
  (sl || []).forEach((x, i) => {
    const good = x.lvl === 0 && !x.risk;
    if (good && s == null) s = x.t;
    if ((!good || i === sl.length - 1) && s != null) {
      const e = good ? x.t + 3600e3 : x.t;
      if (e - s >= 2 * 3600e3) w.push({ s, e });
      s = null;
    }
  });
  return w;
}

// Libellés lisibles des périodes du TAF
export function tafPeriods(taf, maxw) {
  const L = [];
  for (const f of taf.fcsts) {
    const lab = f.fcstChange === 'TEMPO' ? 'Temporairement' : f.fcstChange === 'PROB' ? `Probabilité ${f.probability} %${f.tempo ? ' (temporaire)' : ''}`
      : f.fcstChange === 'BECMG' ? 'Devenant' : f.fcstChange === 'FM' ? 'À partir de' : 'Base';
    const parts = [];
    if (f.wspd != null) parts.push((f.wdir === 'VRB' ? 'vent variable ' : `vent du ${String(f.wdir).padStart(3, '0')}° `) + kmh(f.wspd) + ' km/h' + (f.wgst ? ` raf. ${kmh(f.wgst)}` : ''));
    if (f.visib != null) parts.push(f.visib >= 10000 ? 'visi > 10 km' : `visi ${(f.visib / 1000).toFixed(1).replace('.', ',')} km`);
    const wx = wxFr(f.wxString); if (wx) parts.push(wx);
    if (f.nsw) parts.push('fin des phénomènes');
    const ce = ceiling(f.clouds); if (ce != null) parts.push(`plafond ${ce} ft`);
    if (f.nsc || f.cavok) parts.push('pas de nuages significatifs');
    L.push({ lab, from: f.timeFrom, to: f.timeTo, txt: parts.join(', ') || 'sans changement notable', lvl: verdict(f, maxw).lvl, kind: f.fcstChange });
  }
  return L;
}

// ---------------------------------------------------------------- soleil
export function sun(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400e3);
  const calc = (rising) => {
    const lngHour = lon / 15;
    const t = n + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = (L + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = (RA + 360) % 360;
    RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    let H = rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    const UT = (T - lngHour + 48) % 24;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + UT * 3600e3;
  };
  return { rise: calc(true), set: calc(false) };
}

export function kpNote(kp) {
  if (kp == null) return null;
  if (kp >= 7) return 'orage géomagnétique fort : GNSS/RTK très dégradé';
  if (kp >= 5) return 'orage géomagnétique : GNSS/RTK dégradé, prudence';
  if (kp >= 4) return 'activité soutenue : surveiller la précision GNSS';
  return 'calme : pas d\'effet attendu sur le GNSS';
}
