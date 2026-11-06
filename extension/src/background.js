// Service worker: sluša promjene tabova/grupa/prozora i sync, odgađa (debounce) i serijski pokreće objavu/primjenu.

import { publish, checkApply, restoreFromHistory } from './sync.js';
import { DEBOUNCE_MS } from './lease.js';
import { allSlotKeys } from './slots.js';
import * as store from './store.js';
import { buildStatus, refreshBadge } from './status.js';
import { persistOriginPairs, trackOrigin } from './origin-store.js';

const api = chrome;
const ALARM = 'tm-tick';
let queue = Promise.resolve();
let publishTimer = null;
let applyTimer = null;

/** Objava i primjena nikad ne idu istovremeno (svaka čita i mijenja cijeli raspored). */
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch((err) => store.patchState(api, { lastError: String(err?.message || err) }));
  return run.finally(() => refreshBadge(api));
}

let publishDue = 0;

/** Debounce: nova promjena pomiče objavu, ali ne kasnije od već zakazane hitnije (npr. promjena aktivnog taba). */
async function schedulePublish(kind) {
  const now = Date.now();
  const due = now + (DEBOUNCE_MS[kind] ?? DEBOUNCE_MS.structure);
  const keepEarlier = publishDue > now && publishDue < due && kind === 'active';
  const at = keepEarlier ? publishDue : due;
  clearTimeout(publishTimer);
  publishDue = at;
  publishTimer = setTimeout(() => { publishDue = 0; runPublish(); }, at - now);
  await store.patchSession(api, { pendingPublishAt: at });
}

function runPublish(manual = false) {
  return serial(async () => {
    const result = await publish(api, { manual });
    if (result.action === 'defer') {
      if (result.reason === 'remote-first') scheduleApply(0);
      clearTimeout(publishTimer);
      await store.patchSession(api, { pendingPublishAt: Date.now() + result.delayMs });
      publishTimer = setTimeout(() => runPublish(manual), result.delayMs); // ručni zahtjev ostaje ručni
    } else if (result.action === 'wait-present') {
      await store.patchSession(api, { pendingPublishAt: Date.now() }); // bez budilice: javlja se povratak korisnika ili alarm
    } else {
      await store.patchSession(api, { pendingPublishAt: 0 });
    }
    return result;
  });
}

let restorePending = false;

function scheduleApply(delay = 800, restoreIfEmpty = false) {
  restorePending ||= restoreIfEmpty;
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => { const r = restorePending; restorePending = false; runApply(false, r); }, delay);
}

function runApply(manual = false, restoreIfEmpty = false) {
  return serial(async () => {
    const result = await checkApply(api, { manual, restoreIfEmpty });
    if (result.action === 'wait') scheduleApply(3_000, restoreIfEmpty); // zahtjev "napuni prazan prozor" ostaje
    return result;
  });
}

async function ensureIdentity() {
  const s = await store.getSettings(api);
  if (s.deviceId) return s;
  const info = await api.runtime.getPlatformInfo();
  const name = info.os === 'mac' ? 'Mac' : info.os === 'win' ? 'Windows' : info.os;
  return store.patchSettings(api, { deviceId: store.newDeviceId(), deviceName: name });
}

/** Chrome pri pokretanju sam vraća tabove; usklađivanje kreće tek kad se broj tabova smiri (inače dupli tabovi). */
async function waitForStableTabs(maxMs = 10_000) {
  const end = Date.now() + maxMs;
  let last = -1;
  while (Date.now() < end) {
    const n = (await api.tabs.query({})).length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 900));
  }
}

let reconcileRunning = false;

/** Nakon pokretanja: lokalno uskladi sa zajedničkim prije prve objave (vidi lease.decidePublish 'reconciling'). */
async function runReconcile() {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    await waitForStableTabs();
    const result = await serial(() => checkApply(api, { reconcile: true }));
    if (result.action === 'wait' && !(await store.getSession(api)).reconciled) setTimeout(runReconcile, 3_000);
  } finally {
    reconcileRunning = false;
  }
}

/** Novi preglednik (ili nova verzija proširenja): session storage je prazan → zapamti start i uskladi se. */
async function markStarted() {
  const session = await store.getSession(api);
  await api.alarms.create(ALARM, { periodInMinutes: 0.5 });
  if (session.startedAt) return;
  await store.patchSession(api, { startedAt: Date.now(), reconciled: false });
  runReconcile();
}

// --- događaji tabova i grupa → objava ---
const structural = () => schedulePublish('structure');
api.tabs.onCreated.addListener(structural);
api.tabs.onRemoved.addListener((_id, info) => {
  schedulePublish(info.isWindowClosing ? 'windowRemoved' : 'structure');
  if (!info.isWindowClosing) persistOriginPairs(api); // gašenje Chromea zatvara sve — parovi moraju preživjeti
});
api.tabs.onMoved.addListener(structural);
api.tabs.onAttached.addListener(structural);
api.tabs.onDetached.addListener(structural);
api.tabs.onActivated.addListener(() => schedulePublish('active'));
api.tabs.onUpdated.addListener((_id, change) => {
  if ('url' in change || 'pinned' in change || 'groupId' in change) structural();
});
api.tabGroups.onCreated.addListener(structural);
api.tabGroups.onUpdated.addListener(structural);
api.tabGroups.onRemoved.addListener(structural);
api.tabGroups.onMoved.addListener(structural);
api.windows.onCreated.addListener((win) => {
  structural();
  if (win.type === 'normal' && !win.incognito) scheduleApply(300, true); // novi prazan prozor → napuni ga
});
api.windows.onRemoved.addListener(() => schedulePublish('windowRemoved'));

// --- korisnik se vratio za ovo računalo: prvo preuzmi što je stiglo, pa objavi što je čekalo ---
async function onUserBack() {
  const pending = (await store.getSession(api)).pendingPublishAt;
  runApply();
  if (pending) runPublish();
}
api.windows.onFocusChanged.addListener((id) => { if (id !== api.windows.WINDOW_ID_NONE) onUserBack(); });
api.idle.onStateChanged.addListener((state) => { if (state === 'active') onUserBack(); });

// --- navigacije tabova koje je Tab Mirror otvorio: stranica (preusmjerenje) ili korisnik (vidi origins.js) ---
const onNavigation = (kind) => async (d) => { if (await trackOrigin(api, kind, d)) structural(); };
api.webNavigation.onCommitted.addListener(onNavigation('commit'));
api.webNavigation.onHistoryStateUpdated.addListener(onNavigation('history'));
api.webNavigation.onReferenceFragmentUpdated.addListener(onNavigation('history'));

// --- tuđe stanje stiglo → primjena ---
api.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  const me = (await store.getSettings(api)).deviceId;
  if (Object.keys(changes).some((k) => k.startsWith('m.') && k !== `m.${me}`)) scheduleApply();
});

api.runtime.onStartup.addListener(() => markStarted());

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureIdentity();
  await markStarted();
  if (reason === 'install') await api.runtime.openOptionsPage();
  // Proširenje ne može samo ugasiti Chromeovu sinkronizaciju grupa, pa pri nadogradnji jednom otvori uputu.
  if (reason === 'update' && !(await store.getSettings(api)).chromeSyncNoteShown) {
    try {
      await api.tabs.create({ url: api.runtime.getURL('ui/options.html#chrome-sync'), active: true });
      await store.patchSettings(api, { chromeSyncNoteShown: true });
    } catch { /* nema otvorenog prozora: uputa je i dalje u postavkama */ }
  }
  refreshBadge(api);
});

api.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== ALARM) return;
  const session = await store.getSession(api);
  if (session.pendingPublishAt && session.pendingPublishAt <= Date.now()) runPublish();
  if (!session.reconciled) runReconcile();
  scheduleApply(0); // sigurnosna mreža: ako je događaj iz synca propušten dok je worker spavao
});

// --- popup i postavke ---
const actions = {
  status: () => buildStatus(api),
  takeControl: () => runPublish(true),
  applyNow: () => runApply(true),
  restore: async ({ index }) => {
    const restored = await serial(() => restoreFromHistory(api, index));
    return restored.action === 'restored' ? runPublish(true) : restored;
  },
  setPaused: async ({ value }) => { await store.patchSettings(api, { paused: !!value }); if (!value) scheduleApply(0); },
  setAutoApply: ({ value }) => store.patchSettings(api, { autoApply: !!value }),
  setName: ({ value }) => store.patchSettings(api, { deviceName: String(value || '').slice(0, 40) }),
  dismissConflict: () => store.patchState(api, { conflictRev: 0 }),
  clearShared: () => serial(async () => {
    const keys = allSlotKeys(await api.storage.sync.get(null));
    if (keys.length) await api.storage.sync.remove(keys);
    await store.patchSettings(api, { initialized: false });
    // maxSeenRev ostaje: nove objave moraju imati veću reviziju od svega što drugo računalo već zna
    await store.patchState(api, { lastPublished: null, lastApplied: null, sharedHashes: [], baseUrls: null });
    return { removed: keys.length };
  }),
};

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== api.runtime.id || !actions[msg?.type]) return false;
  ensureIdentity()
    .then(() => actions[msg.type](msg))
    .then((r) => reply({ ok: true, result: r ?? null }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

ensureIdentity().then(markStarted).then(() => refreshBadge(api));
