// Planer primjene: kako lokalne prozore i tabove pretvoriti u ciljni snapshot uz NAJMANJE promjena.
// Postojeći tab s istom adresom se ponovno koristi (ne učitava se iznova); stvara se samo ono što fali.
// Čiste funkcije — Chrome pozive radi executor.js.
//
// Lokalni prozor: { id, tabs: [{ id, url, key?, pinned, groupId, active, index }] } (samo zrcaljeni prozori)
// key = adresa po kojoj se tab sparuje: tab koji smo sami otvorili za adresu U, a stranica ga je preusmjerila
// (npr. na prijavu), i dalje se sparuje s U — inače bi se pri svakoj primjeni otvarao iznova.

import { isSyncableUrl, isBlankNewTab, isValidSnapshot } from './snapshot.js';

const keyOf = (t) => t.key ?? t.url;

function urlCounts(urls) {
  const m = new Map();
  for (const u of urls) m.set(u, (m.get(u) || 0) + 1);
  return m;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function overlap(localWin, targetWin) {
  const local = urlCounts(localWin.tabs.map(keyOf));
  let n = 0;
  for (const [u, k] of urlCounts(targetWin.t.map((t) => t[0]))) n += Math.min(k, local.get(u) || 0);
  return n;
}

const hasSyncableTabs = (win) => win.tabs.some((t) => isSyncableUrl(t.url));

/**
 * Spari ciljne prozore s lokalnima po broju zajedničkih adresa (pohlepno, najveće preklapanje prvo).
 * Lokalni prozor bez ijednog sinkronog taba (npr. samo nova kartica na startu) smije se iskoristiti za bilo koji cilj.
 * @returns {(number|null)[]} za svaki ciljni prozor ID lokalnog prozora ili null (= otvori novi prozor)
 */
export function matchWindows(localWins, targetWins) {
  const pairs = [];
  targetWins.forEach((tw, ti) => localWins.forEach((lw) => pairs.push({ ti, lw, score: overlap(lw, tw) })));
  pairs.sort((a, b) => b.score - a.score || a.ti - b.ti || a.lw.id - b.lw.id);
  const result = targetWins.map(() => null);
  const usedLocal = new Set();
  for (const { ti, lw, score } of pairs) {
    if (score === 0 || result[ti] !== null || usedLocal.has(lw.id)) continue;
    result[ti] = lw.id;
    usedLocal.add(lw.id);
  }
  const spare = localWins.filter((lw) => !usedLocal.has(lw.id) && !hasSyncableTabs(lw));
  result.forEach((id, ti) => {
    if (id === null && spare.length) result[ti] = spare.shift().id;
  });
  return result;
}

function takeTab(pool, match, preferIndex) {
  let best = -1;
  for (let i = 0; i < pool.length; i++) {
    if (!match(pool[i])) continue;
    if (best === -1 || Math.abs(pool[i].index - preferIndex) < Math.abs(pool[best].index - preferIndex)) best = i;
  }
  return best === -1 ? null : pool.splice(best, 1)[0];
}

/**
 * Tabovi koje drugo računalo nikad nije vidjelo (lokalno ih ima više nego u zadnjem zajedničkom stanju koje ovo
 * računalo zna) ne zatvaraju se pri primjeni — npr. Chrome otvoren klikom na poveznicu iz maila.
 * @param {object[]} localWins
 * @param {string[]|null} baseUrls adrese zadnjeg zajedničkog stanja (null = nema baze → ništa se ne čuva)
 * @returns {Map<string, number>} ključ (adresa) → koliko primjeraka sačuvati
 */
export function localOnlyUrls(localWins, baseUrls) {
  const keep = new Map();
  if (!Array.isArray(baseUrls)) return keep;
  const base = urlCounts(baseUrls);
  const local = urlCounts(localWins.flatMap((lw) => lw.tabs.filter((t) => isSyncableUrl(t.url)).map(keyOf)));
  for (const [u, k] of local) if (k > (base.get(u) || 0)) keep.set(u, k - (base.get(u) || 0));
  return keep;
}

/** Izdvoji iz bazena tabove koji se čuvaju (lokalni, drugo računalo ih ne zna) — ne smiju se ni zatvoriti ni preusmjeriti. */
function splitKept(pools, keep) {
  const spare = new Map(keep);
  const kept = [];
  for (const pool of pools) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const k = spare.get(keyOf(pool[i])) || 0;
      if (k > 0) { spare.set(keyOf(pool[i]), k - 1); kept.push(pool.splice(i, 1)[0]); }
    }
  }
  return kept;
}

/**
 * Tab koji je sam promijenio adresu dok korisnika nema (stranica ga odjavila) nije nov: bez ovoga bi ostao kao sačuvan,
 * zajednička adresa bi se otvorila kao drugi tab, a oba bi se objavila. Namjerno usko, da se ne dira tab koji je korisnik
 * sam otvorio: neaktivan tab, u sparenom prozoru, iste domene kao zajednička adresa kojoj u tom prozoru fali par.
 * Preusmjerenje na drugu domenu (SSO) se ne prepoznaje i tab ostaje sačuvan.
 */
function withoutSelfMoved(keep, baseUrls, byWin, targetWins, winMatch, assign) {
  const left = new Map(keep);
  const base = new Set(baseUrls);
  targetWins.forEach((tw, ti) => {
    const pool = byWin.get(winMatch[ti]);
    if (!pool) return;
    const used = new Set();
    tw.t.forEach((t, k) => {
      if (assign[ti][k] !== null || !base.has(t[0])) return;
      const hit = pool.find((lt) => !lt.active && !used.has(lt.id) && (left.get(keyOf(lt)) || 0) > 0 && originOf(lt.url) === originOf(t[0]));
      if (!hit) return;
      used.add(hit.id);
      left.set(keyOf(hit), left.get(keyOf(hit)) - 1);
    });
  });
  return left;
}

/**
 * Za svaki ciljni tab odaberi postojeći lokalni tab ili null (= stvori). Redom:
 * 1) ista adresa u sparenom prozoru, 2) ista adresa u drugom prozoru (premjesti),
 * 3) preostali tab iste domene u sparenom prozoru → samo mu promijeni adresu (navigacija na drugom računalu ne
 *    znači zatvori + otvori).
 * @param {Map<string, number>} [keep] iz localOnlyUrls — ti se tabovi ne diraju
 * @param {string[]|null} [movedBase] zajedničke adrese za prepoznavanje taba koji je sam promijenio adresu (null = ne prepoznaje se)
 * @returns {{ assign: (number|null)[][], navigate: {tabId: number, url: string}[], closeTabIds: number[] }}
 */
export function assignTabs(localWins, targetWins, winMatch, keep = new Map(), movedBase = null) {
  const byWin = new Map(localWins.map((lw) => [lw.id, lw.tabs.filter((t) => isSyncableUrl(t.url)).slice()]));
  const assign = targetWins.map((tw) => tw.t.map(() => null));
  const navigate = [];
  const pass = (pickPool, match, onHit) => targetWins.forEach((tw, ti) => tw.t.forEach((t, k) => {
    if (assign[ti][k] !== null) return;
    for (const pool of pickPool(ti)) {
      const hit = takeTab(pool, (lt) => match(lt, t[0]), k);
      if (hit) { assign[ti][k] = hit.id; onHit?.(hit, t[0]); return; }
    }
  }));
  const own = (ti) => (byWin.has(winMatch[ti]) ? [byWin.get(winMatch[ti])] : []);
  pass(own, (lt, url) => keyOf(lt) === url);
  pass(() => [...byWin.values()], (lt, url) => keyOf(lt) === url);
  const kept = splitKept([...byWin.values()], movedBase ? withoutSelfMoved(keep, movedBase, byWin, targetWins, winMatch, assign) : keep);
  pass(own, (lt, url) => originOf(lt.url) !== null && originOf(lt.url) === originOf(url), (hit, url) => navigate.push({ tabId: hit.id, url }));
  const closeTabIds = [...byWin.values()].flat().map((t) => t.id);
  const filledWins = new Set(winMatch.filter((id, ti) => id !== null && targetWins[ti].t.length > 0));
  for (const lw of localWins) {
    if (filledWins.has(lw.id)) for (const t of lw.tabs) if (isBlankNewTab(t)) closeTabIds.push(t.id);
  }
  return { assign, navigate, closeTabIds, keptTabIds: kept.map((t) => t.id) };
}

/**
 * Ciljni prozor bez tabova koje Chrome nije mogao otvoriti (indeksi grupa i aktivnog taba se prilagode).
 * @param {object} tw ciljni prozor
 * @param {Set<number>} drop indeksi tabova za izbaciti
 */
export function withoutTabs(tw, drop) {
  if (!drop.size) return tw;
  const t = tw.t.filter((_, k) => !drop.has(k));
  const usedGroups = [...new Set(t.map((x) => x[2]).filter((g) => g >= 0))].sort((a, b) => a - b);
  const remap = new Map(usedGroups.map((g, i) => [g, i]));
  const shift = [...drop].filter((k) => k < tw.a).length;
  return {
    t: t.map(([u, p, g]) => [u, p, g >= 0 ? remap.get(g) : -1]),
    g: usedGroups.map((g) => tw.g[g]),
    a: tw.a < 0 || drop.has(tw.a) ? -1 : tw.a - shift,
  };
}

/**
 * Za svaku ciljnu grupu odaberi postojeću lokalnu grupu koja već drži najviše njezinih tabova (čuva ID grupe,
 * pa se grupa ne zatvara i ne otvara iznova). null = napravi novu grupu.
 * @param {Map<number, number>} currentGroupOf tabId → trenutni groupId (-1 = bez grupe)
 * @param {object} targetWin ciljni prozor iz snapshota
 * @param {number[]} assignedIds tabId za svaki ciljni tab
 * @returns {(number|null)[]}
 */
export function mapGroups(currentGroupOf, targetWin, assignedIds) {
  const tally = new Map();
  targetWin.t.forEach((t, k) => {
    const gid = currentGroupOf.get(assignedIds[k]);
    if (t[2] < 0 || typeof gid !== 'number' || gid < 0) return;
    const key = `${t[2]}:${gid}`;
    tally.set(key, { gi: t[2], gid, n: (tally.get(key)?.n || 0) + 1 });
  });
  const ranked = [...tally.values()].sort((a, b) => b.n - a.n || a.gi - b.gi || a.gid - b.gid);
  const result = targetWin.g.map(() => null);
  const used = new Set();
  for (const { gi, gid } of ranked) {
    if (result[gi] !== null || used.has(gid)) continue;
    result[gi] = gid;
    used.add(gid);
  }
  return result;
}

/**
 * Snapshot iz synca (možda sa starije verzije ili s drugog računala) očisti od tabova koji se ne smiju otvoriti
 * (npr. file:// iz verzije 1.0.0) umjesto da se odbije cijeli raspored. null = oblik nije ispravan.
 */
export function sanitizeSnapshot(s) {
  const wellFormed = (w) => w && Array.isArray(w.t) && Array.isArray(w.g) && w.t.every((t) => Array.isArray(t) && typeof t[0] === 'string');
  if (!s || s.v !== 1 || !Array.isArray(s.w) || !s.w.every(wellFormed)) return null;
  const w = s.w
    .map((tw) => withoutTabs({ ...tw, a: typeof tw.a === 'number' ? tw.a : -1 }, new Set(tw.t.flatMap((t, k) => (isSyncableUrl(t[0]) ? [] : [k])))))
    .filter((tw) => tw.t.length > 0);
  const out = { v: 1, w };
  return isValidSnapshot(out) ? out : null;
}
