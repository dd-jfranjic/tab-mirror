// Spremanje veza tabova (origins.js): u sesiji po ID-ju taba, a trajno kao parovi adresa — ID-jevi tabova ne prežive
// restart Chromea, a tab koji Chrome vrati na stranicu za prijavu mora opet dobiti svoju izvornu adresu.

import { originPairs, rebuildOrigins, isPageNavigation, afterNavigation } from './origins.js';
import * as store from './store.js';

/** Makni veze zatvorenih tabova i trajno spremi parove [izvorna, preusmjerena] onih koji su ostali. */
export async function persistOriginPairs(api) {
  const liveIds = new Set((await api.tabs.query({})).map((t) => t.id));
  const session = await store.patchSession(api, (cur) => ({
    origins: Object.fromEntries(Object.entries(cur.origins || {}).filter(([id]) => liveIds.has(Number(id)))),
  }));
  await store.patchState(api, { originPairs: originPairs(session.origins, liveIds) });
}

/** Nakon pokretanja Chromea (ili nove verzije proširenja) vrati veze iz trajno spremljenih parova. */
export async function restoreOriginsAfterStart(api) {
  const [session, state] = await Promise.all([store.getSession(api), store.getState(api)]);
  if (Object.keys(session.origins || {}).length || !state.originPairs?.length) return;
  const origins = rebuildOrigins(state.originPairs, await api.tabs.query({}), Date.now());
  await store.patchSession(api, { origins });
  // Parovi koje nijedan tab nije preuzeo su zastarjeli — inače bi kasnije "posvojili" tab otvoren izvana (npr. iz maila).
  await store.patchState(api, { originPairs: Object.values(origins).map((e) => [e.k, e.l]) });
}

/**
 * Navigacija taba s vezom: stranica (preusmjerenje) pomakne mjesto slijetanja, korisnikova navigacija briše vezu.
 * @param {'commit'|'history'} kind
 * @returns {Promise<boolean>} true = korisnik je sam navigirao (tab ima novu stvarnu adresu → objavi)
 */
export async function trackOrigin(api, kind, details) {
  if (details.frameId !== 0) return false;
  const session = await store.getSession(api);
  const entry = session.origins?.[details.tabId];
  if (!entry) return false;
  const tab = await api.tabs.get(details.tabId).catch(() => null);
  const now = Date.now();
  const ctx = { landed: entry.l, tabActive: !!tab?.active, sinceCommitMs: now - entry.t, applying: now < session.applyingUntil };
  const isPage = isPageNavigation(kind, details, ctx);
  await store.patchSession(api, (cur) => ({ origins: afterNavigation(cur.origins, details.tabId, details.url, isPage, now) }));
  await persistOriginPairs(api);
  return !isPage;
}
