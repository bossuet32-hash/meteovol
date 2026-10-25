"""Construit data/zones/ (tuiles 2°) à partir du dernier ZIP SIA et du ZIP/KML ZICAD présents dans sources/."""
import glob, json, math, os, shutil, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
sia = sorted(glob.glob(os.path.join(root, "sources", "UASZones_*.zip")) + glob.glob(os.path.join(root, "sources", "UASZones_*.json")))
zic = sorted(glob.glob(os.path.join(root, "sources", "ZICAD*.zip")) + glob.glob(os.path.join(root, "sources", "*.kml")))
if not sia:
    sys.exit("Aucun fichier UASZones_*.zip dans sources/")
tmp = tempfile.mkdtemp()
cmd = [sys.executable, os.path.join(here, "kobo_zones_prep.py"), sia[-1]] + ([zic[-1]] if zic else []) + ["-o", tmp]
subprocess.run(cmd, check=True)
zones = {}
for f in glob.glob(tmp + "/t_*.json"):
    for z in json.load(open(f, encoding="utf-8")):
        zones[z["id"]] = z
meta = json.load(open(tmp + "/meta.json", encoding="utf-8"))
T = 2.0
tiles = {}
for z in zones.values():
    b = z["bbox"]
    for i in range(math.floor(b[0] / T), math.floor(b[2] / T) + 1):
        for j in range(math.floor(b[1] / T), math.floor(b[3] / T) + 1):
            tiles.setdefault((i, j), []).append(z)
out = os.path.join(root, "data", "zones")
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
for (i, j), zs in tiles.items():
    with open(f"{out}/t_{i}_{j}.json", "w", encoding="utf-8") as fh:
        json.dump(zs, fh, ensure_ascii=False, separators=(",", ":"))
meta.update(tile_deg=T, tiles=len(tiles), tile_list=sorted(f"t_{i}_{j}" for i, j in tiles))
with open(out + "/meta.json", "w", encoding="utf-8") as fh:
    json.dump(meta, fh, ensure_ascii=False, indent=1)
shutil.rmtree(tmp)
print("Zones :", meta["zones"], "· AIRAC", meta["airac"], "·", len(tiles), "tuiles")
