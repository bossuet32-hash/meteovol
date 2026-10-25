// Navigation entre onglets, réglages, service worker.
import { h, fill, $, $$, settings, saveSettings, pickPlace, toast } from './util.js';
import * as meteo from './meteo.js';
import * as bulletin from './bulletin.js';
import * as zones from './zones.js';
import * as mission from './mission.js';

const TABS = {
  meteo: { label: 'Météo', icon: '✈︎', mod: meteo },
  bulletin: { label: 'Bulletin', icon: '☁︎', mod: bulletin },
  zones: { label: 'Zones', icon: '⬡', mod: zones },
  missions: { label: 'Missions', icon: '▤', mod: mission },
  reglages: { label: 'Réglages', icon: '⚙︎', mod: { render: settingsView } },
};

async function settingsView(root) {
  const S = settings();
  const ad = await meteo.aerodromes();
  const st = h('input', { value: (S.stations || []).join(' '), placeholder: 'vide = automatique (ex. LFBO LFBT LFCR)', autocapitalize: 'characters' });
  fill(root, 
    h('section', { class: 'card' },
      h('div', { class: 'lbl' }, 'Lieu par défaut (météo et bulletin)'),
      h('div', { class: 'row space' }, h('b', {}, S.site.name), h('button', { class: 'btn small', onclick: async () => { const p = await pickPlace(); if (p) { saveSettings({ site: p, zonesSite: null }); settingsView(root); } } }, 'Changer…')),
      h('div', { class: 'lbl' }, 'Aérodromes METAR/TAF (codes OACI)'), st,
      h('p', { class: 'small muted' }, `Vide : les 4 terrains les plus proches qui publient un METAR. ${ad.length} aérodromes connus.`),
      h('label', {}, h('div', { class: 'lbl' }, 'Vent / rafales max de la machine (km/h)'), h('input', { type: 'number', inputmode: 'numeric', min: 10, max: 90, value: S.maxWind, id: 'mw' })),
      h('label', {}, h('div', { class: 'lbl' }, 'Rayon d\'analyse des zones (km)'), h('input', { type: 'number', inputmode: 'numeric', min: 2, max: 25, value: S.radiusKm, id: 'rk' })),
      h('button', { class: 'btn wide', onclick: () => {
        const ids = st.value.toUpperCase().split(/[\s,;]+/).filter((x) => /^[A-Z]{4}$/.test(x));
        saveSettings({ stations: ids, maxWind: Math.max(10, +$('#mw').value || 38), radiusKm: Math.min(25, Math.max(2, +$('#rk').value || 10)) });
        toast('Réglages enregistrés');
      } }, 'Enregistrer')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'Hors ligne'),
      h('p', { class: 'small' }, 'L\'app, les zones SIA/ZICAD et les dernières données consultées restent disponibles sans réseau. Pour préparer un vol en zone blanche, ouvrez Météo, Bulletin et Zones avec du réseau avant de partir.'),
      h('button', { class: 'btn small', onclick: async () => {
        const m = await zones.meta();
        const c = await caches.open('mv-data');
        let n = 0;
        for (const t of m.tile_list || []) { try { await c.add(`data/zones/${t}.json`); n++; } catch { /* */ } }
        toast(`${n} tuiles de zones mises en cache`);
      } }, 'Télécharger toutes les zones de France pour le hors ligne')),
    h('section', { class: 'card' }, h('div', { class: 'lbl' }, 'À propos'),
      h('p', { class: 'small' }, 'Météo vol · compagnon de terrain du télépilote. Données : met.no (METAR/TAF), Open-Meteo / Météo-France, RainViewer, SIA (zones UAS ED-269), SGDSN (ZICAD), IGN Géoplateforme, INPN, OpenStreetMap, NOAA SWPC. Outil d\'aide : ne remplace pas les sources officielles.'),
      h('p', { class: 'small muted', id: 'ver' }, '')));
  try { const m = await zones.meta(); $('#ver').textContent = `Zones SIA : ${m.source} · AIRAC ${m.airac} · ${m.zones} zones dont ${m.zicad} ZICAD`; } catch { /* */ }
}

let current = null;
async function go(name) {
  if (!TABS[name]) name = 'meteo';
  current = name;
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#title').textContent = TABS[name].label;
  const root = $('#view');
  root.scrollTop = 0; window.scrollTo(0, 0);
  try { localStorage.setItem('mv.tab', name); } catch { /* */ }
  history.replaceState(null, '', '#' + name);
  try { await TABS[name].mod.render(root); } catch (e) { fill(root, h('p', { class: 'warn-txt' }, 'Erreur : ' + e.message)); console.error(e); }
}

function init() {
  const bar = $('.tabbar');
  for (const [k, t] of Object.entries(TABS)) bar.append(h('button', { 'data-tab': k, onclick: () => go(k) }, h('span', { class: 'ti' }, t.icon), h('span', {}, t.label)));
  $('#refresh').onclick = () => go(current);
  let start = location.hash.slice(1);
  if (!TABS[start]) { try { start = localStorage.getItem('mv.tab'); } catch { start = null; } }
  go(start || 'meteo');
  const net = () => document.body.classList.toggle('offline', !navigator.onLine);
  addEventListener('online', net); addEventListener('offline', net); net();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
