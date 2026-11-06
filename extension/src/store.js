// Stanje proširenja. Service worker (MV3) Chrome gasi nakon ~30 s mirovanja, pa ništa važno ne smije živjeti
// samo u memoriji: postavke i stanje sinkronizacije su u storage.local, kratkotrajno (start, primjena) u storage.session.

const SETTINGS_KEY = 'tm.settings';
const STATE_KEY = 'tm.state';
const HISTORY_KEY = 'tm.history';
const DEBUG_KEY = 'tm.debug';
const SESSION_KEY = 'tm.session';

export const DEFAULT_SETTINGS = { deviceId: '', deviceName: '', autoApply: true, paused: false, initialized: false, chromeSyncNoteShown: false };
export const DEFAULT_STATE = {
  lastPublished: null, // { rev, ts, sh }
  lastPublishedSnapshot: null,
  lastApplied: null, // { rev, dev, name, ts, sh }
  sharedHashes: [], // trenutno zajedničko stanje → isto se ne objavljuje ponovno (zaštita od petlje)
  maxSeenRev: 0,
  conflictRev: 0, // > 0 = moje stanje je prepisano starijim; spremljeno u povijest
  lastError: '',
  pendingApply: false,
  baseUrls: null, // adrese zadnjeg zajedničkog stanja koje ovo računalo zna (vidi planner.localOnlyUrls)
  knownBases: [], // { rev, urls } stanja koja znaju oba računala: baza pri sukobu, da se tabovi koje drugo nije vidjelo ne zatvore
  originPairs: [], // [izvorna, preusmjerena] adresa tabova s vezom — preživi restart Chromea (origins.rebuildOrigins)
};

async function read(area, key, defaults) {
  const got = await area.get(key);
  return { ...defaults, ...(got[key] || {}) };
}

// Čitaj-pa-piši mora ići jedan po jedan: inače dva istodobna patcha (npr. događaj taba i pokretanje) pregaze
// jedan drugome polja. Sve izmjene stanja idu kroz ovaj red.
let chain = Promise.resolve();

/** @param {object|function(object): object} changes izmjene, ili funkcija koja ih računa iz trenutnog stanja */
function patch(area, key, defaults, changes) {
  const run = chain.then(async () => {
    const current = await read(area, key, defaults);
    const next = { ...current, ...(typeof changes === 'function' ? changes(current) : changes) };
    await area.set({ [key]: next });
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

export const getSettings = (api) => read(api.storage.local, SETTINGS_KEY, DEFAULT_SETTINGS);
export const patchSettings = (api, c) => patch(api.storage.local, SETTINGS_KEY, DEFAULT_SETTINGS, c);
export const getState = (api) => read(api.storage.local, STATE_KEY, DEFAULT_STATE);
export const patchState = (api, c) => patch(api.storage.local, STATE_KEY, DEFAULT_STATE, c);
const SESSION_DEFAULTS = {
  startedAt: 0, applyingUntil: 0, lastWriteAt: 0, writeTimes: [], pendingPublishAt: 0,
  reconciled: false, // nakon pokretanja Chromea: dok se lokalno ne uskladi sa zajedničkim, ništa se ne objavljuje
  applyFails: null, // { rev, n, at } primjena koja nije uspjela: ponavlja se, a objava čeka
  remoteWait: null, // { rev, since } objava čeka tuđe stanje koje još stiže
  origins: {}, // tabId → { k, l, t } veza taba s adresom za koju je otvoren (origins.js; ID-jevi vrijede do gašenja Chromea)
};
export const getSession = (api) => read(api.storage.session, SESSION_KEY, SESSION_DEFAULTS);
export const patchSession = (api, c) => patch(api.storage.session, SESSION_KEY, SESSION_DEFAULTS, c);
export const getDebug = async (api) => (await api.storage.local.get(DEBUG_KEY))[DEBUG_KEY] || {};

export async function getHistory(api) {
  return (await api.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
}

export async function setHistory(api, list) {
  await api.storage.local.set({ [HISTORY_KEY]: list });
}

/**
 * Hashevi TRENUTNOG zajedničkog stanja (ciljno + ono što je Chrome stvarno postigao pri primjeni).
 * Namjerno se ne pamte starija stanja: povratak na raniji raspored (otvoriš pa zatvoriš tab) mora se objaviti.
 */
export function currentShared(...hashes) {
  return [...new Set(hashes.filter(Boolean))];
}

/** Kratak nasumičan ID uređaja (ključevi u syncu moraju biti kratki zbog kvote). */
export function newDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

/** Korisnik upravo radi na OVOM računalu: aktivan unutar 60 s i Chrome je prozor u fokusu. */
export async function isUserPresent(api) {
  const debug = await getDebug(api);
  if (debug.presence === 'present') return true; // samo za automatske testove
  if (debug.presence === 'absent') return false;
  const idle = await api.idle.queryState(60);
  if (idle !== 'active') return false;
  try {
    const win = await api.windows.getLastFocused();
    return !!win?.focused && !win.incognito;
  } catch {
    return false;
  }
}
