// Svaki uređaj piše SAMO u svoj "pretinac" u storage.sync: meta `m.<uređaj>` + dijelovi `c.<uređaj>.<i>`.
// Google sync rješava sukobe po stavci (zadnji zapis pobjeđuje); da su dijelovi zajednički, dva uređaja bi mogla
// izmiješati dijelove. S pretincima po uređaju to je nemoguće, a "najnovije stanje" bira se po reviziji.

export const META_PREFIX = 'm.';
export const CHUNK_PREFIX = 'c.';
export const STALE_SLOT_MS = 45 * 24 * 3600 * 1000; // pretinac uređaja koji se 45 dana nije javio se briše
export const QUOTA_SOFT_BYTES = 95_000; // kvota storage.sync je 102400 B; iznad ovoga se briše najstariji tuđi pretinac

export const metaKey = (dev) => `${META_PREFIX}${dev}`;
export const chunkKey = (dev, i) => `${CHUNK_PREFIX}${dev}.${i}`;

function isValidMeta(m) {
  return (
    m && typeof m.dev === 'string' && Number.isInteger(m.rev) && m.rev > 0 &&
    Number.isInteger(m.n) && m.n > 0 && typeof m.h === 'string' && typeof m.ts === 'number'
  );
}

/** Sve ispravne mete iz cijelog sadržaja storage.sync. */
export function readMetas(items) {
  const metas = [];
  for (const [key, value] of Object.entries(items || {})) {
    if (key.startsWith(META_PREFIX) && isValidMeta(value) && key === metaKey(value.dev)) metas.push(value);
  }
  return metas;
}

/** Redoslijed stanja: veća revizija pobjeđuje; jednako → kasnije vrijeme; jednako → ime uređaja (determinističko). */
export function compareMeta(a, b) {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0;
}

export function pickNewest(metas) {
  let best = null;
  for (const m of metas) if (!best || compareMeta(m, best) > 0) best = m;
  return best;
}

export function maxRev(metas) {
  return metas.reduce((max, m) => Math.max(max, m.rev), 0);
}

export function chunksFor(items, meta) {
  const out = [];
  for (let i = 0; i < meta.n; i++) out.push(items[chunkKey(meta.dev, i)]);
  return out;
}

const devOfKey = (key) => (key.startsWith(META_PREFIX) ? key.slice(2) : key.startsWith(CHUNK_PREFIX) ? key.slice(2).split('.')[0] : null);
const itemBytes = (key, value) => key.length + JSON.stringify(value).length;

/**
 * Pretinci koje treba maknuti da nova objava stane u kvotu (npr. stari pretinac nakon ponovne instalacije proširenja).
 * Nikad se ne briše najnoviji tuđi pretinac (to je trenutno zajedničko stanje).
 */
function devsOverQuota(items, set, me, now) {
  const metas = readMetas(items).filter((m) => m.dev !== me);
  const newest = pickNewest(metas);
  const bytesOf = new Map();
  let total = Object.entries(set).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
  for (const [k, v] of Object.entries(items || {})) {
    const dev = devOfKey(k);
    if (!dev || dev === me) continue;
    bytesOf.set(dev, (bytesOf.get(dev) || 0) + itemBytes(k, v));
    total += itemBytes(k, v);
  }
  const drop = new Set(metas.filter((m) => now - m.ts > STALE_SLOT_MS).map((m) => m.dev));
  for (const d of drop) total -= bytesOf.get(d) || 0;
  for (const m of [...metas].sort((a, b) => a.ts - b.ts)) {
    if (total <= QUOTA_SOFT_BYTES) break;
    if (m === newest || drop.has(m.dev)) continue;
    drop.add(m.dev);
    total -= bytesOf.get(m.dev) || 0;
  }
  return drop;
}

/**
 * Što upisati i što obrisati za jednu objavu. Sve ide u JEDAN set() (= jedna operacija pisanja u kvoti).
 * @param {object} items trenutni sadržaj storage.sync
 * @param {object} meta nova meta ovog uređaja
 * @param {string[]} chunks dijelovi
 * @param {number} now
 */
export function buildSlotWrite(items, meta, chunks, now) {
  const set = { [metaKey(meta.dev)]: meta };
  chunks.forEach((c, i) => { set[chunkKey(meta.dev, i)] = c; });
  const remove = [];
  const ownChunkPrefix = `${CHUNK_PREFIX}${meta.dev}.`;
  const dropDevs = devsOverQuota(items, set, meta.dev, now);
  for (const key of Object.keys(items || {})) {
    if (key.startsWith(ownChunkPrefix) && !(key in set)) remove.push(key); // dijelovi viška kad se stanje smanji
    const dev = devOfKey(key);
    if (dev && dropDevs.has(dev)) remove.push(key);
  }
  return { set, remove };
}

/** Ključevi svih pretinaca (za potvrđeno brisanje zajedničkog rasporeda). */
export function allSlotKeys(items) {
  return Object.keys(items || {}).filter((k) => k.startsWith(META_PREFIX) || k.startsWith(CHUNK_PREFIX));
}
