// Calcul des plans de vol 3D autour d'un bâtiment (façades, orbites, toiture) pour le DJI Air 3S.
// Repère local en mètres (x = est, y = nord) centré sur le bâtiment ; altitudes en mètres NGF.

export const CAMERA = {
  nom: 'DJI Air 3S · caméra grand-angle 1"', focal35: 24, imageW: 8192, imageH: 6144,
};
const DIAG35 = 43.2666;
export function fov(cam = CAMERA) {
  const k = DIAG35 / Math.hypot(cam.imageW, cam.imageH);
  return { h: 2 * Math.atan((cam.imageW * k) / 2 / cam.focal35), v: 2 * Math.atan((cam.imageH * k) / 2 / cam.focal35) };
}
// distance (m) donnant une résolution (mm/px) ; empreinte (m) à une distance
export const distForGsd = (mm, cam = CAMERA) => (mm / 1000) * cam.imageW / (2 * Math.tan(fov(cam).h / 2));
export const gsdAt = (d, cam = CAMERA) => (2 * d * Math.tan(fov(cam).h / 2) * 1000) / cam.imageW;
export const footprint = (d, cam = CAMERA) => ({ w: 2 * d * Math.tan(fov(cam).h / 2), h: 2 * d * Math.tan(fov(cam).v / 2) });

// ---------------------------------------------------------------- repère local
export function frame(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return {
    lat0, lon0,
    xy: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    ll: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

// ---------------------------------------------------------------- géométrie 2D
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const yawOf = (v) => ((Math.atan2(v[0], v[1]) * 180) / Math.PI + 360) % 360;   // 0 = nord, sens horaire

export function area(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
export function centroid(r) {
  let cx = 0, cy = 0, s = 0;
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], k = a[0] * b[1] - b[0] * a[1]; s += k; cx += (a[0] + b[0]) * k; cy += (a[1] + b[1]) * k; }
  return s ? [cx / (3 * s), cy / (3 * s)] : r[0];
}
export function inside(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function segDist(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1)));
  return len(sub(p, add(a, mul(ab, t))));
}
export function distPoly(p, r) {
  if (inside(p, r)) return 0;
  let d = Infinity;
  for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(p, r[i], r[(i + 1) % r.length]));
  return d;
}
// simplification (Douglas-Peucker) d'un anneau fermé
export function simplify(r, tol) {
  if (r.length <= 4) return r.slice();
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    let im = 0, dm = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > dm) { dm = d; im = i; } }
    if (dm <= tol) return [pts[0], pts[pts.length - 1]];
    const a = dp(pts.slice(0, im + 1)), b = dp(pts.slice(im));
    return a.slice(0, -1).concat(b);
  };
  // couper l'anneau au sommet le plus éloigné du premier
  let far = 0, fd = 0;
  r.forEach((p, i) => { const d = len(sub(p, r[0])); if (d > fd) { fd = d; far = i; } });
  const a = dp(r.slice(0, far + 1)), b = dp(r.slice(far).concat([r[0]]));
  let out = a.slice(0, -1).concat(b.slice(0, -1));
  // retirer les sommets presque alignés
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length], q = out[i], s = out[(i + 1) % out.length];
      if (segDist(q, p, s) < tol * 0.5 || len(sub(q, p)) < 0.3) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}
export function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(sub(lo[lo.length - 1], lo[lo.length - 2]), sub(q, lo[lo.length - 2])) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(sub(up[up.length - 1], up[up.length - 2]), sub(q, up[up.length - 2])) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));   // sens trigonométrique
}
const ccw = (r) => (area(r) < 0 ? r.slice().reverse() : r.slice());

// Contour décalé vers l'extérieur de d (angles saillants arrondis, rentrants à l'intersection).
// Renvoie une liste de « côtés » : { a, b (sur le décalage), n (normale sortante), i (indice) } et les jonctions.
function offsetSides(r, d) {
  const n = r.length;
  const sides = [];
  for (let i = 0; i < n; i++) {
    const A = r[i], B = r[(i + 1) % n], t = norm(sub(B, A)), nn = [t[1], -t[0]];
    sides.push({ i, A, B, t, n: nn, L: len(sub(B, A)), a: add(A, mul(nn, d)), b: add(B, mul(nn, d)) });
  }
  // coins rentrants : couper les deux côtés à l'intersection des décalages
  for (let i = 0; i < n; i++) {
    const s = sides[i], q = sides[(i + 1) % n];
    const turn = cross(s.t, q.t);       // > 0 : coin saillant (anneau trigonométrique)
    s.convexEnd = turn > 1e-9;
    q.convexStart = s.convexEnd;
    if (!s.convexEnd) {
      // intersection des droites décalées
      const den = cross(s.t, q.t);
      if (Math.abs(den) > 1e-6) {
        const k = cross(sub(q.a, s.a), q.t) / den;
        const P = add(s.a, mul(s.t, k));
        s.b = P; q.a = P;
      }
    }
  }
  return sides;
}

function arc(C, r, n1, n2, step) {
  const a1 = Math.atan2(n1[1], n1[0]);
  let a2 = Math.atan2(n2[1], n2[0]);
  while (a2 < a1) a2 += 2 * Math.PI;              // anneau trigonométrique : les normales tournent dans le sens direct
  const k = Math.max(1, Math.ceil((a2 - a1) / step));
  const out = [];
  for (let j = 1; j < k; j++) { const a = a1 + ((a2 - a1) * j) / k; out.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
  return out;
}

// ---------------------------------------------------------------- plan
// B : { ring (local, anneau), zg (sol NGF), zt (toit max NGF) } ; voisins : [{ ring, zt }]
// T : { x, y, z } point de décollage (z sol NGF) ; P : paramètres
export const DEFAUTS = {
  facade: true, orbite: true, toit: true,
  gsdFacade: 3, ovH: 85, ovV: 75, rangHaute: true,
  orbiteAnneaux: 2, orbiteDist: 0, ovOrbite: 85,
  gsdToit: 3, ovToitAvant: 80, ovToitLat: 75, toitCroise: true, toitObliques: true, toitObliquePitch: -55,
  facadeNacelle: 2, facadeObliques: true, facadeObliqueAngle: 25,
  marge: 5, distMin: 8, hMinSol: 3, vitesse: 3, transit: 8, maxParMission: 200,
};

export function plan(B, voisins, T, P0) {
  const P = { ...DEFAUTS, ...P0 };
  const fv = fov();
  const alertes = [];
  const ring = ccw(simplify(B.ring, 0.6));
  const hullR = hull(B.ring);
  const H = Math.max(1, B.zt - B.zg);
  const obst = [{ ring: B.ring, zt: B.zt, self: true }, ...voisins.map((v) => ({ ...v }))];
  // altitude de sécurité : au-dessus de tout ce qui est proche
  const zSafe = Math.max(B.zt, ...voisins.filter((v) => v.dist < 60).map((v) => v.zt || 0)) + P.marge;

  // distance minimale du point (x, y) à un obstacle plus haut que z - marge
  const clearance = (p, z) => {
    let d = Infinity;
    for (const o of obst) if (o.zt + P.marge * 0.5 > z) d = Math.min(d, distPoly(p, o.ring));
    return d;
  };

  const groups = [];   // { nom, pts: [{x, y, z, yaw, pitch, photo}] }

  // ---- façades
  const dF = Math.max(P.distMin, distForGsd(P.gsdFacade));
  if (P.facade) {
    const fp = footprint(dF);
    const stepH = fp.w * (1 - P.ovH / 100), stepV = fp.h * (1 - P.ovV / 100);
    const zBot = B.zg + Math.max(P.hMinSol, Math.min(fp.h / 2, H / 2));
    const zTopNeed = B.zt - fp.h / 2 + 0.5;
    const nr = zTopNeed > zBot ? Math.ceil((zTopNeed - zBot) / stepV) + 1 : 1;
    const rows = [];
    for (let k = 0; k < nr; k++) rows.push(nr === 1 ? zBot : zBot + ((Math.max(zTopNeed, zBot) - zBot) * k) / (nr - 1));
    const sides = offsetSides(ring, dF);
    const ext = fp.w * 0.25;
    // ordre des côtés : commencer par le plus proche du décollage
    let start = 0, best = Infinity;
    sides.forEach((s, i) => { const m = mul(add(s.a, s.b), 0.5); const dd = len(sub(m, [T.x, T.y])); if (dd < best) { best = dd; start = i; } });
    let mitoyens = 0, ignores = 0;
    let zCur = zSafe;
    for (let q = 0; q < sides.length; q++) {
      const s = sides[(start + q) % sides.length];
      if (s.L < 2.5) continue;
      let a = s.convexStart ? sub(s.a, mul(s.t, ext)) : s.a;
      let b = s.convexEnd ? add(s.b, mul(s.t, ext)) : s.b;
      const L = len(sub(b, a));
      if (L < 0.5 || (sub(b, a)[0] * s.t[0] + sub(b, a)[1] * s.t[1]) <= 0) continue;
      const nc = Math.max(1, Math.ceil(L / stepH) + 1);
      const yaw = yawOf(mul(s.n, -1));
      // lignes de prises de vue de a vers b, du bas vers le haut (+ rangée haute oblique)
      const levels = rows.map((z) => ({ z, pitch: 0, tag: 'F' + (s.i + 1) }));
      if (P.rangHaute) levels.push({ z: B.zt + P.marge, pitch: -Math.round(Math.atan2(P.marge + Math.min(H, fp.h) / 2, dF) * 180 / Math.PI), tag: 'F' + (s.i + 1) + 'h' });
      let skipped = 0;
      let lines = levels.map((lv) => {
        const line = [];
        for (let j = 0; j < nc; j++) {
          const p = nc === 1 ? mul(add(a, b), 0.5) : add(a, mul(sub(b, a), j / (nc - 1)));
          if (clearance(p, lv.z) < Math.min(dF, P.distMin) * 0.8) { skipped++; continue; }
          line.push({ x: p[0], y: p[1], z: lv.z, yaw, pitch: lv.pitch, photo: true, tag: lv.tag });
        }
        return line;
      });
      // commencer par la rangée la plus proche de l'altitude courante, en serpentin depuis le coin a
      if (Math.abs(levels[levels.length - 1].z - zCur) < Math.abs(levels[0].z - zCur)) lines = lines.reverse();
      // éventail vertical à chaque position (face, puis nacelle inclinée vers le bas / le haut)
      const FAN = { 1: [0], 2: [0, -30], 3: [15, 0, -30] }[P.facadeNacelle] || [0];
      const pts = [];
      lines.forEach((line, k) => {
        const fwd = k % 2 ? line.slice().reverse() : line;
        // passe de face (avec éventail sur les rangées horizontales)
        pts.push(...fwd.map((p) => (p.pitch === 0 ? { ...p, shots: FAN } : p)));
        if (P.facadeObliques && line.length > 1) {
          // retour puis aller avec le drone tourné de ±angle : vues obliques des reliefs, embrasures, angles
          const A = P.facadeObliqueAngle;
          const back = fwd.slice().reverse().map((p) => ({ ...p, yaw: (p.yaw + A + 360) % 360, tag: p.tag + 'g' }));
          const again = fwd.map((p) => ({ ...p, yaw: (p.yaw - A + 360) % 360, tag: p.tag + 'd' }));
          pts.push(...back, ...again);
        }
      });
      if (pts.length) zCur = pts[pts.length - 1].z;
      if (skipped > nc * levels.length * 0.6) { mitoyens++; }
      else if (skipped) ignores += skipped;
      if (pts.length) groups.push({ nom: `Façade ${s.i + 1}`, type: 'facade', pts, yaw });
    }
    if (mitoyens) alertes.push(`${mitoyens} façade(s) mitoyenne(s) ou trop proche(s) d'un autre bâtiment : non survolées`);
    if (ignores) alertes.push(`${ignores} prise(s) de vue retirée(s) : trop près d'un bâtiment voisin`);
    if (dF < 10) alertes.push(`Distance aux façades ${dF.toFixed(1)} m : vérifier l'absence d'arbres, câbles, balcons`);
  }

  // ---- orbites (anneaux autour de l'enveloppe convexe)
  if (P.orbite) {
    const dO = P.orbiteDist > 0 ? P.orbiteDist : Math.max(dF * 1.3, H * 0.9, P.distMin + 4);
    const hr = ccw(hull(ring));
    const zMid = (B.zg + B.zt) / 2;
    for (let k = 0; k < P.orbiteAnneaux; k++) {
      const z = B.zt + P.marge + k * Math.max(6, dO * 0.45);
      const pitch = -Math.max(15, Math.min(70, (Math.atan2(z - zMid, dO) * 180) / Math.PI));
      const slant = dO / Math.cos((pitch * Math.PI) / 180);
      const step = Math.min(footprint(slant).w * (1 - P.ovOrbite / 100), (2 * Math.PI * dO) / 24);
      const sides = offsetSides(hr, dO);
      // chemin : côtés décalés + arcs aux coins
      const path = [];
      sides.forEach((s, i) => {
        const q = sides[(i + 1) % sides.length];
        path.push({ p: s.a, n: s.n }, { p: s.b, n: s.n });
        arc(s.B, dO, s.n, q.n, Math.PI / 12).forEach((p) => path.push({ p, n: norm(sub(p, s.B)) }));
      });
      // rééchantillonnage régulier
      const per = path.reduce((acc, e, i) => acc + len(sub(path[(i + 1) % path.length].p, e.p)), 0);
      const nPh = Math.max(24, Math.ceil(per / step));
      const pts = [];
      let seg = 0, segStart = 0;
      for (let j = 0; j < nPh; j++) {
        const s = (per * j) / nPh;
        while (seg < path.length - 1 && segStart + len(sub(path[seg + 1].p, path[seg].p)) < s) { segStart += len(sub(path[seg + 1].p, path[seg].p)); seg++; }
        const e0 = path[seg], e1 = path[(seg + 1) % path.length];
        const sl = len(sub(e1.p, e0.p)) || 1, u = Math.min(1, (s - segStart) / sl);
        const p = add(e0.p, mul(sub(e1.p, e0.p), u));
        const n = norm(add(mul(e0.n, 1 - u), mul(e1.n, u)));
        if (clearance(p, z) < P.distMin * 0.8) continue;
        pts.push({ x: p[0], y: p[1], z, yaw: yawOf(mul(n, -1)), pitch: Math.round(pitch), photo: true, tag: 'O' + (k + 1) });
      }
      // commencer au plus près du point courant (rangée suivante dans le même sens)
      if (pts.length) groups.push({ nom: `Orbite ${k + 1} · ${Math.round(z - T.z)} m`, type: 'orbite', pts });
    }
  }

  // ---- toiture (grille verticale)
  if (P.toit) {
    const hT = Math.max(P.marge + 2, distForGsd(P.gsdToit));
    const z = B.zt + hT;
    const fp = footprint(hT);
    // grille le long de l'axe u (lignes espacées selon w) ; décalage `sh` (m) opposé au regard pour les obliques
    const grid = (u, w, pitch, fixedYaw, sh, tag) => {
      const pr = ring.map((p) => [p[0] * u[0] + p[1] * u[1], p[0] * w[0] + p[1] * w[1]]);
      const [umin, umax] = [Math.min(...pr.map((p) => p[0])), Math.max(...pr.map((p) => p[0]))];
      const [wmin, wmax] = [Math.min(...pr.map((p) => p[1])), Math.max(...pr.map((p) => p[1]))];
      const along = fp.h * (1 - P.ovToitAvant / 100), across = fp.w * (1 - P.ovToitLat / 100);
      const bu = fp.h * 0.3, bw = fp.w * 0.3;
      const nl = Math.max(1, Math.ceil((wmax - wmin + 2 * bw - fp.w) / across) + 1);
      const nu = Math.max(2, Math.ceil((umax - umin + 2 * bu) / along) + 1);
      const out = [];
      for (let l = 0; l < nl; l++) {
        const wv = nl === 1 ? (wmin + wmax) / 2 : wmin - bw + fp.w / 2 + ((wmax - wmin + 2 * bw - fp.w) * l) / (nl - 1);
        const line = [];
        for (let j = 0; j < nu; j++) {
          const uv = umin - bu + ((umax - umin + 2 * bu) * j) / (nu - 1);
          let p = add(mul(u, uv), mul(w, wv));
          if (sh) p = sub(p, mul(sh.dir, sh.d));
          line.push({ x: p[0], y: p[1], z, yaw: fixedYaw ?? yawOf(l % 2 ? mul(u, -1) : u), pitch, photo: true, tag });
        }
        if (l % 2) line.reverse();
        out.push(...line);
      }
      return out;
    };
    let best = 0, ang = 0;
    for (let i = 0; i < ring.length; i++) { const v = sub(ring[(i + 1) % ring.length], ring[i]); if (len(v) > best) { best = len(v); ang = Math.atan2(v[1], v[0]); } }
    const u = [Math.cos(ang), Math.sin(ang)], w = [-u[1], u[0]];
    const pts = grid(u, w, -90, null, null, 'T');
    if (P.toitCroise) pts.push(...grid(w, mul(u, -1), -90, null, null, 'Tx'));
    groups.push({ nom: `Toiture${P.toitCroise ? ' croisée' : ''} · ${Math.round(z - T.z)} m`, type: 'toit', pts });
    if (P.toitObliques) {
      // 4 passes obliques : regard selon ±u et ±w, positions reculées pour viser le toit
      const op = Math.max(-80, Math.min(-30, P.toitObliquePitch));
      const d = hT / Math.tan((-op * Math.PI) / 180);
      const opts = [[u, w], [mul(u, -1), w], [w, mul(u, -1)], [mul(w, -1), u]];
      const ob = [];
      opts.forEach(([dir, perp], k) => ob.push(...grid(dir, perp, Math.round(op), yawOf(dir), { dir, d }, 'To' + (k + 1))));
      groups.push({ nom: `Toiture oblique ${Math.round(op)}° · 4 directions`, type: 'toit', pts: ob });
    }
  }

  // ---- enchaînement : toiture, orbites (haut → bas), façades ; transitions par le haut si nécessaire
  const order = [...groups.filter((g) => g.type === 'toit'), ...groups.filter((g) => g.type === 'orbite').reverse(), ...groups.filter((g) => g.type === 'facade')];
  const segOk = (p, q) => {
    const n = Math.max(2, Math.ceil(len(sub([q.x, q.y], [p.x, p.y])) / 1.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t, z = Math.min(p.z, q.z) + 0 * t;
      if (clearance([x, y], z) < P.distMin * 0.7) return false;
    }
    return true;
  };
  const wps = [];
  const pushT = (x, y, z, yaw, pitch) => wps.push({ x, y, z, yaw, pitch, photo: false, transit: true });
  // départ : montée à la verticale du décollage
  pushT(T.x, T.y, zSafe, order[0]?.pts[0]?.yaw || 0, order[0]?.pts[0]?.pitch ?? 0);
  for (const g of order) {
    // orbites : démarrer au point le plus proche du point courant
    if (g.type === 'orbite' && wps.length) {
      const c = wps[wps.length - 1];
      let bi = 0, bd = Infinity;
      g.pts.forEach((p, i) => { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < bd) { bd = d; bi = i; } });
      g.pts = g.pts.slice(bi).concat(g.pts.slice(0, bi));
      g.pts.push({ ...g.pts[0], photo: false, transit: true });   // boucle fermée
    }
    const first = g.pts[0], cur = wps[wps.length - 1];
    if (!segOk(cur, first)) {
      if (cur.z < zSafe) pushT(cur.x, cur.y, zSafe, cur.yaw, cur.pitch);
      pushT(first.x, first.y, zSafe, first.yaw, first.pitch);
    }
    let prev = wps[wps.length - 1];
    for (const p of g.pts) {
      if (!segOk(prev, p)) {
        if (prev.z < zSafe) pushT(prev.x, prev.y, zSafe, prev.yaw, prev.pitch);
        pushT(p.x, p.y, zSafe, p.yaw, p.pitch);
      }
      wps.push({ ...p, groupe: g.nom });
      prev = p;
    }
  }
  // fin : remontée avant le retour au point de départ
  const last = wps[wps.length - 1];
  if (last && last.z < zSafe) pushT(last.x, last.y, zSafe, last.yaw, last.pitch);

  // ---- statistiques
  let L = 0;
  for (let i = 1; i < wps.length; i++) L += Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y, wps[i].z - wps[i - 1].z);
  L += Math.hypot(wps[0].x - T.x, wps[0].y - T.y, wps[0].z - T.z) + Math.hypot(last.x - T.x, last.y - T.y, last.z - T.z);
  const photos = wps.reduce((n, w) => n + (w.photo ? (w.shots ? w.shots.length : 1) : 0), 0);
  const duree = L / P.vitesse + wps.filter((w) => w.photo).length * 2.5 + photos * 1.5 + wps.filter((w) => !w.photo).length * 1.5;
  const hMax = Math.max(...wps.map((w) => w.z)) - T.z;
  if (hMax > 120) alertes.push(`Hauteur maximale ${Math.round(hMax)} m au-dessus du décollage : au-delà de 120 m (catégorie ouverte)`);
  if (wps.some((w) => w.z - T.z < 2)) alertes.push('Des points sont sous le niveau du décollage : vérifier l\'altitude du point de décollage');
  const parts = Math.ceil(wps.length / P.maxParMission);
  if (parts > 1) alertes.push(`${wps.length} points : mission découpée en ${parts} fichiers (${P.maxParMission} points max chacun)`);
  return {
    P, wps, groups: order.map((g) => ({ nom: g.nom, type: g.type, n: g.pts.reduce((n, p) => n + (p.photo ? (p.shots ? p.shots.length : 1) : 0), 0) })), zSafe,
    stats: { dF, gsdF: gsdAt(dF), photos, points: wps.length, longueur: L, duree, hMax, parts, batteries: Math.ceil(duree / (25 * 60)) },
    alertes,
  };
}

// découpe en missions de N points : chaque partie repart du haut
export function split(wps, n, zSafe) {
  if (wps.length <= n) return [wps];
  const out = [];
  let i = 0;
  while (i < wps.length) {
    const part = wps.slice(i, i + n - 2);
    const a = part[0], b = part[part.length - 1];
    const head = a.z < zSafe ? [{ ...a, z: zSafe, photo: false, transit: true }] : [];
    const tail = b.z < zSafe ? [{ ...b, z: zSafe, photo: false, transit: true }] : [];
    out.push([...head, ...part, ...tail]);
    i += n - 2;
  }
  return out;
}
