// Chrome pri pokretanju vrati svaki tab dvaput (viđeno na Windowsu 16.11.2026: 62 taba → 124, u istim grupama).
// Kopija adrese koju oba računala već imaju nije nov tab: usklađivanje je zatvara i ne smije stići na drugo računalo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchDevice, createCloud, startSite, layout, waitFor, sleep } from './harness.js';

let mac, win, cloud, site;
const ours = (lay) => lay.snap.w.flatMap((w) => w.t.map((t) => ({ u: t[0], p: t[1], g: t[2] >= 0 ? w.g[t[2]].n : '' })));
const counts = (lay) => {
  const m = new Map();
  for (const t of ours(lay)) m.set(t.u, (m.get(t.u) || 0) + 1);
  return m;
};
const dupes = async (d) => [...counts(await layout(d))].filter(([, n]) => n > 1).map(([u]) => u);
const sameTabs = async () => {
  const key = (lay) => ours(lay).map((t) => `${t.u}|${t.p}|${t.g}`).sort().join('\n');
  return key(await layout(mac)) === key(await layout(win));
};
const present = async (d, other) => { await other.setDebug({ presence: 'absent', graceMs: 0 }); await d.setDebug({ presence: 'present', graceMs: 0 }); };

before(async () => {
  site = await startSite();
  [mac, win] = await Promise.all([launchDevice('mac'), launchDevice('win')]);
  await mac.setName('Mac');
  await win.setName('Windows');
  await present(mac, win);
  cloud = createCloud([mac, win]);
  cloud.start(300);
  await mac.eval(async (u) => {
    const [w] = await chrome.windows.getAll();
    await chrome.tabs.create({ url: u.pin, windowId: w.id, pinned: true, active: false });
    const gh = [];
    for (const x of u.gh) gh.push((await chrome.tabs.create({ url: x, windowId: w.id, active: false })).id);
    const g = await chrome.tabs.group({ tabIds: gh });
    await chrome.tabGroups.update(g, { title: 'GITHUB', color: 'blue' });
    for (const x of u.loose) await chrome.tabs.create({ url: x, windowId: w.id, active: false });
    await chrome.tabs.create({ url: u.active, windowId: w.id, active: true });
  }, { pin: site.url('pin'), gh: ['gh-a', 'gh-b', 'gh-c'].map(site.url), loose: ['x', 'y'].map(site.url), active: site.url('aktivan') });
  await mac.clickButton(await mac.options(), 'Ovo računalo je izvor');
  await sleep(2000);
  await win.clickButton(await win.options(), 'Preuzmi raspored s računala');
  await waitFor(sameTabs, { label: 'Windows = Mac' });
  await sleep(3000);
});

after(async () => {
  cloud?.stop();
  await Promise.allSettled([mac?.close(), win?.close()]);
  site?.close();
});

test('J: Chrome na startu udvostruči sve tabove → nakon usklađivanja svaki tab jednom, a novi tab ipak stiže na Mac', async () => {
  const before = await layout(win);
  const total = ours(before).length;
  assert.deepEqual(await dupes(win), [], 'polazno bez duplikata');
  await win.setDebug({ presence: 'absent', graceMs: 0 }); // računalo se pali, korisnik još nije za njim
  // Kao Chromeovo vraćanje sesije: iza svakog taba njegova kopija, u istoj grupi i isto prikvačena.
  await win.eval(async () => {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || t.pendingUrl || '')).sort((a, b) => b.index - a.index);
    for (const t of tabs) {
      const copy = await chrome.tabs.create({ url: t.url || t.pendingUrl, windowId: t.windowId, index: t.index + 1, pinned: t.pinned, active: false });
      if (t.groupId >= 0) await chrome.tabs.group({ groupId: t.groupId, tabIds: [copy.id] });
    }
  });
  await win.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('samo-pc')); // stvarno nov tab
  await waitFor(async () => ours(await layout(win)).length === total * 2 + 1, { label: 'udvostručeno na Windowsu' });
  await win.reloadExtension(); // briše sesiju kao pokretanje Chromea → usklađivanje

  await waitFor(async () => (await dupes(win)).length === 0, { timeout: 30_000, label: 'Windows nakon usklađivanja bez duplikata' });
  const after = await layout(win);
  assert.equal(ours(after).length, total + 1, 'svaki tab jednom + novi tab');
  assert.ok(counts(after).get(site.url('samo-pc')) === 1, 'novi tab s PC-a ostaje');
  assert.deepEqual(after.groups.map((g) => g.title), ['GITHUB'], 'jedna grupa GITHUB');
  assert.equal(ours(after).filter((t) => t.g === 'GITHUB').length, 3, 'GITHUB ima svoja 3 taba');
  assert.equal(ours(after).filter((t) => t.p).length, 1, 'jedan prikvačen tab');

  await present(win, mac); // korisnik sjeo za PC
  await waitFor(async () => counts(await layout(mac)).get(site.url('samo-pc')) === 1, { timeout: 45_000, label: 'novi tab stigao na Mac' });
  await waitFor(sameTabs, { timeout: 15_000, label: 'isti tabovi na oba' });
  assert.deepEqual(await dupes(mac), [], 'Mac nije dobio duplikate');
});

test('K: duplikat koji se pojavi dok radiš (npr. Chromeova sinkronizacija grupa) zatvori se i ne stiže na drugo računalo', async () => {
  await present(mac, win); // korisnik je za Macom
  await waitFor(sameTabs, { timeout: 30_000, label: 'polazno isto' });
  await mac.eval(async (u) => {
    const [g] = await chrome.tabGroups.query({ title: 'GITHUB' });
    const copy = await chrome.tabs.create({ url: u.gh, active: false });
    await chrome.tabs.group({ groupId: g.id, tabIds: [copy.id] });
    await chrome.tabs.create({ url: u.novi, active: false }); // i jedan stvarno nov tab, da objava krene
  }, { gh: site.url('gh-b'), novi: site.url('novi-na-macu') });
  await waitFor(async () => counts(await layout(win)).get(site.url('novi-na-macu')) === 1, { timeout: 30_000, label: 'nov tab stigao na PC' });
  assert.deepEqual(await dupes(mac), [], 'Mac je zatvorio kopiju');
  assert.deepEqual(await dupes(win), [], 'PC nije dobio kopiju');
  await waitFor(sameTabs, { timeout: 15_000, label: 'isti tabovi na oba' });
  const history = await mac.eval(async () => (await chrome.storage.local.get('tm.history'))['tm.history'] || []);
  assert.ok(history.some((e) => e.label === 'Prije zatvaranja duplih tabova'), 'stanje prije zatvaranja je u povijesti');
});
