"""Liste des bases RTK du réseau Centipède (WFS Lizmap map.centipede-rtk.org) -> data/centipede.json (allégé).
Exécuté par GitHub Actions (la carte Centipède n'autorise pas l'appel direct depuis une page web).
Usage local : python3 tools/fetch_centipede.py [fichier.geojson]"""
import json, sys, time, urllib.request
from datetime import datetime

URL = ("https://map.centipede-rtk.org/index.php/lizmap/service/?repository=cent&project=centipede"
       "&SERVICE=WFS&REQUEST=GetFeature&VERSION=1.0.0&TYPENAME=basesrtk&OUTPUTFORMAT=GeoJSON")

if len(sys.argv) > 1:
    js = json.load(open(sys.argv[1], encoding="utf-8"))
else:
    req = urllib.request.Request(URL, headers={"User-Agent": "meteovol-pwa (GitHub Actions)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        js = json.loads(r.read().decode("utf-8"))

def ts(s):
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None

bases = []
for f in js.get("features", []):
    p, g = f.get("properties") or {}, f.get("geometry") or {}
    if g.get("type") != "Point" or not p.get("mp"):
        continue
    lon, lat = g["coordinates"][:2]
    bases.append({
        "mp": p["mp"], "lat": round(lat, 6), "lon": round(lon, 6),
        "alt": round(p["altitude"], 2) if isinstance(p.get("altitude"), (int, float)) else None,
        "on": p.get("ping") == "active", "chk": ts(p.get("check_activite") or ""),
        "rx": (p.get("recepteur") or p.get("receiver") or "").strip(),
        "ant": (p.get("type_antenne") or p.get("antenne") or "").strip(),
        "gnss": (p.get("systeme") or "").strip(), "freq": (p.get("frequence") or "").strip(),
        "cc": p.get("country"), "net": p.get("network"),
    })
out = {"generated": int(time.time()), "source": "map.centipede-rtk.org (basesrtk)", "bases": bases}
with open("data/centipede.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
print(len(bases), "bases,", sum(b["on"] for b in bases), "actives")
