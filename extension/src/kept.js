// Tab koji drugo računalo nikad nije vidjelo (planner.localOnlyUrls) primjena ne zatvara ni ne premješta. Ako je bio u
// grupi, mora ostati u ISTOJ grupi kad je primjena prepravi — inače njegova stara grupa ostane kao druga grupa sa starim
// imenom (npr. dvije grupe „github“, jedna samo s tim tabom) i s ovog se računala objavi na drugo.

/** Stara lokalna grupa → glasovi { 'i:gi' → { n, i, gi } } zajedničkih tabova: u koju ciljnu grupu je otišao koji. */
function tallyVotes(groupOf, targetWins, assign) {
  const tally = new Map();
  assign.forEach((ids, i) => ids.forEach((id, k) => {
    const old = id === null ? -1 : groupOf.get(id);
    if (old === undefined || old < 0) return;
    const votes = tally.get(old) || new Map();
    const gi = targetWins[i].t[k][2];
    const key = `${i}:${gi}`;
    votes.set(key, { n: (votes.get(key)?.n || 0) + 1, i, gi });
    tally.set(old, votes);
  }));
  return tally;
}

/** Ciljna grupa istog imena (zajednički tabovi stare grupe se zatvaraju i zamjenjuju novima, pa nitko ne glasa). */
function sameTitle(targetWins, title, onlyWindow = null) {
  if (!title) return null;
  for (let i = 0; i < targetWins.length; i++) {
    if (onlyWindow !== null && i !== onlyWindow) continue;
    const gi = targetWins[i].g.findIndex((g) => g.n === title);
    if (gi >= 0) return { i, gi };
  }
  return null;
}

/**
 * Za svaki sačuvani tab u grupi odluči kamo ide nakon primjene: u ciljnu grupu u koju je otišla većina zajedničkih
 * tabova njegove stare grupe; inače u ciljnu grupu istog imena (sačuvani se tabovi objavljuju, pa bi se dvije grupe
 * istog imena prenijele na oba računala). Grupa bez zajedničkog taba i bez ciljne grupe tog imena ostaje lokalna.
 * @example planKeptGroups([{ id: 1, tabs: [{ id: 5, groupId: 9 }, { id: 6, groupId: 9 }] }], [6], [{ t: [['https://a/', 0, 0]], g: [{}] }], [[5]])
 *   // → [{ tabId: 6, i: 0, gi: 0 }]  (tab 6 ide u prvu ciljnu grupu prvog prozora)
 * @param {object[]} localWins lokalni prozori prije primjene (executor.readLocal)
 * @param {number[]} keptTabIds sačuvani tabovi (planner.assignTabs → keptTabIds)
 * @param {object[]} targetWins ciljni prozori
 * @param {(number|null)[][]} assign tabId za svaki ciljni tab PRIJE primjene (null = tab će se tek stvoriti)
 * @param {Map<number, string>} [titleOf] naslov lokalne grupe po ID-ju
 * @param {number[]} [closeTabIds] tabovi koje primjena zatvara (planner.assignTabs)
 * @param {(number|null)[]} [winMatch] lokalni prozor za svaki ciljni: grupa istog imena traži se samo u svom prozoru
 * @returns {{tabId: number, i?: number, gi?: number, ungroup?: true}[]}
 */
export function planKeptGroups(localWins, keptTabIds, targetWins, assign, titleOf = new Map(), closeTabIds = [], winMatch = null) {
  const groupOf = new Map(localWins.flatMap((lw) => lw.tabs.map((t) => [t.id, typeof t.groupId === 'number' ? t.groupId : -1])));
  const tally = tallyVotes(groupOf, targetWins, assign);
  const replaced = new Set(closeTabIds.map((id) => groupOf.get(id)).filter((g) => g >= 0)); // grupe sa zajedničkim tabom koji odlazi
  const windowOf = new Map(localWins.flatMap((lw) => lw.tabs.map((t) => [t.id, lw.id])));
  const plan = [];
  for (const tabId of keptTabIds) {
    const old = groupOf.get(tabId);
    if (old === undefined || old < 0) continue;
    const votes = tally.get(old);
    const dest = votes ? [...votes.values()].sort((a, b) => b.n - a.n)[0] : sameTitle(targetWins, titleOf.get(old), winMatch ? winMatch.indexOf(windowOf.get(tabId)) : null);
    if (!dest) {
      if (replaced.has(old)) plan.push({ tabId, ungroup: true }); // zajednička grupa više ne postoji → ne ostaje kao lokalna
      continue; // grupa samo s lokalnim tabovima
    }
    plan.push(dest.gi < 0 ? { tabId, ungroup: true } : { tabId, i: dest.i, gi: dest.gi });
  }
  return plan;
}

/**
 * Provedi planKeptGroups nakon primjene (i nakon primjene koja je pala na pola). Ciljnu grupu nalazi preko bilo kojeg
 * njezinog taba; assign tada drži i ID-jeve novootvorenih tabova. Tab zatvoren u međuvremenu se preskače.
 */
export async function regroupKept(api, plan, targetWins, assign) {
  for (const { tabId, i, gi, ungroup } of plan) {
    try {
      const anchor = ungroup ? null : assign[i].find((id, k) => id !== null && targetWins[i].t[k][2] === gi);
      const gid = anchor == null ? -1 : (await api.tabs.get(anchor)).groupId ?? -1;
      if (gid >= 0) await api.tabs.group({ groupId: gid, tabIds: [tabId] });
      else if (ungroup) await api.tabs.ungroup([tabId]);
    } catch { /* tab ili grupa više ne postoje — ništa za popraviti */ }
  }
}

/**
 * Dvije grupe istog imena u istom prozoru (npr. korisnik otvori spremljenu grupu iz Chromeova popisa, a ista je već otvorena).
 * Grupe bez imena se ne diraju.
 * @param {{id: number, windowId: number, title?: string}[]} groups
 * @returns {{from: number, into: number}[]}
 */
export function duplicateGroups(groups) {
  const first = new Map();
  const out = [];
  for (const g of groups) {
    if (!g.title) continue;
    const key = `${g.windowId}\n${g.title}`;
    if (first.has(key)) out.push({ from: g.id, into: first.get(key) });
    else first.set(key, g.id);
  }
  return out;
}

/**
 * Spoji grupe istog imena; vraća koliko ih je spojeno. Grupa ili tab koji su u međuvremenu nestali se preskaču.
 * @param {function(): Promise<void>} [before] poziva se jednom prije prvog spajanja (npr. zapis u povijest)
 */
export async function mergeDuplicateGroups(api, before) {
  const dups = duplicateGroups(await api.tabGroups.query({}));
  if (dups.length && before) await before();
  let merged = 0;
  for (const { from, into } of dups) {
    try {
      const tabIds = (await api.tabs.query({ groupId: from })).map((t) => t.id);
      if (tabIds.length) await api.tabs.group({ groupId: into, tabIds });
      merged += 1;
    } catch { /* nestalo u međuvremenu */ }
  }
  return merged;
}

