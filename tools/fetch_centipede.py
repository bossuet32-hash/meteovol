"""Liste des bases RTK du réseau Centipède (WFS Lizmap map.centipede-rtk.org) -> data/centipede.json (allégé).
Exécuté par GitHub Actions (la carte Centipède n'autorise pas l'appel direct depuis une page web).
Usage local : python3 tools/fetch_centipede.py [fichier.geojson]"""
import http.cookiejar, json, re, sys, time, urllib.request
from datetime import datetime

URL = ("https://map.centipede-rtk.org/index.php/lizmap/service/?repository=cent&project=centipede"
       "&SERVICE=WFS&REQUEST=GetFeature&VERSION=1.0.0&TYPENAME=basesrtk&OUTPUTFORMAT=GeoJSON")

if len(sys.argv) > 1:
    js = json.load(open(sys.argv[1], encoding="utf-8"))
else:
    js, errs = None, []
    UAS = ["meteovol-pwa (GitHub Actions; +https://bossuet32-hash.github.io/meteovol/)",
           "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"]
    MAP = "https://map.centipede-rtk.org/index.php/view/map/?repository=cent&project=centipede"
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    for url in (URL, URL.replace("VERSION=1.0.0", "VERSION=1.1.0")):
        for ua in UAS:
            try:
                # ouvrir d'abord la carte (cookie de session Lizmap), puis la requête WFS avec Referer
                try:
                    opener.open(urllib.request.Request(MAP, headers={"User-Agent": ua}), timeout=60).read()
                except Exception:
                    pass
                req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json,*/*", "Referer": MAP})
                with opener.open(req, timeout=120) as r:
                    js = json.loads(r.read().decode("utf-8"))
                break
            except Exception as ex:
                body = ""
                if hasattr(ex, "read"):
                    try:
                        b = ex.read().decode("utf-8", "replace")
                        m = re.search(r"<ServiceException[^>]*>(.*?)</ServiceException>", b, re.S)
                        body = (m.group(1) if m else b[:200]).strip().replace("\n", " ")
                    except Exception:
                        pass
                errs.append("%s (%s) %s" % (type(ex).__name__, ex, body))
                time.sleep(3)
        if js:
            break
    if not js:
        # on garde la liste précédente ; échec seulement si elle a plus de 7 jours
        try:
            age = time.time() - json.load(open("data/centipede.json", encoding="utf-8"))["generated"]
        except Exception:
            age = 1e9
        print("::warning title=Centipède injoignable::" + " | ".join(errs)[:900])
        sys.exit(1 if age > 7 * 86400 else 0)

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
