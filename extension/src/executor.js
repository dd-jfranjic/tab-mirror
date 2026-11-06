// Izvršitelj: provodi plan na pravim Chrome API-jima (api = chrome ili njegova zamjena).
// Redoslijed je bitan zbog pravila Chromea: grupirani tabovi moraju biti jedan do drugog, zakvačeni tabovi ne mogu
// biti u grupi i stoje na početku. Zato: stvori/premjesti → pin → makni iz krive grupe → poredaj → grupiraj → svojstva
// → aktivni tab (provjera; ne poklapa li se, drugi prolaz od čistog stanja) → sačuvane lokalne tabove vrati u njihove
// grupe (kept.js) → zatvori višak → uspavaj nove.

import { isMirroredWindow, isSyncableUrl, tabUrl, serialize, canonicalString } from './snapshot.js';
import { matchWindows, assignTabs, mapGroups, localOnlyUrls, withoutTabs } from './planner.js';
import { originKey, originEntries } from './origins.js';
import { planKeptGroups, regroupKept } from './kept.js';

/** @param {object} origins veze tabova (origins.js) — preusmjerena stranica se i dalje sparuje po izvornoj adresi */
async function readLocal(api, origins) {
  const wins = (await api.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter(isMirroredWindow);
  return wins.map((w) => ({
    id: w.id,
    tabs: (w.tabs || []).map((t) => ({
      id: t.id, url: tabUrl(t), key: originKey(origins[t.id], tabUrl(t)) ?? undefined, pinned: t.pinned, groupId: t.groupId, active: t.active, index: t.index,
    })),
  }));
}

async function ensureWindow(api, winId, firstUrl, firstTabId, created) {
  if (winId !== null) return { winId, firstTabId: null };
  // Postojeći tab (iz drugog prozora) prenesi u novi prozor; inače novi prozor otvori s prvom adresom.
  const win = await api.windows.create(firstTabId !== null ? { tabId: firstTabId, focused: false } : { url: firstUrl, focused: false });
  if (firstTabId !== null) return { winId: win.id, firstTabId: null };
  const newTabId = win.tabs?.[0]?.id ?? (await api.tabs.query({ windowId: win.id }))[0].id;
  created.add(newTabId);
  return { winId: win.id, firstTabId: newTabId };
}

/** Otvori što fali (tab koji Chrome odbije se preskače, ne ruši cijelu primjenu), premjesti, zakvači. */
async function placeTabs(api, winId, tw, ids, created) {
  const failed = new Set();
  for (let k = 0; k < tw.t.length; k++) {
    if (ids[k] !== null) continue;
    try {
      const tab = await api.tabs.create({ windowId: winId, url: tw.t[k][0], active: false, pinned: !!tw.t[k][1] });
      ids[k] = tab.id;
      created.add(tab.id);
    } catch {
      failed.add(k);
    }
  }
  const ew = withoutTabs(tw, failed);
  const eids = ids.filter((_, k) => !failed.has(k));
  const tabs = await Promise.all(eids.map((id) => api.tabs.get(id)));
  const elsewhere = eids.filter((id, k) => tabs[k].windowId !== winId);
  if (elsewhere.length) await api.tabs.move(elsewhere, { windowId: winId, index: -1 });
  for (let k = 0; k < eids.length; k++) {
    if (!!tabs[k].pinned !== !!ew.t[k][1]) await api.tabs.update(eids[k], { pinned: !!ew.t[k][1] });
  }
  return { ew, eids };
}

async function orderTabs(api, winId, tw, ids) {
  const pinned = ids.filter((_, k) => tw.t[k][1]);
  const loose = ids.filter((_, k) => !tw.t[k][1]);
  if (pinned.length) await api.tabs.move(pinned, { windowId: winId, index: 0 });
  if (loose.length) await api.tabs.move(loose, { windowId: winId, index: pinned.length });
}

async function currentGroups(api, ids) {
  const tabs = await Promise.all(ids.map((id) => api.tabs.get(id)));
  return new Map(tabs.map((t) => [t.id, t.groupId ?? -1]));
}

/** Chrome ugasi grupu čim iz nje izađu svi tabovi (npr. pri slaganju), pa zapamćene grupe možda više nema: tada nova. */
async function groupTabs(api, winId, tabIds, groupId) {
  const fresh = { tabIds, createProperties: { windowId: winId } };
  if (groupId === null) return api.tabs.group(fresh);
  try {
    return await api.tabs.group({ groupId, tabIds });
  } catch (err) {
    if (!/no group/i.test(String(err?.message))) throw err;
    return api.tabs.group(fresh);
  }
}

async function applyGroups(api, winId, tw, ids, fresh) {
  const now = await currentGroups(api, ids);
  const mapped = fresh ? tw.g.map(() => null) : mapGroups(now, tw, ids);
  const wrong = ids.filter((id, k) => {
    const gid = now.get(id);
    const want = tw.t[k][2] >= 0 ? mapped[tw.t[k][2]] : -1;
    return gid >= 0 && (fresh || gid !== want);
  });
  if (wrong.length) await api.tabs.ungroup(wrong);
  await orderTabs(api, winId, tw, ids);
  for (let gi = 0; gi < tw.g.length; gi++) {
    const members = ids.filter((_, k) => tw.t[k][2] === gi);
    if (!members.length) continue;
    const gid = await groupTabs(api, winId, members, mapped[gi]);
    const g = tw.g[gi];
    await api.tabGroups.update(gid, { title: g.n, color: g.c, collapsed: false });
  }
}

async function finishWindow(api, tw, ids) {
  if (tw.a >= 0 && ids[tw.a] !== undefined) await api.tabs.update(ids[tw.a], { active: true });
  const groups = await currentGroups(api, ids);
  for (let gi = 0; gi < tw.g.length; gi++) {
    if (!tw.g[gi].x) continue;
    const k = tw.t.findIndex((t) => t[2] === gi);
    if (k >= 0) await api.tabGroups.update(groups.get(ids[k]), { collapsed: true });
  }
}

/**
 * Provjera nakon primjene; gledaju se samo tabovi cilja, po ciljnoj adresi (preusmjerenje nije razlika).
 * Aktivni tab se ne uspoređuje: kad je na drugom računalu aktivna interna stranica (nova kartica), cilj nema aktivnog
 * taba, a lokalni aktivni ostaje. To nije greška rasporeda i ne smije srušiti i iznova složiti sve grupe.
 */
async function windowMatches(api, winId, tw, ids) {
  const win = await api.windows.get(winId, { populate: true });
  const groups = await api.tabGroups.query({ windowId: winId });
  const want = new Map(ids.map((id, k) => [id, tw.t[k][0]]));
  const tabs = win.tabs.filter((t) => want.has(t.id)).map((t) => ({ ...t, url: want.get(t.id), pendingUrl: undefined }));
  const got = serialize([{ ...win, tabs }], groups).w[0] || { t: [], g: [], a: -1 };
  const shape = (w) => canonicalString({ v: 1, w: [{ t: w.t, g: w.g, a: -1 }] });
  return shape(got) === shape(tw);
}

async function applyWindow(api, tw, winId, ids, created) {
  const ensured = await ensureWindow(api, winId, tw.t[0][0], ids[0], created);
  if (ensured.firstTabId !== null) ids[0] = ensured.firstTabId;
  const { ew, eids } = await placeTabs(api, ensured.winId, tw, ids, created);
  await applyGroups(api, ensured.winId, ew, eids, false);
  await finishWindow(api, ew, eids);
  if (!(await windowMatches(api, ensured.winId, ew, eids))) {
    await applyGroups(api, ensured.winId, ew, eids, true); // drugi prolaz: sve grupe iznova, deterministički
    await finishWindow(api, ew, eids);
  }
  return { ew, eids };
}

const COMMIT_WAIT_MS = 8_000;

/** Uspavati se smije tek kad tab ima adresu: tab uspavan prije toga izgubi adresu (provjereno u Chromiumu). */
async function sleepWhenCommitted(api, id) {
  const end = Date.now() + COMMIT_WAIT_MS;
  while (Date.now() < end) {
    let tab;
    try { tab = await api.tabs.get(id); } catch { return; } // tab je u međuvremenu zatvoren
    if (tab.active || tab.discarded) return;
    if (tab.url && !tab.pendingUrl) {
      try { await api.tabs.discard(id); } catch { /* Chrome ga trenutno ne može uspavati — ostaje budan */ }
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function closeAndSleep(api, closeIds, created, keepAwake) {
  const alive = new Set((await api.tabs.query({})).map((t) => t.id));
  const toClose = closeIds.filter((id) => alive.has(id));
  if (toClose.length) await api.tabs.remove(toClose);
  const sleepers = [...created].filter((id) => alive.has(id) && !keepAwake.has(id));
  await Promise.all(sleepers.map((id) => sleepWhenCommitted(api, id)));
}

async function navigateTabs(api, navigate, created) {
  for (const { tabId, url } of navigate) {
    try {
      await api.tabs.update(tabId, { url });
      created.add(tabId); // nova adresa → nakon učitavanja uspavaj kao i novi tab
    } catch { /* tab je zatvoren u međuvremenu — planer će ga sljedeći put stvoriti */ }
  }
}

/**
 * Posloži lokalni Chrome prema snapshotu.
 * @param {object} [opts]
 * @param {string[]|null} [opts.baseUrls] adrese zadnjeg zajedničkog stanja; tabovi izvan njega se ne zatvaraju
 * @param {object} [opts.origins] veze tabova iz prošle primjene (origins.js)
 * @param {boolean} [opts.selfMoved] prepoznaj tab koji je sam promijenio adresu (ne pri pokretanju Chromea ni pri sukobu)
 * @returns {Promise<{created: number, closed: number, kept: number, origins: object, error?: Error}>}
 *   kept = sačuvani tabovi koje drugo računalo još nema
 *   error = primjena je stala na pola; origins tada drži i veze tabova koji su do tada otvoreni
 */
export async function applySnapshot(api, target, { baseUrls = null, origins = {}, selfMoved = false } = {}) {
  const local = await readLocal(api, origins);
  const winMatch = matchWindows(local, target.w);
  const { assign, navigate, closeTabIds, keptTabIds } = assignTabs(local, target.w, winMatch, localOnlyUrls(local, baseUrls), selfMoved ? baseUrls : null);
  const titleOf = new Map((await api.tabGroups.query({})).map((g) => [g.id, g.title || '']));
  // Interna stranica (chrome://) se ne prenosi ni ne zatvara, ali u grupi mora pratiti grupu, kao i sačuvani tab.
  const internalTabIds = local.flatMap((lw) => lw.tabs.filter((t) => !isSyncableUrl(t.url) && t.groupId >= 0).map((t) => t.id));
  const keptPlan = planKeptGroups(local, [...keptTabIds, ...internalTabIds], target.w, assign, titleOf, closeTabIds, winMatch); // prije primjene: assign se puni novim tabovima
  const created = new Set();
  const keepAwake = new Set();
  const keys = {}; // tabId → ciljna adresa
  let failure;
  try {
    await navigateTabs(api, navigate, created);
    for (let i = 0; i < target.w.length; i++) {
      const { ew, eids } = await applyWindow(api, target.w[i], winMatch[i], assign[i], created);
      eids.forEach((id, k) => { keys[id] = ew.t[k][0]; });
      if (ew.a >= 0) keepAwake.add(eids[ew.a]);
    }
    await regroupKept(api, keptPlan, target.w, assign);
    await closeAndSleep(api, closeTabIds, created, keepAwake);
  } catch (error) {
    // Ciljna adresa svakog taba otvorenog prije pada (sparuje se i ako ga je stranica preusmjerila); stare veze ostaju.
    failure = error;
    await regroupKept(api, keptPlan, target.w, assign); // inače stara grupa sa sačuvanim tabom ostane zauvijek
    assign.forEach((ids, i) => ids.forEach((id, k) => { if (id !== null) keys[id] = target.w[i].t[k][0]; }));
  }
  const fresh = originEntries(keys, await api.tabs.query({}), Date.now(), created);
  const kept = keptTabIds.length;
  if (failure) return { created: created.size, closed: 0, kept, origins: { ...origins, ...fresh }, error: failure };
  return { created: created.size, closed: closeTabIds.length, kept, origins: fresh };
}
