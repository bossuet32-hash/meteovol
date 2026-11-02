// Missions DJI Fly (KMZ = zip contenant wpmz/template.kml et wpmz/waylines.wpml, format WPML).
// DJI Fly (Mini / Air / Mavic) : espace de noms uav.com, auteur « fly », droneEnumValue 68 par défaut.
// Le KMZ d'une mission factice créée sur la radiocommande peut servir de modèle (valeurs et nom de fichier repris).

const enc = new TextEncoder();
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ---------------------------------------------------------------- écriture zip (sans compression)
export function zip(files, when = new Date()) {
  const time = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const date = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const dir = f.name.endsWith('/');
    const data = dir ? new Uint8Array(0) : (f.bytes || enc.encode(f.text || ''));
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(38, dir ? 0x10 : 0, true); cv.setUint32(42, off, true);
    ch.set(name, 46);
    parts.push(lh, data); central.push(ch);
    off += lh.length + data.length;
  }
  const csize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, csize, true); ev.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.google-earth.kmz' });
}

// ---------------------------------------------------------------- lecture zip (store / deflate)
export async function unzip(buf) {
  const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('fichier KMZ illisible');
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true), csz = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const ds = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    const raw = b.subarray(ds, ds + csz);
    let data;
    if (method === 0) data = raw;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else continue;
    out[name] = new TextDecoder().decode(data);
  }
  return out;
}

// Modèle tiré d'une mission DJI Fly : valeurs du drone et nom de fichier (UUID) à réutiliser
export async function readTemplate(file) {
  const files = await unzip(await file.arrayBuffer());
  const wl = files['wpmz/waylines.wpml'] || Object.entries(files).find(([k]) => k.endsWith('.wpml'))?.[1] || '';
  const get = (tag) => (wl.match(new RegExp(`<wpml:${tag}>([^<]*)</wpml:${tag}>`)) || [])[1];
  const ns = (wl.match(/xmlns:wpml="([^"]+)"/) || [])[1];
  const pts = (wl.match(/<Placemark>/g) || []).length;
  return {
    name: file.name.replace(/\.kmz$/i, ''), droneEnumValue: +get('droneEnumValue') || 68, droneSubEnumValue: +get('droneSubEnumValue') || 0,
    ns: ns || 'http://www.uav.com/wpmz/1.0.2', points: pts,
  };
}

// ---------------------------------------------------------------- WPML
const f7 = (n) => Number(n).toFixed(7);
const f1 = (n) => (Math.round(Number(n) * 10) / 10).toString();
const wrap180 = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };

function missionConfig(m, prof, i) {
  return `${i}<wpml:missionConfig>
${i}  <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
${i}  <wpml:finishAction>goHome</wpml:finishAction>
${i}  <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
${i}  <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
${i}  <wpml:globalTransitionalSpeed>${f1(m.transit)}</wpml:globalTransitionalSpeed>
${i}  <wpml:droneInfo>
${i}    <wpml:droneEnumValue>${prof.droneEnumValue}</wpml:droneEnumValue>
${i}    <wpml:droneSubEnumValue>${prof.droneSubEnumValue}</wpml:droneSubEnumValue>
${i}  </wpml:droneInfo>
${i}</wpml:missionConfig>`;
}

function placemark(w, idx, st, opt) {
  const i = '      ';
  const turn = opt.straight ? 'toPointAndStopWithDiscontinuityCurvature' : 'toPointAndStopWithContinuityCurvature';
  const acts = [];
  let aid = 0;
  if (w.pitch != null && w.pitch !== st.pitch) {
    acts.push(`${i}    <wpml:action>
${i}      <wpml:actionId>${aid++}</wpml:actionId>
${i}      <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
${i}      <wpml:actionActuatorFuncParam>
${i}        <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
${i}        <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
${i}        <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
${i}        <wpml:gimbalPitchRotateAngle>${f1(w.pitch)}</wpml:gimbalPitchRotateAngle>
${i}        <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
${i}        <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
${i}        <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
${i}        <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
${i}        <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
${i}        <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
${i}        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
${i}      </wpml:actionActuatorFuncParam>
${i}    </wpml:action>`);
    st.pitch = w.pitch;
  }
  if (w.photo) {
    acts.push(`${i}    <wpml:action>
${i}      <wpml:actionId>${aid++}</wpml:actionId>
${i}      <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
${i}      <wpml:actionActuatorFuncParam>
${i}        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
${i}      </wpml:actionActuatorFuncParam>
${i}    </wpml:action>`);
  }
  const group = acts.length ? `
${i}  <wpml:actionGroup>
${i}    <wpml:actionGroupId>${idx + 1}</wpml:actionGroupId>
${i}    <wpml:actionGroupStartIndex>${idx}</wpml:actionGroupStartIndex>
${i}    <wpml:actionGroupEndIndex>${idx}</wpml:actionGroupEndIndex>
${i}    <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
${i}    <wpml:actionTrigger>
${i}      <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
${i}    </wpml:actionTrigger>
${acts.join('\n')}
${i}  </wpml:actionGroup>` : '';
  return `${i}<Placemark>
${i}  <Point>
${i}    <coordinates>${f7(w.lon)},${f7(w.lat)}</coordinates>
${i}  </Point>
${i}  <wpml:index>${idx}</wpml:index>
${i}  <wpml:executeHeight>${f1(w.h)}</wpml:executeHeight>
${i}  <wpml:waypointSpeed>${f1(w.speed)}</wpml:waypointSpeed>
${i}  <wpml:waypointHeadingParam>
${i}    <wpml:waypointHeadingMode>smoothTransition</wpml:waypointHeadingMode>
${i}    <wpml:waypointHeadingAngle>${f1(wrap180(w.yaw))}</wpml:waypointHeadingAngle>
${i}    <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
${i}    <wpml:waypointHeadingAngleEnable>1</wpml:waypointHeadingAngleEnable>
${i}    <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
${i}    <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
${i}  </wpml:waypointHeadingParam>
${i}  <wpml:waypointTurnParam>
${i}    <wpml:waypointTurnMode>${turn}</wpml:waypointTurnMode>
${i}    <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
${i}  </wpml:waypointTurnParam>
${i}  <wpml:useStraightLine>${opt.straight ? 1 : 0}</wpml:useStraightLine>${group}
${i}  <wpml:waypointGimbalHeadingParam>
${i}    <wpml:waypointGimbalPitchAngle>${f1(w.pitch ?? 0)}</wpml:waypointGimbalPitchAngle>
${i}    <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
${i}  </wpml:waypointGimbalHeadingParam>
${i}</Placemark>`;
}

// m = { wps: [{lat, lon, h (m / décollage), yaw (°), pitch (°), photo, speed, tag}], speed, transit }
export function buildKmz(m, prof = {}, opt = {}) {
  const P = { ns: 'http://www.uav.com/wpmz/1.0.2', droneEnumValue: 68, droneSubEnumValue: 0, ...prof };
  const o = { straight: true, ...opt };
  const now = Date.now();
  const st = { pitch: null };
  const pms = m.wps.map((w, k) => placemark(w, k, st, o)).join('\n');
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${P.ns}">
  <Document>
    <wpml:author>fly</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfig(m, P, '    ')}
  </Document>
</kml>
`;
  const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${P.ns}">
  <Document>
${missionConfig(m, P, '    ')}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${Math.round(m.length || 0)}</wpml:distance>
      <wpml:duration>${Math.round(m.duration || 0)}</wpml:duration>
      <wpml:autoFlightSpeed>${f1(m.speed)}</wpml:autoFlightSpeed>
${pms}
    </Folder>
  </Document>
</kml>
`;
  return {
    blob: zip([{ name: 'wpmz/' }, { name: 'wpmz/res/' }, { name: 'wpmz/template.kml', text: template }, { name: 'wpmz/waylines.wpml', text: waylines }], new Date(now)),
    template, waylines,
  };
}
