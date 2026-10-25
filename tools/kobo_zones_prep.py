#!/usr/bin/env python3
"""
Kobo · préparation des zones de vol (SIA ED-269 + ZICAD)
=======================================================

À lancer une fois par cycle AIRAC (28 jours), sur le PC :

    python kobo_zones_prep.py  UASZones_xxxx.zip  [zicad.kml]  -o G:/Mission/00_Permanent/zones_uas

(ou depuis la console Python de QGIS / l'OSGeo4W Shell ; aucune bibliothèque externe nécessaire)

Entrées
  - le ZIP (ou le JSON) « Données zones géographiques UAS » du SIA, au format EUROCAE ED-269
  - facultatif : le KML des ZICAD (data.gouv.fr, IGN / SGDSN)

Sortie : un dossier à copier sur la liseuse
  zones_uas/
    meta.json            date AIRAC, sources, nombre de zones
    t_<i>_<j>.json       tuiles de 0,5° x 0,5° (zones simplifiées touchant la tuile)
"""
import argparse
import io
import json
import math
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

TILE = 0.5          # degrés
SIMPLIFY_M = 15.0   # tolérance de simplification (m)


# --------------------------------------------------------------------------- lecture tolérante
def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, "", []):
            return d[k]
    return default


def load_ed269(path):
    """Renvoie (liste de features, nom du fichier, date d'effet)."""
    name = os.path.basename(path)
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            js = [n for n in z.namelist() if n.lower().endswith(".json")]
            if not js:
                raise SystemExit("Aucun JSON dans le ZIP")
            name = os.path.basename(js[0])
            raw = z.read(js[0])
    else:
        with open(path, "rb") as fh:
            raw = fh.read()
    data = json.loads(raw.decode("utf-8-sig"))
    feats = data
    if isinstance(data, dict):
        feats = first(data, "features", "UASZoneList", "uasZoneList", "zones", default=[])
    m = re.search(r"UASZones_(\d{4}-\d{2}-\d{2})_(\d{12})", name)
    eff = m.group(1) if m else None
    return as_list(feats), name, eff


def to_m(v, uom):
    if v is None:
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    u = (uom or "M").upper()
    if u in ("FT", "FEET"):
        return v * 0.3048
    if u in ("FL",):
        return v * 30.48
    return v


def lonlat(p):
    """Point -> (lon, lat) ; accepte [lon, lat], {lon, lat}, {longitude, latitude}."""
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        return float(p[0]), float(p[1])
    if isinstance(p, dict):
        lo = first(p, "lon", "longitude", "lng", "x")
        la = first(p, "lat", "latitude", "y")
        if lo is not None and la is not None:
            return float(lo), float(la)
    raise ValueError("point illisible : %r" % (p,))


def projection(hp):
    """horizontalProjection ED-269 -> dict {t: 'P', rings} ou {t: 'C', c, r} (rayon en m)."""
    if not isinstance(hp, dict):
        return None
    t = (hp.get("type") or "").lower()
    if t == "circle":
        c = first(hp, "center", "centre")
        r = to_m(first(hp, "radius"), first(hp, "uom", "uomRadius", default="M"))
        if c is None or r is None:
            return None
        lo, la = lonlat(c)
        return {"t": "C", "c": [round(lo, 6), round(la, 6)], "r": round(r, 1)}
    coords = hp.get("coordinates")
    if t == "polygon" and coords:
        rings = [[lonlat(p) for p in ring] for ring in coords]
        return {"t": "P", "rings": rings}
    if t == "multipolygon" and coords:
        rings = [[lonlat(p) for p in ring] for poly in coords for ring in poly]
        return {"t": "P", "rings": rings}
    return None


# --------------------------------------------------------------------------- géométrie
def simplify(ring, tol_m):
    """Douglas-Peucker en mètres (projection équirectangulaire locale)."""
    if len(ring) < 5:
        return ring
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    kx, ky = 111320 * math.cos(lat0), 110540
    pts = [(p[0] * kx, p[1] * ky) for p in ring]

    def dp(i, j, keep):
        ax, ay = pts[i]; bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1, None
        for k in range(i + 1, j):
            px, py = pts[k]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, bi = d, k
        if best > tol_m and bi is not None:
            keep[bi] = True
            dp(i, bi, keep); dp(bi, j, keep)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    sys.setrecursionlimit(max(10000, len(pts) * 2))
    dp(0, len(pts) - 1, keep)
    out = [ring[i] for i in range(len(ring)) if keep[i]]
    return out if len(out) >= 4 else ring


def geom_bbox(g):
    if g["t"] == "C":
        lo, la = g["c"]
        dla = g["r"] / 110540
        dlo = g["r"] / (111320 * max(0.2, math.cos(math.radians(la))))
        return [lo - dlo, la - dla, lo + dlo, la + dla]
    xs = [p[0] for r in g["rings"] for p in r]
    ys = [p[1] for r in g["rings"] for p in r]
    return [min(xs), min(ys), max(xs), max(ys)]


def merge_bbox(a, b):
    if a is None:
        return b
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


# --------------------------------------------------------------------------- types de zones
TYPE_RULES = [
    (r"\[ZICAD\]", "ZICAD"),
    (r"\bCTR\b", "CTR"), (r"\bTMA\b", "TMA"), (r"\bCTA\b", "CTA"), (r"\bSIV\b", "SIV"),
    (r"\bZIT\b", "ZIT"), (r"\[P ?\d", "P"), (r"\[R ?\d", "R"), (r"\[D ?\d", "D"),
    (r"\[SUR ?\d", "SUR"), (r"\[PRN ?\d", "RN"), (r"\[SEBAH", "SETBA"),
    (r"RTBA", "RTBA"), (r"VOLTAC", "VOLTAC"), (r"\bSETBA\b|\bLF-?R ?\d+ ?[A-Z]? ?SETBA", "SETBA"),
    (r"H[EÉ]LI|HELI|\bHEL\b|H[EÉ]LISTATION|HELIPORT", "HEL"),
    (r"\bAD\b|A[EÉ]RODROME|AEROPORT|A[EÉ]ROPORT|\[LF[A-Z]{2}\]", "AD"),
    (r"PARC NATIONAL|\bPN\b", "PN"), (r"R[EÉ]SERVE", "RN"),
    (r"\bAER\b|A[EÉ]ROMOD", "AER"), (r"\bAP\b|ACTIVIT[EÉ] PARTICULI", "AP"),
    (r"BALIS", "BAL"), (r"MANOEUVRE|MANŒUVRE|MILITAIRE", "MIL"),
]
TYPE_LABEL = {
    "ZICAD": "ZICAD (prise de vue interdite)", "CTR": "zone de contrôle", "TMA": "région de contrôle terminale",
    "CTA": "région de contrôle", "SIV": "secteur d'information de vol", "ZIT": "zone interdite temporaire",
    "P": "zone interdite", "R": "zone réglementée", "D": "zone dangereuse", "RTBA": "réseau très basse altitude",
    "VOLTAC": "secteur VOLTAC", "SETBA": "secteur entraînement basse altitude", "HEL": "abords d'hélistation",
    "AD": "abords d'aérodrome", "PN": "parc national", "RN": "réserve naturelle", "AER": "aéromodélisme",
    "AP": "activité particulière", "BAL": "site à balisage basse altitude", "MIL": "zone militaire", "SUR": "site sensible", "AUTRE": "zone",
}


def zone_type(name, reason, other):
    txt = " ".join(str(x) for x in (name, other) if x).upper()
    for rx, t in TYPE_RULES:
        if re.search(rx, txt):
            return t
    if "NATURE" in str(reason).upper():
        return "RN"
    return "AUTRE"


LOWER = {"DE", "DU", "DES", "LA", "LE", "LES", "SUR", "SOUS", "EN", "ET", "AU", "AUX"}
KEEP = {"CTR", "TMA", "CTA", "SIV", "VOLTAC", "SETBA", "SEBAH", "PHG", "GIH", "CTN", "ZENA", "MED", "EDF", "SNCF",
        "CEA", "CNPE", "CHU", "UHSA", "EPM", "ALAT", "RTBA", "ULM", "OTAN", "BA", "CD", "CP", "MA", "SA", "ZI"}


def title_fr(txt):
    """« TOULOUSE BLAGNAC » -> « Toulouse Blagnac » (sigles et codes conservés)."""
    def word(w, first):
        if "-" in w:
            ps = w.split("-")
            return "-".join(word(x, first and i == 0) if x else x for i, x in enumerate(ps))
        if not w.isupper() or any(ch.isdigit() for ch in w) or re.fullmatch(r"LF[A-Z]{2}|FM[A-Z]{2}|T[FX][A-Z]{2}", w):
            return w
        if w in KEEP:
            return w
        if w in LOWER and not first:
            return w.lower()
        if len(w) <= 2 and not first:
            return w
        return w[:1] + w[1:].lower()
    parts = re.split(r"(\s+|[()/])", txt)
    out, first = [], True
    for t in parts:
        if t and not re.fullmatch(r"\s+|[()/]", t):
            m = re.match(r"^([DL]')(.+)$", t)
            if m:
                out.append(m.group(1).lower() + word(m.group(2), False))
            else:
                out.append(word(t, first))
            first = False
        else:
            out.append(t)
    return "".join(out).strip()


def clean_name(name):
    """Nom lisible + nom court + clé de regroupement (aérodromes : une zone par terrain, toutes pistes)."""
    if not name:
        return "?", "?", None, None
    n = re.sub(r"^\[[A-Za-z]{2}(-[A-Z]{2})?\]\s*", "", str(name)).strip()
    m = re.match(r"^Piste\s+(\S+)\s+a[ée]rodrome\s+(.+?)\s+([A-Z]{4})$", n, re.I)
    if m:
        nm = m.group(3) + " " + title_fr(m.group(2))
        return nm, nm, "AD-" + m.group(3), m.group(1)
    m = re.match(r"^\[([^\]]+)\]\s*(.*)$", n)
    if m:
        code, rest = m.group(1).strip(), m.group(2).strip()
        if re.match(r"Aer\b", code, re.I):
            nm = "Aéromodélisme " + title_fr(rest)
        elif re.match(r"(SUR|AP|PRN)\b", code):
            nm = title_fr(rest) or code
        elif re.match(r"SETBA Secteur", code, re.I):
            nm = "SETBA " + title_fr(code.split("Secteur", 1)[1].strip())
        else:
            nm = (title_fr(code) + (" " + title_fr(rest) if rest else "")).strip()
    else:
        nm = title_fr(n)
    return nm, nm, None, None


AUTH_SHORT = [
    (r"contr[ôo]le de la circulation|service de contr[ôo]le|service du contr[ôo]le", "contrôle aérien"),
    (r"ENR 5\.1", "gestionnaire (AIP ENR 5.1)"), (r"ENR 5\.7", "gestionnaire du site"),
    (r"h[ée]listation", "gestionnaire de l'hélistation"), (r"Responsable de l", "responsable de l'activité"),
    (r"parc national|r[ée]serve naturelle", "gestionnaire de l'espace protégé"),
]


def auth_short(a):
    for rx, lab in AUTH_SHORT:
        if a and re.search(rx, a, re.I):
            return lab
    return (a or "")[:40]


def first_sentence(t, n=90):
    t = re.sub(r"\s+", " ", t or "").strip()
    m = re.match(r"^(.+?[.!])(\s|$)", t)
    t = m.group(1) if m else t
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


def short_cond(ztype, restriction, conds, message, permanent):
    c = " ".join(conds) if isinstance(conds, list) else (conds or "")
    if ztype == "AD":
        txt = "Accord du contrôle aérien ou de l'exploitant"
    elif ztype == "HEL":
        txt = "Accord du gestionnaire de l'hélistation"
    elif ztype in ("CTR", "TMA", "CTA"):
        txt = "Au-dessus du plancher : accord du contrôle aérien"
    elif ztype in ("AER", "AP"):
        txt = "Réservé aux membres de l'association (protocole)"
    elif re.search(r"900 ?G", c, re.I):
        txt = "Libre sous 900 g ; au-delà, notifier l'autorité"
    elif ztype == "P":
        txt = "Vol interdit"
    elif ztype in ("R", "D") and restriction == "PROHIBITED":
        txt = "Interdit sauf accord du gestionnaire (AIP ENR 5.1)"
    elif ztype == "SUR":
        txt = "Survol interdit sauf accord du gestionnaire"
    else:
        txt = first_sentence(message or c)
    if permanent is False and ztype in ("R", "D", "P", "ZIT"):
        txt = "Non permanente · " + txt
    return txt


# --------------------------------------------------------------------------- conversion
def convert_feature(f):
    name = first(f, "name", "Name", default="?")
    reason = first(f, "reason", default="")
    if isinstance(reason, list):
        reason = "|".join(str(r) for r in reason)
    other = first(f, "otherReasonInfo", default="")
    auth = as_list(first(f, "zoneAuthority", "authority", default=[]))
    a0 = auth[0] if auth and isinstance(auth[0], dict) else {}
    appl = as_list(first(f, "applicability", default=[]))
    perm = None
    for a in appl:
        if isinstance(a, dict) and a.get("permanent") not in (None, ""):
            perm = str(a.get("permanent")).upper() == "YES"
    vols = []
    bbox = None
    for g in as_list(first(f, "geometry", "airspaceVolume", default=[])):
        if not isinstance(g, dict):
            continue
        uom = first(g, "uomDimensions", "uom", default="M")
        proj = projection(first(g, "horizontalProjection", "projection", default=None))
        if proj is None:
            continue
        if proj["t"] == "P":
            proj["rings"] = [[[round(p[0], 6), round(p[1], 6)] for p in simplify(r, SIMPLIFY_M)] for r in proj["rings"]]
        v = {
            "lo": to_m(first(g, "lowerLimit", "lower", default=0), uom),
            "loRef": first(g, "lowerVerticalReference", "lowerReference", default="AGL"),
            "up": to_m(first(g, "upperLimit", "upper"), uom),
            "upRef": first(g, "upperVerticalReference", "upperReference", default="AGL"),
            "g": proj,
        }
        vols.append(v)
        bbox = merge_bbox(bbox, geom_bbox(proj))
    if not vols:
        return None
    ztype = zone_type(name, reason, other)
    nm, short, group, runway = clean_name(name)
    restriction = str(first(f, "restriction", default="CONDITIONAL")).upper()
    conds = first(f, "restrictionConditions", default="")
    message = first(f, "message", default="")
    return {
        "id": first(f, "identifier", "id", default=name),
        "group": group, "runway": runway,
        "cond": short_cond(ztype, restriction, conds, message, perm),
        "authShort": auth_short(a0.get("name")),
        "name": nm,
        "type": ztype,
        "typeLabel": TYPE_LABEL.get(ztype, "zone"),
        "restriction": restriction,
        "conditions": conds,
        "reason": reason,
        "other": other,
        "message": message,
        "permanent": perm,
        "auth": {k: a0.get(k) for k in ("name", "service", "email", "phone", "siteURL", "purpose", "intervalBefore", "contactName")
                 if a0.get(k)},
        "vols": vols,
        "bbox": [round(x, 5) for x in bbox],
    }


def load_zicad(path):
    """KML (ou ZIP contenant le KML) des ZICAD -> zones au même format."""
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            kml = [n for n in zf.namelist() if n.lower().endswith(".kml")]
            if not kml:
                raise SystemExit("Aucun fichier .kml dans " + path)
            data = zf.read(kml[0])
    else:
        with open(path, "rb") as fh:
            data = fh.read()
    root = ET.fromstring(data)
    K = "{http://www.opengis.net/kml/2.2}"
    zones = []
    for n, pm in enumerate(root.iter(K + "Placemark"), 1):
        attrs = {sd.get("name"): (sd.text or "").strip() for sd in pm.iter(K + "SimpleData")}
        site = attrs.get("site") or (pm.findtext(K + "name") or "").strip()
        comm = attrs.get("comm", "").title()
        nm = "ZICAD " + (title_fr(site) if site else "zone")
        if comm and comm.upper() not in (site or "").upper():
            nm += " (" + comm + ")"
        desc = (pm.findtext(K + "description") or "").strip()
        msg = []
        if attrs.get("ministere"):
            msg.append(attrs["ministere"].capitalize())
        if attrs.get("dateeffet"):
            msg.append("en vigueur depuis le " + attrs["dateeffet"].replace("-", "/"))
        if desc:
            msg.append(re.sub(r"<[^>]+>", " ", desc))
        rings = []
        for c in pm.iter(K + "coordinates"):
            pts = []
            for tok in (c.text or "").split():
                parts = tok.split(",")
                if len(parts) >= 2:
                    pts.append([round(float(parts[0]), 6), round(float(parts[1]), 6)])
            if len(pts) >= 4:
                rings.append(simplify(pts, SIMPLIFY_M))
        if not rings:
            continue
        g = {"t": "P", "rings": rings}
        zones.append({
            "id": "ZICAD-" + (attrs.get("area") or attrs.get("fid") or str(n)), "name": nm,
            "cond": "Dérogation possible : démarche en ligne « dérogation ZICAD »", "authShort": "SGDSN",
            "type": "ZICAD", "typeLabel": TYPE_LABEL["ZICAD"],
            "restriction": "PROHIBITED",
            "conditions": "Captation de vues aériennes interdite (arrêté du 24 juin 2024). "
                          "Dérogation : démarche « dérogation ZICAD » sur demarche.numerique.gouv.fr",
            "reason": "OTHER", "other": "Prise de vue interdite", "message": " · ".join(msg)[:300],
            "permanent": True, "auth": {"name": "SGDSN"},
            "vols": [{"lo": 0, "loRef": "AGL", "up": None, "upRef": "AGL", "g": g}],
            "bbox": [round(x, 5) for x in geom_bbox(g)],
        })
    return zones


SEVERITY = {"PROHIBITED": 3, "REQ_AUTHORISATION": 2, "CONDITIONAL": 1}


def merge_groups(zones):
    """Regroupe les zones d'un même aérodrome (une entrée par piste dans le jeu SIA)."""
    out, groups = [], {}
    for z in zones:
        g = z.get("group")
        if not g:
            out.append(z)
            continue
        if g not in groups:
            m = dict(z)
            m["id"], m["vols"], m["runways"] = g, list(z["vols"]), [z["runway"]] if z.get("runway") else []
            groups[g] = m
            out.append(m)
            continue
        m = groups[g]
        m["vols"].extend(z["vols"])
        if z.get("runway"):
            m["runways"].append(z["runway"])
        m["bbox"] = [round(x, 5) for x in merge_bbox(m["bbox"], z["bbox"])]
        if SEVERITY.get(z["restriction"], 0) > SEVERITY.get(m["restriction"], 0):
            m["restriction"] = z["restriction"]
    for m in groups.values():
        m.pop("runway", None)
        if m.get("runways"):
            m["detail"] = ("pistes " if len(m["runways"]) > 1 else "piste ") + ", ".join(m["runways"])
    return out


def tiles_for(bbox):
    i0, j0 = math.floor(bbox[0] / TILE), math.floor(bbox[1] / TILE)
    i1, j1 = math.floor(bbox[2] / TILE), math.floor(bbox[3] / TILE)
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            yield i, j


def main(argv=None):
    ap = argparse.ArgumentParser(description="Prépare les zones UAS (SIA ED-269 + ZICAD) pour la liseuse Kobo")
    ap.add_argument("sia", help="ZIP ou JSON « Données zones géographiques UAS » du SIA")
    ap.add_argument("zicad", nargs="?", help="KML des ZICAD (facultatif)")
    ap.add_argument("-o", "--out", default="zones_uas", help="dossier de sortie (à copier sur la Kobo)")
    ap.add_argument("--france-only", action="store_true", default=True, help="ne garder que la métropole (défaut)")
    args = ap.parse_args(argv)

    feats, fname, eff = load_ed269(args.sia)
    zones, skipped = [], 0
    for f in feats:
        try:
            z = convert_feature(f)
        except Exception as e:  # zone illisible : on la signale et on continue
            z = None
            print("  zone ignorée :", first(f, "name", default="?"), "-", e)
        if z is None:
            skipped += 1
            continue
        if args.france_only:
            b = z["bbox"]
            if b[2] < -6 or b[0] > 10.5 or b[3] < 41 or b[1] > 51.5:
                continue
        zones.append(z)
    zones = merge_groups(zones)
    nz = 0
    if args.zicad:
        zc = load_zicad(args.zicad)
        nz = len(zc)
        zones.extend(zc)

    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if old.startswith("t_") and old.endswith(".json"):
            os.remove(os.path.join(args.out, old))
    tiles = {}
    for idx, z in enumerate(zones):
        for t in tiles_for(z["bbox"]):
            tiles.setdefault(t, []).append(idx)
    for (i, j), idxs in tiles.items():
        with open(os.path.join(args.out, "t_%d_%d.json" % (i, j)), "w", encoding="utf-8") as fh:
            json.dump([zones[k] for k in idxs], fh, ensure_ascii=False, separators=(",", ":"))
    counts = {}
    for z in zones:
        counts[z["type"]] = counts.get(z["type"], 0) + 1
    meta = {"source": fname, "airac": eff, "zones": len(zones), "zicad": nz, "ignored": skipped,
            "tile_deg": TILE, "tiles": len(tiles), "types": counts}
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    size = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    print("Zones : %d (dont %d ZICAD), ignorées : %d, tuiles : %d, %.1f Mo -> %s"
          % (len(zones), nz, skipped, len(tiles), size / 1e6, os.path.abspath(args.out)))
    print("Types :", ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    return meta


if __name__ == "__main__":
    main()
