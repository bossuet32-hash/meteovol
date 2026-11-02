import json, urllib.request, re, os
os.makedirs("explore/out", exist_ok=True)
def get(url, name, binary=False, n=None):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "meteovol", "Origin": "https://bossuet32-hash.github.io"})
        with urllib.request.urlopen(req, timeout=90) as r:
            b = r.read()
            hdr = {k: v for k, v in r.headers.items() if k.lower().startswith("access-control") or k.lower() == "content-type"}
        open("explore/out/" + name, "wb").write(b if n is None else b[:n])
        return hdr, b
    except Exception as ex:
        open("explore/out/" + name + ".err", "w").write(repr(ex))
        return None, b""
W = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0"
res = {}
res["batiment"], _ = get(W + "&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&SRSNAME=CRS:84&OUTPUTFORMAT=application/json&COUNT=20&BBOX=1.4420,43.6040,1.4460,43.6060,CRS:84", "batiment.json")
get(W + "&REQUEST=DescribeFeatureType&TYPENAMES=BDTOPO_V3:batiment", "batiment_describe.xml")
h, b = get("https://data.geopf.fr/wms-r/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0", "wmsr_caps.xml")
names = re.findall(rb"<Name>([^<]*(?:LIDAR|MNS|MNH|ELEVATION)[^<]*)</Name>", b, re.I)
open("explore/out/wmsr_lidar_layers.txt", "wb").write(b"\n".join(sorted(set(names))))
h, b = get("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetCapabilities", "wmts_caps.xml")
names = re.findall(rb"<ows:Identifier>([^<]*(?:LIDAR|MNS|MNH|ELEVATION)[^<]*)</ows:Identifier>", b, re.I)
open("explore/out/wmts_lidar_layers.txt", "wb").write(b"\n".join(sorted(set(names))))
res["alti"], _ = get("https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=1.444&lat=43.605&resource=ign_rge_alti_wld&zonly=true", "alti.json")
get("https://data.geopf.fr/altimetrie/resources?format=json", "alti_resources.json")
get("https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=1.444&lat=43.605&resource=ign_lidar_hd_mns&zonly=true", "alti_mns_guess.json")
json.dump(res, open("explore/out/headers.json", "w"), indent=1)
