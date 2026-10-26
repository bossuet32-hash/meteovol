// Onglet « Missions » : dossiers mission (lieu, date, notes), checklist, documents, archives PDF. Stockage local (IndexedDB).
import { h, fill, dbAll, dbGet, dbPut, dbDel, pickPlace, toL93, toast, dateFr, hhmm, saveSettings, setSite } from './util.js';
import { report } from './pdf.js';
import { urbanAreas, analyse, peupleeInfo, PEUPLEE_DELAI } from './zones.js';

const DEFAULT_CHECK = [
  'Zones de vol vérifiées (SIA, ZICAD, arrêtés locaux)', 'NOTAM consultés pour la date et le créneau', 'Autorisations / accords obtenus (contrôle, gestionnaire)',
  'Déclaration préalable faite si nécessaire (AlphaTango)', 'Météo et créneau validés (vent, rafales, précipitations)', 'Indice Kp et qualité GNSS / RTK',
  'Batteries drone et radiocommande chargées', 'Hélices, nacelle, cartes mémoire contrôlées', 'Firmware et données de géovigilance à jour',
  'Plan de vol / mission chargé, hauteur et emprise vérifiées', 'Points de contrôle (GCP) préparés', 'Zone de décollage sécurisée, public informé',
  'Documents à bord : attestation, licence, MANEX, assurance', 'Trousse de secours et extincteur',
];
const PERM = 'permanent';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function share(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}
const open = (blob) => { const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); };
const size = (n) => (n > 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1e3)) + ' ko');

async function filesOf(mid) { return (await dbAll('files')).filter((f) => f.mission === mid).sort((a, b) => b.t - a.t); }

function fileList(files, rerender) {
  if (!files.length) return h('p', { class: 'small muted' }, 'Aucun document.');
  return h('ul', { class: 'files' }, ...files.map((f) => h('li', {},
    h('button', { class: 'linklike', onclick: () => open(f.blob) }, (f.kind === 'archive' ? '🗂 ' : '📄 ') + f.name),
    h('span', { class: 'small muted' }, ` ${size(f.blob.size)} · ${dateFr(f.t)}`),
    h('span', { class: 'acts' },
      h('button', { class: 'btn small ghost', onclick: () => share(f.blob, f.name) }, 'Partager'),
      h('button', { class: 'btn small ghost', onclick: async () => { if (confirm(`Supprimer « ${f.name} » ?`)) { await dbDel('files', f.id); rerender(); } } }, 'Suppr.')))));
}

function uploader(mid, rerender) {
  const inp = h('input', { type: 'file', multiple: true, accept: 'application/pdf,image/*,.txt,.csv,.json,.kml,.gpx', hidden: true });
  inp.onchange = async () => {
    for (const f of inp.files) await dbPut('files', { id: uid(), mission: mid, name: f.name, blob: f, t: Date.now(), kind: 'doc' });
    toast(`${inp.files.length} document(s) ajouté(s)`); rerender();
  };
  return h('span', {}, inp, h('button', { class: 'btn small', onclick: () => inp.click() }, '+ Ajouter des documents'));
}

async function missionView(root, id) {
  const ms = await dbGet('missions', id);
  if (!ms) return listView(root);
  const rerender = () => missionView(root, id);
  const save = (patch) => dbPut('missions', Object.assign(ms, patch));
  const files = await filesOf(id);
  const l93 = ms.site ? toL93(ms.site.lat, ms.site.lon) : null;
  const done = ms.check.filter((c) => c.ok).length;
  const busy = h('span', { class: 'small muted' });
  // zone peuplée : date limite de déclaration en préfecture pour la date de la mission
  const peupleBox = h('div', {});
  if (ms.site) (async () => {
    try {
      const ag = await urbanAreas(ms.site.lat, ms.site.lon, 3000);
      if (!ag) return;
      const P = peupleeInfo(analyse([ag], ms.site.lat, ms.site.lon, 3000, null), ms.date);
      if (!P || !P.inside) return;
      fill(peupleBox, h('section', { class: `card peuplee on` },
        h('div', { class: 'lbl' }, 'Zone peuplée : déclaration en préfecture'),
        P.deadline ? h('p', { class: P.late ? 'warn-txt' : 'small' }, h('b', {}, `À déposer sur AlphaTango au plus tard le ${P.deadline.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`), P.late ? ' : délai dépassé pour cette date, décaler la mission.' : ` (${PEUPLEE_DELAI} jours ouvrés avant le vol).`)
          : h('p', { class: 'small' }, `Fixez la date du vol pour obtenir la date limite (${PEUPLEE_DELAI} jours ouvrés avant).`),
        h('p', { class: 'small muted' }, 'Ajoutez « Déclaration préfecture (zone peuplée) » à la checklist si besoin.')));
    } catch { /* hors ligne */ }
  })();
  fill(root, 
    h('div', { class: 'row space' }, h('button', { class: 'btn ghost', onclick: () => listView(root) }, '‹ Missions'),
      h('button', { class: 'btn ghost small', onclick: async () => { if (confirm('Supprimer cette mission et ses documents ?')) { for (const f of files) await dbDel('files', f.id); await dbDel('missions', id); listView(root); } } }, 'Supprimer')),
    h('section', { class: 'card' },
      h('input', { class: 'title-in', value: ms.name, onchange: (e) => save({ name: e.target.value }) }),
      h('div', { class: 'grid2' },
        h('label', {}, h('div', { class: 'lbl' }, 'Date du vol'), h('input', { type: 'date', value: ms.date || '', onchange: (e) => save({ date: e.target.value }) })),
        h('label', {}, h('div', { class: 'lbl' }, 'Client / référence'), h('input', { value: ms.client || '', onchange: (e) => save({ client: e.target.value }) }))),
      h('div', { class: 'lbl' }, 'Lieu'),
      h('div', { class: 'row space' },
        h('div', { class: 'small' }, ms.site ? ms.site.name : 'Non défini', ms.site ? h('div', { class: 'muted' }, `${ms.site.lat.toFixed(5)}, ${ms.site.lon.toFixed(5)} · L93 ${Math.round(l93.E)} / ${Math.round(l93.N)}`) : null),
        h('button', { class: 'btn small', onclick: async () => { const p = await pickPlace('Lieu de la mission'); if (p) { await save({ site: p }); rerender(); } } }, 'Choisir…')),
      ms.site ? h('button', { class: 'btn small ghost', onclick: () => { setSite(ms.site); toast('Lieu de vol réglé sur celui de la mission'); } }, 'Utiliser ce lieu dans tous les onglets') : null,
      h('div', { class: 'lbl' }, 'Notes'),
      h('textarea', { rows: 4, onchange: (e) => save({ notes: e.target.value }) }, ms.notes || '')),
    h('section', { class: 'card' },
      h('div', { class: 'row space' }, h('div', { class: 'lbl' }, `Checklist · ${done}/${ms.check.length}`),
        h('button', { class: 'btn small ghost', onclick: async () => { ms.check.forEach((c) => (c.ok = false)); await save({}); rerender(); } }, 'Tout décocher')),
      h('ul', { class: 'check' }, ...ms.check.map((c, i) => h('li', {},
        h('label', {}, h('input', { type: 'checkbox', checked: c.ok, onchange: async (e) => { c.ok = e.target.checked; await save({}); rerender(); } }), ' ', c.txt),
        h('button', { class: 'x', 'aria-label': 'Retirer', onclick: async () => { ms.check.splice(i, 1); await save({}); rerender(); } }, '×')))),
      h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const v = e.target.it.value.trim(); if (v) { ms.check.push({ txt: v, ok: false }); await save({}); rerender(); } } },
        h('input', { name: 'it', placeholder: 'Ajouter un point…' }), h('button', { class: 'btn small' }, 'Ajouter'))),
    peupleBox,
    h('section', { class: 'card' },
      h('div', { class: 'row space' }, h('div', { class: 'lbl' }, 'Archives météo et zones'), busy),
      h('button', { class: 'btn wide', disabled: !ms.site, onclick: async (e) => {
        e.target.disabled = true; busy.textContent = 'Préparation du PDF (réseau nécessaire)…';
        try {
          const blob = await report(ms.site, ms.name, ms.date);
          const d = new Date();
          const name = `meteo_zones_${d.toISOString().slice(0, 10)}_${hhmm(d).replace('h', '')}.pdf`;
          await dbPut('files', { id: uid(), mission: id, name, blob, t: Date.now(), kind: 'archive' });
          toast('Archive enregistrée dans la mission'); rerender();
        } catch (err) { busy.textContent = 'Échec : ' + err.message; e.target.disabled = false; }
      } }, ms.site ? '🗂 Archiver METAR/TAF + bulletin + zones (PDF)' : 'Choisir d\'abord le lieu'),
      fileList(files.filter((f) => f.kind === 'archive'), rerender)),
    h('section', { class: 'card' },
      h('div', { class: 'row space' }, h('div', { class: 'lbl' }, 'Documents de la mission'), uploader(id, rerender)),
      fileList(files.filter((f) => f.kind !== 'archive'), rerender)));
}

export async function listView(root) {
  const ms = (await dbAll('missions')).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.t - a.t);
  const perm = await filesOf(PERM);
  const rerender = () => listView(root);
  fill(root, 
    h('section', { class: 'card' },
      h('div', { class: 'row space' }, h('div', { class: 'lbl' }, `Missions · ${ms.length}`),
        h('button', { class: 'btn small', onclick: async () => {
          const name = prompt('Nom de la mission', `Mission ${new Date().toLocaleDateString('fr-FR')}`);
          if (!name) return;
          const id = uid();
          await dbPut('missions', { id, name, t: Date.now(), date: new Date().toISOString().slice(0, 10), check: DEFAULT_CHECK.map((txt) => ({ txt, ok: false })), notes: '' });
          missionView(root, id);
        } }, '+ Nouvelle mission')),
      ms.length ? h('ul', { class: 'missions' }, ...ms.map((m) => h('li', {}, h('button', { class: 'mitem', onclick: () => missionView(root, m.id) },
        h('b', {}, m.name), h('span', { class: 'small muted' }, `${m.date ? dateFr(Date.parse(m.date)) : ''}${m.site ? ' · ' + m.site.name : ''} · checklist ${m.check.filter((c) => c.ok).length}/${m.check.length}`)))))
        : h('p', { class: 'small muted' }, 'Aucune mission. Créez-en une pour regrouper lieu, checklist, documents et archives.')),
    h('section', { class: 'card' },
      h('div', { class: 'row space' }, h('div', { class: 'lbl' }, 'Documents permanents (licence, attestations, MANEX, assurance…)'), uploader(PERM, rerender)),
      fileList(perm, rerender)),
    h('p', { class: 'foot' }, 'Les missions et documents restent sur ce téléphone (stockage de l\'app). Pensez à partager les archives vers Fichiers / iCloud pour les conserver.'));
}

export const render = listView;
