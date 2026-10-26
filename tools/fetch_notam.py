"""NOTAM de France métropolitaine via l'API NMS de la FAA -> data/notam_fr.json.
Exécuté par GitHub Actions ; identifiants dans les secrets du dépôt (NMS_CLIENT_ID, NMS_CLIENT_SECRET),
jamais dans le code. Environnement : NMS_ENV = staging (test) ou prod."""
import base64, json, os, sys, time, urllib.parse, urllib.request

ENV = os.environ.get("NMS_ENV", "staging")  # staging = environnement de test FAA
HOST = {"staging": "https://api-staging.cgifederal-aim.com", "fit": "https://api-fit.cgifederal-aim.com",
        "prod": "https://api-nms.aim.faa.gov"}[ENV]
CID, SEC = os.environ.get("NMS_CLIENT_ID", ""), os.environ.get("NMS_CLIENT_SECRET", "")
if not CID or not SEC:
    print("Secrets NMS_CLIENT_ID / NMS_CLIENT_SECRET absents : rien à faire.")
    sys.exit(0)

def req(url, data=None, headers=None):
    r = urllib.request.Request(url, data=data, headers={"User-Agent": "meteovol-pwa", **(headers or {})})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

auth = base64.b64encode(f"{CID}:{SEC}".encode()).decode()
tok = req(HOST + "/v1/auth/token", data=b"grant_type=client_credentials",
          headers={"Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"})["access_token"]
H = {"Authorization": "Bearer " + tok, "nmsResponseFormat": "GEOJSON"}

# cercles de 100 NM (rayon maximal de l'API) couvrant la métropole et la Corse
centres = []
lat = 42.3
while lat <= 51.2:
    lon = -4.6
    while lon <= 8.4:
        centres.append((round(lat, 2), round(lon, 2)))
        lon += 3.0
    lat += 2.2
centres.append((42.15, 9.1))   # Corse

notams, errors = {}, []
for la, lo in centres:
    q = urllib.parse.urlencode({"latitude": la, "longitude": lo, "radius": 100})
    try:
        js = req(f"{HOST}/nmsapi/v1/notams?{q}", headers=H)
    except Exception as e:
        errors.append(f"{la},{lo}: {e}")
        time.sleep(1)
        continue
    for f in (js.get("data") or {}).get("geojson") or []:
        n = ((f.get("properties") or {}).get("coreNOTAMData") or {}).get("notam") or {}
        if not n.get("id"):
            continue
        icao = [t for t in ((f.get("properties") or {}).get("coreNOTAMData") or {}).get("notamTranslation") or [] if t.get("type") == "ICAO"]
        notams[n["id"]] = {
            "id": n["id"], "num": f'{n.get("series", "")}{n.get("number", "")}', "loc": n.get("icaoLocation") or n.get("location"),
            "fir": n.get("affectedFir"), "q": n.get("selectionCode"), "from": n.get("effectiveStart"), "to": n.get("effectiveEnd"),
            "est": n.get("estimated"), "sched": n.get("schedule"), "lo": n.get("lowerLimit"), "up": n.get("upperLimit"),
            "fl": [n.get("minimumFl"), n.get("maximumFl")], "coord": n.get("coordinates"), "r": n.get("radius"),
            "text": n.get("text"), "icao": icao[0].get("formattedText") if icao else None, "geom": f.get("geometry"),
        }
    time.sleep(1)

import re

def dms(tok):
    """« 432906N » / « 0012627W » / « 4323N » -> degrés décimaux"""
    m = re.match(r"^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)?([NSEW])$", tok)
    if not m:
        return None
    v = int(m.group(1)) + int(m.group(2)) / 60 + (float(m.group(3)) / 3600 if m.group(3) else 0)
    return -v if m.group(4) in "SW" else v

def qcentre(c):
    m = re.match(r"^(\d{4}[NS])(\d{5}[EW])$", c or "")
    return (dms(m.group(1)), dms(m.group(2))) if m else None

def polygon(text):
    pts = re.findall(r"(\d{6}(?:\.\d+)?[NS])\s*(\d{7}(?:\.\d+)?[EW])", text or "")
    ring = [[round(dms(b), 5), round(dms(a), 5)] for a, b in pts]
    return ring if len(ring) >= 3 else None

def point(text):
    m = re.search(r"PSN\s*:?\s*(\d{6}(?:\.\d+)?[NS])\s*(\d{7}(?:\.\d+)?[EW])", text or "")
    return (dms(m.group(1)), dms(m.group(2))) if m else None

KEEP = ("QR", "QW", "QOB")      # zones réglementées/temporaires, avertissements (drones, parachutage, voltige…), obstacles
out_list = []
for v in notams.values():
    if not ((v.get("fir") or "").startswith("LF") or (v.get("loc") or "").startswith("LF")):
        continue
    q = v.get("q") or ""
    if not q.startswith(KEEP):
        continue
    fl = v.get("fl") or [None, None]
    if fl[0] and str(fl[0]).isdigit() and int(fl[0]) > 10:      # commence au-dessus du FL010 : sans effet pour un drone
        continue
    txt = (v.get("text") or "").replace("&apos;", "'").replace("&quot;", '"').replace("\r\n", "\n").strip()
    c = point(txt) or qcentre(v.get("coord"))
    if not c:
        continue
    rr = v.get("r")
    e = {"id": v["id"], "num": v["num"], "loc": v.get("loc"), "q": q, "from": v.get("from"), "to": v.get("to"),
         "sched": v.get("sched"), "lo": v.get("lo"), "up": v.get("up"), "lat": round(c[0], 5), "lon": round(c[1], 5),
         "r": float(rr) if rr and str(rr).replace(".", "").isdigit() else None, "text": txt[:900]}
    poly = polygon(txt)
    if poly:
        e["poly"] = poly
    out_list.append(e)
out = {"generated": int(time.time()), "env": ENV, "count_all": len(notams), "notams": out_list}
with open("data/notam_fr.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
print(f"{ENV} : {len(centres)} cercles, {len(notams)} NOTAM reçus, {len(out_list)} retenus pour les drones, {len(errors)} erreur(s)")
for e in errors[:5]:
    print("  ", e)
firs = {}
for v in notams.values():
    firs[v.get("fir")] = firs.get(v.get("fir"), 0) + 1
print("FIR :", sorted(firs.items(), key=lambda x: -x[1])[:12])
