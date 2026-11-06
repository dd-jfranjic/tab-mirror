// Stanje za popup/postavke i značka na ikoni.

import { readMetas, pickNewest } from './slots.js';
import * as store from './store.js';

/** Uloga ovog uređaja laički: glavni, prati, pauza, čeka prvo postavljanje. */
export function roleOf(settings, newest) {
  if (settings.paused) return 'paused';
  if (!settings.initialized) return 'setup';
  if (!newest) return 'setup';
  return newest.dev === settings.deviceId ? 'leader' : 'follower';
}

export async function buildStatus(api) {
  const [settings, state, history, items] = await Promise.all([
    store.getSettings(api), store.getState(api), store.getHistory(api), api.storage.sync.get(null),
  ]);
  const metas = readMetas(items);
  const newest = pickNewest(metas);
  const lastSync = Math.max(state.lastPublished?.ts || 0, state.lastApplied?.ts || 0);
  const bytesInUse = api.storage.sync.getBytesInUse ? await api.storage.sync.getBytesInUse(null) : null;
  return {
    extensionId: api.runtime.id,
    settings,
    role: roleOf(settings, newest),
    newest: newest && { dev: newest.dev, name: newest.name, ts: newest.ts, tabs: newest.tabs, windows: newest.windows, groups: newest.groups, mine: newest.dev === settings.deviceId },
    devices: metas.map((m) => ({ dev: m.dev, name: m.name, ts: m.ts, mine: m.dev === settings.deviceId })),
    lastSync,
    conflict: state.conflictRev > 0,
    lastError: state.lastError,
    pendingApply: state.pendingApply,
    bytesInUse,
    history: history.map((e, index) => ({ index, label: e.label, at: e.at, tabs: e.tabs, windows: e.windows, groups: e.groups })),
  };
}

const BADGE = {
  paused: { text: '❚❚', color: '#6b7280' },
  setup: { text: '?', color: '#b45309' },
  error: { text: '!', color: '#b91c1c' },
};

export async function refreshBadge(api) {
  try {
    const [settings, state, items] = await Promise.all([store.getSettings(api), store.getState(api), api.storage.sync.get(null)]);
    const role = roleOf(settings, pickNewest(readMetas(items)));
    const key = state.conflictRev > 0 || state.lastError ? 'error' : role in BADGE ? role : null;
    await api.action.setBadgeText({ text: key ? BADGE[key].text : '' });
    if (key) await api.action.setBadgeBackgroundColor({ color: BADGE[key].color });
    await api.action.setTitle({ title: `Tab Mirror — ${settings.deviceName || 'ovaj uređaj'}` });
  } catch {
    /* značka nije bitna za sinkronizaciju */
  }
}
