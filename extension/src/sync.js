// Objava (glavni uređaj) i primjena (pratitelj) — spaja čiste odluke s Chrome API-jima i stanjem.

import { serialize, canonicalString, isEmptySnapshot, summarize, snapshotUrls, mergeUrls } from './snapshot.js';
import { encodeSnapshot, decodeSnapshot, sha256Hex, MAX_CHUNKS_PER_DEVICE } from './codec.js';
import { readMetas, pickNewest, maxRev, chunksFor, buildSlotWrite } from './slots.js';
import { decidePublish, decideApply, isConflict, nextRevision, hasUnappliedRemote, rememberBase, baseAt, APPLY_SETTLE_MS, REMOTE_WAIT_MS } from './lease.js';
import { applySnapshot } from './executor.js';
import { mergeDuplicateGroups } from './kept.js';
import { sanitizeSnapshot } from './planner.js';
import { pushHistory } from './history.js';
import { withOriginUrls } from './origins.js';
import { persistOriginPairs, restoreOriginsAfterStart } from './origin-store.js';
import * as store from './store.js';

const HOUR_MS = 3_600_000;
const APPLY_GUARD_MS = 120_000; // dok primjena traje, nijedan događaj tabova nije korisnikov
const MAX_APPLY_TRIES = 10; // Chrome odbije izmjenu dok korisnik vuče tab; alarm pokuša ponovno, oko 5 min
const APPLY_RETRY_GAP_MS = 25_000;

export async function readLocalSnapshot(api) {
  const [windows, groups, session] = await Promise.all([
    api.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    api.tabGroups.query({}),
    store.getSession(api),
  ]);
  // Preusmjereni tab (npr. na prijavu) vrijedi pod adresom za koju je otvoren — vidi origins.js.
  const snapshot = serialize(withOriginUrls(windows, session.origins), groups);
  return { snapshot, sh: await sha256Hex(canonicalString(snapshot)) };
}

async function publishContext(api, manual, sh, snapshot) {
  const [settings, state, session, debug] = await Promise.all([
    store.getSettings(api), store.getState(api), store.getSession(api), store.getDebug(api),
  ]);
  const now = Date.now();
  const writeTimes = (session.writeTimes || []).filter((t) => now - t < HOUR_MS);
  const present = manual || (await store.isUserPresent(api));
  const ctx = {
    paused: settings.paused, initialized: settings.initialized || manual, manual, present, now,
    startedAt: session.startedAt, graceMs: debug.graceMs, applyingUntil: session.applyingUntil, reconciled: session.reconciled,
    isEmpty: isEmptySnapshot(snapshot), hash: sh, sharedHashes: state.sharedHashes,
    lastWriteAt: session.lastWriteAt, writesLastHour: writeTimes.length,
  };
  return { settings, state, writeTimes, now, decision: decidePublish(ctx) };
}

/** @returns {Promise<{action: string, reason: string, delayMs?: number}>} */
export async function publish(api, { manual = false } = {}) {
  const { snapshot, sh } = await readLocalSnapshot(api);
  const { settings, state, writeTimes, now, decision } = await publishContext(api, manual, sh, snapshot);
  if (decision.action !== 'publish') return decision;
  const { applyFails, remoteWait } = await store.getSession(api);
  // Polovično primijenjen raspored se ne objavljuje sam: drugom bi računalu zatvorio tabove (ručna objava smije).
  if (!manual && settings.autoApply && applyFails) return { action: 'wait-present', reason: 'apply-failed' };
  // Na drugo računalo nikad ne idu dvije grupe istog imena; stanje prije spajanja je u povijesti.
  const groupsMerged = await mergeDuplicateGroups(api, () => rememberBefore(api, { snapshot, sh }, null, 'Prije spajanja grupa istog imena'));
  if (groupsMerged) return { action: 'defer', reason: 'groups-merged', delayMs: 500 };
  const { chunks, h } = await encodeSnapshot(snapshot);
  if (chunks.length > MAX_CHUNKS_PER_DEVICE) {
    await store.patchState(api, { lastError: 'too-big' });
    return { action: 'skip', reason: 'too-big' };
  }
  const items = await api.storage.sync.get(null);
  const newest = pickNewest(readMetas(items));
  if (!manual && settings.autoApply && hasUnappliedRemote(newest, state.lastApplied, settings.deviceId)) {
    const wait = remoteWait?.rev === newest.rev ? remoteWait : { rev: newest.rev, since: now };
    if (now - wait.since < REMOTE_WAIT_MS) {
      await store.patchSession(api, { remoteWait: wait });
      return { action: 'defer', reason: 'remote-first', delayMs: 2_000 }; // prvo primijeni pa objavi spojeno
    }
  }
  const rev = nextRevision(Math.max(maxRev(readMetas(items)), state.maxSeenRev), state.lastPublished?.rev);
  const base = Math.max(state.lastApplied?.rev || 0, state.lastPublished?.rev || 0);
  const meta = { dev: settings.deviceId, name: settings.deviceName, rev, base, ts: now, n: chunks.length, h, sh, ...summarize(snapshot) };
  const { set, remove } = buildSlotWrite(items, meta, chunks, now);
  if (remove.length) await api.storage.sync.remove(remove); // prvo oslobodi mjesto, inače set() padne na kvoti
  await api.storage.sync.set(set);
  await store.patchState(api, {
    lastPublished: { rev, ts: now, sh }, lastPublishedSnapshot: snapshot, maxSeenRev: rev, baseUrls: snapshotUrls(snapshot),
    knownBases: rememberBase(state.knownBases, rev, snapshotUrls(snapshot)),
    sharedHashes: store.currentShared(sh), lastError: '', conflictRev: 0,
  });
  // Veze "tab otvoren za adresu X" ostaju: objavljena je upravo ta adresa (briše ih korisnikova navigacija, origins.js).
  await store.patchSession(api, { lastWriteAt: now, writeTimes: [...writeTimes, now], pendingPublishAt: 0, applyFails: null });
  if (manual && !settings.initialized) await store.patchSettings(api, { initialized: true });
  return { action: 'publish', reason: decision.reason, rev };
}

async function rememberConflict(api, newest, state, me) {
  if (!isConflict(newest, state.lastPublished, me) || state.conflictRev === newest.rev) return state;
  if (state.lastPublishedSnapshot) {
    const entry = { snapshot: state.lastPublishedSnapshot, sh: state.lastPublished.sh, label: 'Tvoje stanje prije sukoba', at: Date.now() };
    await store.setHistory(api, pushHistory(await store.getHistory(api), entry));
  }
  return store.patchState(api, { conflictRev: newest.rev });
}

/** Primjena je pala: lastApplied ostaje, pa je alarm ponavlja s razmakom, a objava čeka (vidi publish). */
async function noteApplyFailure(api, rev, error, urls) {
  const { applyFails } = await store.getSession(api);
  const n = (applyFails?.rev === rev ? applyFails.n : 0) + 1;
  await store.patchSession(api, { applyFails: { rev, n, at: Date.now() } });
  const lastError = n < MAX_APPLY_TRIES
    ? `Preuzimanje nije uspjelo, pokušavam ponovno (${n}/${MAX_APPLY_TRIES}). Promjene s ovog računala čekaju.`
    : `Preuzimanje nije uspjelo (${error}). Promjene s ovog računala se ne šalju dok ne klikneš „Preuzmi zadnje“.`;
  // Tabovi cilja koji su otvoreni prije pada su zajednički: inače bi ih iduća primjena držala lokalnima i nikad ih ne bi zatvorila.
  await store.patchState(api, (st) => ({ lastError, pendingApply: true, baseUrls: st.baseUrls ? mergeUrls(st.baseUrls, urls) : st.baseUrls }));
}

/** Stanje koje primjena mijenja ide u povijest (ikona → Povijest → Vrati). */
async function rememberBefore(api, before, otherSh, label) {
  if (isEmptySnapshot(before.snapshot) || before.sh === otherSh) return;
  const entry = { snapshot: before.snapshot, sh: before.sh, label, at: Date.now() };
  await store.setHistory(api, pushHistory(await store.getHistory(api), entry));
}

async function runApply(api, target, newest, state, before, baseUrls, selfMoved) {
  const { applyFails } = await store.getSession(api);
  // Ponovni pokušaj iste primjene ne troši povijest: stanje prije prvog pokušaja je već spremljeno.
  if (applyFails?.rev !== newest.rev) await rememberBefore(api, before, newest.sh, `Prije preuzimanja s: ${newest.name || newest.dev}`);
  let error = '';
  let kept = 0;
  let openedUrls = [];
  if (before.sh !== newest.sh) {
    const session = await store.patchSession(api, { applyingUntil: Date.now() + APPLY_GUARD_MS });
    try {
      // Veze se spremaju i kad primjena padne na pola — inače bi iduća primjena preusmjerene tabove otvorila ponovno.
      const result = await applySnapshot(api, target, { baseUrls, origins: session.origins, selfMoved });
      kept = result.kept;
      openedUrls = result.openedUrls || [];
      await store.patchSession(api, { origins: result.origins });
      await persistOriginPairs(api);
      if (result.error) throw result.error;
    } catch (err) {
      error = `Primjena nije uspjela do kraja: ${err?.message || err}`; // vidi se u izborniku; ponavlja se s razmakom (noteApplyFailure)
    } finally {
      await store.patchSession(api, { applyingUntil: Date.now() + APPLY_SETTLE_MS });
    }
  }
  if (error) {
    await noteApplyFailure(api, newest.rev, error, openedUrls);
    return;
  }
  await mergeDuplicateGroups(api); // stanje prije primjene je već u povijesti
  await store.patchSession(api, { applyFails: null });
  const merged = kept > 0;
  const after = await readLocalSnapshot(api);
  await store.patchState(api, {
    lastApplied: { rev: newest.rev, dev: newest.dev, name: newest.name, ts: Date.now(), sh: newest.sh },
    // Sa sačuvanim tabovima stanje nije zajedničko dok ih i drugo računalo ne dobije: ide u red za objavu.
    sharedHashes: merged ? store.currentShared(newest.sh) : store.currentShared(newest.sh, after.sh),
    baseUrls: snapshotUrls(target), pendingApply: false, lastError: error,
    knownBases: newest.dev === (await store.getSettings(api)).deviceId ? state.knownBases : rememberBase(state.knownBases, newest.rev, snapshotUrls(target)),
  });
  if (merged) await store.patchSession(api, { pendingPublishAt: Date.now() });
  await store.patchSettings(api, { initialized: true });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.manual] korisnik je kliknuo "Preuzmi"
 * @param {boolean} [opts.restoreIfEmpty] otvoren je novi prozor — prazan Chrome se napuni
 * @param {boolean} [opts.reconcile] Chrome je upravo pokrenut — uskladi se sa zajedničkim prije prve objave
 * @returns {Promise<{action: string, reason: string}>}
 */
const MAX_RECONCILE_WAITS = 10; // ~30 s; poslije toga se usklađivanje ne smije beskonačno blokirati objavu

export async function checkApply(api, opts = {}) {
  let result;
  try {
    if (opts.reconcile) await restoreOriginsAfterStart(api); // prije čitanja lokalnog stanja
    result = await checkApplyInner(api, opts);
  } catch (err) {
    await store.patchState(api, { lastError: String(err?.message || err) });
    result = { action: 'skip', reason: 'error' };
  }
  if (opts.reconcile) {
    const waits = result.action === 'wait' ? ((await store.getSession(api)).reconcileWaits || 0) + 1 : 0;
    const done = result.action !== 'wait' || waits >= MAX_RECONCILE_WAITS;
    await store.patchSession(api, { reconciled: done, reconcileWaits: waits });
  }
  return result;
}

async function checkApplyInner(api, { manual = false, restoreIfEmpty = false, reconcile = false }) {
  const [settings, items, before, session] = await Promise.all([
    store.getSettings(api), api.storage.sync.get(null), readLocalSnapshot(api), store.getSession(api),
  ]);
  const metas = readMetas(items);
  const newest = pickNewest(metas);
  let state = await store.patchState(api, { maxSeenRev: Math.max((await store.getState(api)).maxSeenRev, maxRev(metas)) });
  if (newest) state = await rememberConflict(api, newest, state, settings.deviceId);
  const decision = decideApply({
    ...settings, me: settings.deviceId, newest, lastApplied: state.lastApplied, manual,
    restoreIfEmpty: restoreIfEmpty && isEmptySnapshot(before.snapshot), reconcile, reconciled: !!session.reconciled,
  });
  if (decision.action !== 'apply') return decision;
  const fails = session.applyFails;
  if (!manual && !reconcile && fails?.rev === newest.rev && (fails.n >= MAX_APPLY_TRIES || Date.now() - fails.at < APPLY_RETRY_GAP_MS)) {
    return { action: 'skip', reason: 'apply-retry-later' };
  }
  const decoded = await decodeSnapshot(chunksFor(items, newest), newest.h);
  if (!decoded) {
    await store.patchState(api, { pendingApply: true }); // dijelovi još stižu — alarm pokušava ponovno
    return { action: 'wait', reason: 'incomplete' };
  }
  const target = sanitizeSnapshot(decoded); // npr. file:// tab sa starije verzije se preskoči, ostatak se primijeni
  if (!target) {
    // Cjelovito, ali neispravnog oblika — čekanje ne pomaže.
    await store.patchState(api, { pendingApply: false, lastError: `Raspored s računala „${newest.name || newest.dev}“ nije ispravan (nadogradi Tab Mirror na oba računala).` });
    return { action: 'skip', reason: 'invalid-snapshot' };
  }
  // Prvo preuzimanje (potvrđeno klikom) zatvara sve što drugo računalo nema; poslije se čuvaju tabovi koje nikad nije vidjelo.
  // Sukob: drugo računalo nije vidjelo moju zadnju objavu, pa je baza stanje na kojem je ono gradilo, ne ta objava.
  const conflictBase = isConflict(newest, state.lastPublished, settings.deviceId) ? baseAt(state.knownBases, newest.base || 0) : null;
  await runApply(api, target, newest, state, before, settings.initialized ? (conflictBase ?? state.baseUrls) : null,
    settings.initialized && !manual && !reconcile && !conflictBase);
  return decision;
}

/** Vrati raspored iz lokalne povijesti (objavu kao novo zajedničko stanje radi pozivatelj, s ponavljanjem ako treba). */
export async function restoreFromHistory(api, index) {
  const entry = (await store.getHistory(api))[index];
  const snapshot = entry && sanitizeSnapshot(entry.snapshot);
  if (!snapshot) return { action: 'skip', reason: 'no-entry' };
  const before = await readLocalSnapshot(api);
  await rememberBefore(api, before, entry.sh, 'Prije vraćanja iz povijesti');
  const session = await store.patchSession(api, { applyingUntil: Date.now() + APPLY_GUARD_MS });
  try {
    const result = await applySnapshot(api, snapshot, { origins: session.origins });
    await store.patchSession(api, { origins: result.origins });
    await persistOriginPairs(api);
    if (result.error) throw result.error;
  } finally {
    await store.patchSession(api, { applyingUntil: Date.now() + APPLY_SETTLE_MS });
  }
  return { action: 'restored', reason: 'history' };
}
