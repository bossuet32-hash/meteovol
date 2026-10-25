"""Récupère les METAR/TAF de France sur aviationweather.gov (NOAA) et écrit data/metar_fr.json.
Exécuté toutes les 30 min par GitHub Actions : sert de secours pour les terrains absents de met.no."""
import json, time, urllib.request

BBOX = "41,-5.5,51.5,10"
UA = {"User-Agent": "meteovol-pwa (GitHub Actions)"}

def get(kind):
    url = f"https://aviationweather.gov/api/data/{kind}?bbox={BBOX}&format=json" + ("&hours=3" if kind == "metar" else "")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

out = {"generated": int(time.time()), "source": "aviationweather.gov", "stations": {}}
for m in sorted(get("metar"), key=lambda x: x.get("obsTime") or 0):
    out["stations"].setdefault(m["icaoId"], {})["metar"] = m.get("rawOb")
for t in get("taf"):
    out["stations"].setdefault(t["icaoId"], {})["taf"] = t.get("rawTAF")
with open("data/metar_fr.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
print(len(out["stations"]), "stations")
