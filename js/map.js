// Couches cartographiques IGN (Géoplateforme) pour Leaflet.
const WMTS = (layer, fmt = 'image/png', tms = 'PM_0_19') =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=${fmt}&TILEMATRIXSET=${tms}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

export const IGN_PLAN = WMTS('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2');
export const IGN_ORTHO = WMTS('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg');
export const IGN_LIMITES = WMTS('LIMITES_ADMINISTRATIVES_EXPRESS.LATEST', 'image/png', 'PM_6_16');

const ATTR = '© <a href="https://www.ign.fr/">IGN</a> Géoplateforme';

export function ignLayer(opts = {}) {
  return L.tileLayer(IGN_PLAN, { maxZoom: 19, maxNativeZoom: 19, attribution: ATTR, crossOrigin: 'anonymous', ...opts });
}
export function orthoLayer() {
  return L.tileLayer(IGN_ORTHO, { maxZoom: 19, attribution: ATTR, crossOrigin: 'anonymous' });
}
export function limitesLayer() {
  return L.tileLayer(IGN_LIMITES, { maxZoom: 19, minZoom: 6, maxNativeZoom: 16, opacity: 0.9, attribution: ATTR, crossOrigin: 'anonymous', zIndex: 5 });
}
