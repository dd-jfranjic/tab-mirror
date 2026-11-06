// Lokalna povijest rasporeda (zadnjih 20) — "Vrati prethodno" ako se nešto posloži krivo.

import { summarize } from './snapshot.js';

export const HISTORY_LIMIT = 20;

/**
 * @param {object[]} list postojeća povijest (najnovije prvo)
 * @param {{snapshot: object, sh: string, label: string, at: number}} entry
 * @returns {object[]} nova povijest; isto stanje kao zadnje spremljeno se ne duplira
 */
export function pushHistory(list, entry) {
  const current = Array.isArray(list) ? list : [];
  if (current[0]?.sh === entry.sh) return current;
  const withSummary = { ...entry, ...summarize(entry.snapshot) };
  return [withSummary, ...current.filter((e) => e.sh !== entry.sh)].slice(0, HISTORY_LIMIT);
}
