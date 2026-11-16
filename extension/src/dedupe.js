// Ista stranica dvaput u istom prozoru ne putuje na drugo računalo (v1.0.6).
// Duplikat može napraviti Chrome sam (pri pokretanju vrati svaki tab dvaput — Windows, 16.11.2026), Chromeova
// sinkronizacija spremljenih grupa ili nešto treće; pravilo vrijedi bez obzira na uzrok, kao spajanje grupa (kept.js).
// Adresa je ona pod kojom se tab objavljuje (preusmjereni tab vrijedi pod izvornom adresom, origins.js).

import { isSyncableUrl, isMirroredWindow, tabUrl } from './snapshot.js';
import { withOriginUrls } from './origins.js';

/**
 * Koja kopija ostaje: aktivna, pa ona koja stvarno stoji na adresi (ne prijava upisana pod nju preko origins),
 * pa prikvačena, pa ona u grupi, pa prva s lijeva.
 */
function rank(t) {
  return [t.active ? 0 : 1, t.onKey === false ? 1 : 0, t.pinned ? 0 : 1, t.groupId >= 0 ? 0 : 1, t.index];
}

function better(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
  return false;
}

/**
 * Tabovi koje treba zatvoriti: u svakom zrcaljenom prozoru po adresi ostaje jedna kopija.
 * @param {chrome.windows.Window[]} windows iz windows.getAll({populate: true}), adrese već pod objavnim ključem;
 *   tab s `onKey: false` je pod tu adresu upisan preko origins (stvarno stoji drugdje, npr. na prijavi)
 * @returns {number[]} ID-jevi suvišnih tabova
 */
export function duplicateTabIds(windows) {
  const extra = [];
  for (const w of windows) {
    if (!isMirroredWindow(w)) continue;
    const keep = new Map();
    for (const t of w.tabs || []) {
      const url = tabUrl(t);
      if (!isSyncableUrl(url)) continue;
      const cur = keep.get(url);
      if (!cur) { keep.set(url, t); continue; }
      if (better(t, cur)) { extra.push(cur.id); keep.set(url, t); } else extra.push(t.id);
    }
  }
  return extra;
}

/** Prozori pod objavnim adresama, uz oznaku stoji li tab stvarno na toj adresi. */
function publishedWindows(windows, origins) {
  const mapped = withOriginUrls(windows, origins);
  return mapped.map((w, i) => ({
    ...w,
    tabs: (w.tabs || []).map((t, k) => ({ ...t, onKey: tabUrl(windows[i].tabs[k]) === tabUrl(t) })),
  }));
}

/**
 * Zatvori suvišne kopije; vraća koliko ih je NAĐENO (ne zatvoreno): objava koja ih je našla mora se odgoditi i kad Chrome
 * zatvaranje odbije (npr. dok korisnik vuče tab), inače bi otišla s duplikatom. Tab koji je u međuvremenu nestao se preskače.
 * @param {object} origins session origins (tabId → zapis), da se preusmjereni tab broji pod izvornom adresom
 * @param {function(): Promise<void>} [before] poziva se jednom prije prvog zatvaranja (npr. zapis u povijest)
 */
export async function closeDuplicateTabs(api, origins, before) {
  const windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const ids = duplicateTabIds(publishedWindows(windows, origins));
  if (!ids.length) return 0;
  if (before) await before();
  for (const id of ids) {
    try {
      await api.tabs.remove(id);
    } catch { /* nestao u međuvremenu ili Chrome trenutno odbija izmjenu — iduća objava pokuša ponovno */ }
  }
  return ids.length;
}
