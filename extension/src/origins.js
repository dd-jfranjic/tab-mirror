// Veza "tab → adresa za koju ga je Tab Mirror otvorio" (session.origins). Stranica koju poslužitelj ili skripta
// preusmjeri (npr. na prijavu jer ovo računalo nije prijavljeno) i dalje se objavljuje pod izvornom adresom —
// inače bi drugo računalo svoj pravi tab zamijenilo stranicom za prijavu. Čiste funkcije (test/unit/origins.test.js).
//
// Zapis: { k: izvorna adresa, l: adresa na kojoj je tab sletio (null = još se učitava), t: vrijeme zadnjeg commita }.
// Izvorna adresa vrijedi samo dok je tab na mjestu gdje je sletio; korisnikova navigacija vezu briše.

// Heuristika: stranica obično sama skoči dalje (replaceState, SAML obrazac, skripta) u prvih par sekundi nakon
// učitavanja, korisnik klikne kasnije; korisnikov klik u prvih 5 s prenese se tek s idućom navigacijom.
// Bolje tek uz signal korisničke geste (webNavigation ga ne daje).
export const PAGE_SETTLE_MS = 5_000;
// Tab otvoren pri primjeni koji nikad ne stigne do stranice (preuzimanje datoteke, odgovor 204) ne čeka slijetanje vječno.
export const LANDING_WAIT_MS = 30_000;

/**
 * Je li navigaciju napravila stranica ili Chrome (veza ostaje, pomakne se mjesto slijetanja) ili korisnik (veza se briše).
 * Izmjereno u Chromiumu: korisnikov klik i Tab Mirrorovo otvaranje taba imaju isti tip ('link', uz 'server_redirect' ako
 * poslužitelj preusmjeri) — zato se prvo slijetanje prepoznaje po zapisu (l = null), a ne po tipu. Korisnik može
 * navigirati samo tabom koji gleda, pa je navigacija neaktivnog taba uvijek stranična.
 * @example isPageNavigation('commit', { transitionType: 'link', transitionQualifiers: ['server_redirect'] },
 *   { landed: null, tabActive: false, sinceCommitMs: 800, applying: false }) // → true (tab je upravo sletio na prijavu)
 * @param {'commit'|'history'} kind webNavigation.onCommitted ili onHistoryStateUpdated/onReferenceFragmentUpdated
 * @param {{transitionType?: string, transitionQualifiers?: string[]}} details
 * @param {{landed: string|null, tabActive: boolean, sinceCommitMs: number, applying: boolean}} ctx
 *   sinceCommitMs = od zadnjeg poznatog učitavanja taba (ili od otvaranja, dok nije sletio)
 */
export function isPageNavigation(kind, details, { landed, tabActive, sinceCommitMs, applying }) {
  if (applying) return true; // Tab Mirrorova primjena
  if (landed === null) return sinceCommitMs < LANDING_WAIT_MS; // prvo slijetanje taba koji je Tab Mirror otvorio
  if (!tabActive || sinceCommitMs < PAGE_SETTLE_MS) return true;
  // 'client_redirect' namjerno ne znači stranicu: dobije ga i korisnikov klik na gumb koji radi location.replace
  // (izmjereno); skripta koja preusmjeri odmah nakon učitavanja uhvaćena je rokom iznad.
  return kind === 'commit' && details.transitionType === 'reload';
}

/** Izvorna adresa taba, ili null kad tab nije (više) na mjestu gdje je sletio. */
export function originKey(entry, url) {
  if (!entry?.k) return null;
  return entry.l === null || url === entry.l || url === entry.k ? entry.k : null;
}

/**
 * Prozori za snapshot: tab s vezom dobije izvornu adresu umjesto trenutne (preusmjerene).
 * @param {chrome.windows.Window[]} windows
 * @param {Object<string, {k: string, l: string|null, t: number}>} origins
 */
export function withOriginUrls(windows, origins) {
  if (!origins || !Object.keys(origins).length) return windows;
  return windows.map((w) => ({
    ...w,
    tabs: (w.tabs || []).map((t) => {
      const key = originKey(origins[t.id], t.pendingUrl || t.url);
      return key ? { ...t, url: key, pendingUrl: undefined } : t;
    }),
  }));
}

/**
 * Zapisi nakon primjene: tab koji se još učitava čeka prvo slijetanje.
 * @param {Object<string, string>} keys tabId → ciljna adresa
 * @param {chrome.tabs.Tab[]} tabs trenutni tabovi
 * @param {Set<number>} loaded tabovi koje je primjena upravo otvorila ili preusmjerila (ostali su se učitali ranije)
 */
export function originEntries(keys, tabs, now, loaded) {
  const byId = new Map(tabs.map((t) => [String(t.id), t]));
  const out = {};
  for (const [id, k] of Object.entries(keys)) {
    const tab = byId.get(String(id));
    if (tab) out[id] = { k, l: tab.pendingUrl || !tab.url ? null : tab.url, t: loaded.has(tab.id) ? now : 0 };
  }
  return out;
}

/**
 * Parovi [izvorna, preusmjerena] živih tabova — trajno spremljeni, jer ID-jevi tabova ne prežive restart Chromea.
 * @param {Set<number>} liveIds
 */
export function originPairs(origins, liveIds) {
  return Object.entries(origins || {})
    .filter(([id, e]) => liveIds.has(Number(id)) && e?.l && e.l !== e.k)
    .map(([, e]) => [e.k, e.l]);
}

const pathOf = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return null; } };

/**
 * Nakon restarta Chromea: tab koji stoji na preusmjerenoj adresi iz para opet dobije vezu (inače dupli tab i prijava van).
 * Prvo točna adresa, zatim ista stranica s drugim parametrima (prijava pri ponovnom učitavanju dobije novi jednokratni kod).
 */
export function rebuildOrigins(pairs, tabs, now) {
  const free = tabs.map((t) => ({ id: t.id, url: t.pendingUrl || t.url })).filter((t) => t.url);
  const out = {};
  const claim = (k, l, same) => {
    const i = free.findIndex((t) => same(t.url));
    if (i >= 0) out[free.splice(i, 1)[0].id] = { k, l, t: now };
    return i >= 0;
  };
  const left = (pairs || []).filter(([k, l]) => !claim(k, l, (u) => u === l));
  for (const [k, l] of left) claim(k, l, (u) => pathOf(u) !== null && pathOf(u) === pathOf(l));
  return out;
}

/** Nova verzija zapisa nakon navigacije: stranica → pomakni slijetanje; korisnik → makni vezu. */
export function afterNavigation(origins, tabId, url, isPage, now) {
  const { [tabId]: entry, ...rest } = origins || {};
  if (!entry || !isPage) return rest;
  return { ...rest, [tabId]: { ...entry, l: url, t: now } };
}
