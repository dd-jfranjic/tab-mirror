// Cjeloviti scenarij na dva prava Chromiuma: Mac složi raspored → Windows ga preuzme → promjene u oba smjera
// → bez petlje → nikad prazno stanje → povijest. Pokretanje: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchDevice, createCloud, startSite, layout, waitFor, sleep } from './harness.js';

let mac, win, cloud, site;
const sameLayout = async () => (await layout(mac)).canon === (await layout(win)).canon;
const revs = async (d) => d.eval(async () => Object.entries(await chrome.storage.sync.get(null)).filter(([k]) => k.startsWith('m.')).map(([, m]) => `${m.dev}:${m.rev}`).sort().join(','));

async function buildMacLayout(u) {
  await mac.eval(async (u) => {
    const [first] = await chrome.windows.getAll();
    const t = async (url, windowId, extra = {}) => (await chrome.tabs.create({ url, windowId, active: false, ...extra })).id;
    await t(u.pin, first.id, { pinned: true });
    const work = [await t(u.a, first.id), await t(u.b, first.id)];
    await t(u.c, first.id);
    const shop = [await t(u.d, first.id), await t(u.e, first.id)];
    const g1 = await chrome.tabs.group({ tabIds: work });
    await chrome.tabGroups.update(g1, { title: 'Posao', color: 'red' });
    const g2 = await chrome.tabs.group({ tabIds: shop });
    await chrome.tabGroups.update(g2, { title: 'Kupnja', color: 'green', collapsed: true });
    await chrome.tabs.update(work[1], { active: true });
    const w2 = await chrome.windows.create({ url: u.f, focused: false });
    await t(u.g, w2.id);
  }, u);
}

before(async () => {
  site = await startSite();
  [mac, win] = await Promise.all([launchDevice('mac'), launchDevice('win', { userAgent: 'Mozilla/5.0 TabMirrorWin' })]);
  await mac.setName('Mac');
  await win.setName('Windows');
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  cloud = createCloud([mac, win]);
  cloud.start(300);
});

after(async () => {
  cloud?.stop();
  await Promise.allSettled([mac?.close(), win?.close()]);
  site?.close();
});

test('oba računala imaju istu oznaku proširenja (stalni ključ u manifestu)', () => {
  const expected = readFileSync(resolve(import.meta.dirname, '../../keys/extension-id.txt'), 'utf8').trim();
  assert.equal(mac.id, expected);
  assert.equal(win.id, expected);
});

test('prije postavljanja ništa se ne objavljuje', async () => {
  const u = Object.fromEntries('pin a b c d e f g'.split(' ').map((k) => [k, site.url(k)]));
  await buildMacLayout(u);
  await sleep(2500);
  assert.equal(await revs(mac), '');
});

test('Mac "Ovo računalo je izvor" → Windows "Preuzmi" → isti raspored', async () => {
  const macOpts = await mac.options();
  await mac.clickButton(macOpts, 'Ovo računalo je izvor');
  await waitFor(async () => (await revs(win)).startsWith('m') || (await revs(win)).length > 0, { label: 'stanje stiglo na Windows' });
  const winOpts = await win.options();
  await win.clickButton(winOpts, 'Preuzmi raspored s računala „Mac“');
  await waitFor(sameLayout, { label: 'Windows = Mac' });
  const { snap } = await layout(win);
  assert.equal(snap.w.length, 2);
  const groups = snap.w.flatMap((w) => w.g);
  assert.deepEqual(groups.map((g) => [g.n, g.c, g.x]).sort(), [['Kupnja', 'green', 1], ['Posao', 'red', 0]]);
});

test('novi tabovi na Windowsu spavaju (ne učitavaju se) osim aktivnih, i zadržavaju adresu', async () => {
  const httpTabs = async () => (await layout(win)).windows.flatMap((w) => w.tabs).filter((t) => /^http/.test(t.url));
  await waitFor(async () => (await httpTabs()).every((t) => t.discarded || t.active), { label: 'uspavani tabovi' });
  const tabs = await httpTabs();
  assert.equal(tabs.length, 8);
  assert.ok(tabs.filter((t) => t.discarded).length >= 6);
  assert.ok(await sameLayout(), 'uspavani tabovi zadržali adrese');
});

test('promjene na Macu (nova grupa, preimenovanje, premještanje, zatvaranje, pin) stižu na Windows', async () => {
  await mac.eval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const byUrl = (x) => tabs.find((t) => t.url === x);
    const posao = (await chrome.tabGroups.query({ title: 'Posao' }))[0];
    await chrome.tabGroups.update(posao.id, { title: 'Posao 2026', color: 'blue' });
    await chrome.tabs.remove(byUrl(u.c).id);
    await chrome.tabs.update(byUrl(u.g).id, { pinned: true });
    const n = await chrome.tabs.create({ url: u.n, active: false, windowId: byUrl(u.f).windowId });
    const g = await chrome.tabs.group({ tabIds: [n.id, byUrl(u.f).id] });
    await chrome.tabGroups.update(g, { title: 'Novo', color: 'purple' });
    await chrome.tabs.move(byUrl(u.a).id, { index: -1 });
  }, { c: site.url('c'), g: site.url('g'), f: site.url('f'), n: site.url('n'), a: site.url('a') });
  await waitFor(sameLayout, { label: 'Windows prati Mac' });
});

test('korisnik sjedne za Windows → Windows postaje glavni, Mac ga prati', async () => {
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
  await win.setDebug({ presence: 'present', graceMs: 0 });
  await win.eval(async (url) => {
    const t = await chrome.tabs.create({ url, active: true });
    const g = await chrome.tabs.group({ tabIds: [t.id] });
    await chrome.tabGroups.update(g, { title: 'S Windowsa', color: 'yellow' });
  }, site.url('sa-windowsa'));
  await waitFor(async () => (await layout(mac)).canon.includes('S Windowsa') && sameLayout(), { label: 'Mac prati Windows' });
  const status = await mac.message('status');
  assert.equal(status.result.role, 'follower');
  assert.equal(status.result.newest.name, 'Windows');
});

test('stranica koja Windows preusmjeri na prijavu ne množi tabove pri idućim promjenama', async () => {
  const count = async () => (await layout(win)).windows.flatMap((w) => w.tabs).filter((t) => /\/(privatno|prijava)/.test(t.url)).length;
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  await mac.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('privatno'));
  await waitFor(async () => (await count()) === 1, { label: 'privatno stiglo na Windows' });
  for (const p of ['jos-1', 'jos-2']) {
    await mac.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url(p));
    await waitFor(async () => (await layout(win)).canon.includes(`/${p}`), { label: `promjena ${p}` });
    await sleep(1500);
  }
  assert.equal(await count(), 1);
  await mac.eval(async () => {
    const ids = (await chrome.tabs.query({})).filter((t) => /\/(privatno|jos-)/.test(t.url)).map((t) => t.id);
    await chrome.tabs.remove(ids);
  });
  await waitFor(async () => (await count()) === 0 && sameLayout(), { label: 'počišćeno' });
  await win.setDebug({ presence: 'present', graceMs: 0 });
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
});

test('preusmjerenje na prijavu ne prelazi na drugo računalo kad ono postane glavno', async () => {
  const canon = async (d) => (await layout(d)).canon;
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  await mac.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('privatno'));
  await waitFor(async () => (await canon(win)).includes('/prijava'), { label: 'Windows preusmjeren na prijavu' });
  await sleep(2000);
  // Ponovno učitavanje proširenja briše sesiju kao i restart Chromea → veza se mora vratiti iz trajno spremljenih parova.
  await win.reloadExtension();
  await sleep(2500);
  await mac.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('nakon-restarta'));
  await waitFor(async () => (await canon(win)).includes('/nakon-restarta'), { label: 'Windows prati i nakon restarta' });
  await sleep(1500);
  const loginTabs = (await layout(win)).windows.flatMap((w) => w.tabs).filter((t) => /\/(privatno|prijava)/.test(t.url));
  assert.equal(loginTabs.length, 1, 'nakon restarta nema duplog taba');
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
  await win.setDebug({ presence: 'present', graceMs: 0 });
  await win.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('win-vodi'));
  await waitFor(async () => (await canon(mac)).includes('/win-vodi'), { label: 'promjena s Windowsa stigla na Mac' });
  await sleep(1500);
  assert.ok((await canon(mac)).includes('/privatno'), 'Mac zadržao svoj pravi tab');
  assert.ok(!(await canon(mac)).includes('/prijava'), 'stranica za prijavu nije prešla na Mac');
  // Korisnik na Windowsu sam ode sa stranice za prijavu (poveznicom koja preusmjerava) → prava promjena, stiže na Mac.
  // Kao čovjek: otvori tab (uspavani se ponovno učita), pogleda ga, pa klikne. Neaktivnim tabom korisnik ne može navigirati.
  const loginTab = await win.eval(async (from) => {
    const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl) === from);
    await chrome.tabs.update(t.id, { active: true });
    return t.id;
  }, site.url('prijava'));
  await sleep(6000);
  await win.eval(async ({ id, to }) => { await chrome.tabs.update(id, { url: to }); }, { id: loginTab, to: site.url('kroz/rucno') });
  await waitFor(async () => (await canon(mac)).includes('/rucno') && !(await canon(mac)).includes('/privatno'), { label: 'korisnikova navigacija stigla na Mac' });
  await win.eval(async () => {
    const ids = (await chrome.tabs.query({})).filter((t) => /\/(rucno|win-vodi|nakon-restarta)/.test(t.url || t.pendingUrl)).map((t) => t.id);
    await chrome.tabs.remove(ids);
  });
  await waitFor(sameLayout, { label: 'počišćeno' });
});

test('bez petlje: kad se stanja izjednače, nema novih zapisa', async () => {
  await sleep(3000);
  const a = await revs(mac);
  await sleep(6000);
  assert.equal(await revs(mac), a);
  assert.ok(await sameLayout());
});

test('otvoriš pa zatvoriš tab na Windowsu → zatvaranje stiže i na Mac', async () => {
  const url = site.url('kratko');
  await win.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, url);
  await waitFor(async () => (await layout(mac)).canon.includes('/kratko'), { label: 'otvoreni tab na Macu' });
  await win.eval(async (url) => { const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl) === url); await chrome.tabs.remove(t.id); }, url);
  await waitFor(async () => !(await layout(mac)).canon.includes('/kratko') && sameLayout(), { label: 'zatvoreni tab nestao s Maca' });
});

test('zatvaranje svih tabova ne briše zajednički raspored (nikad prazno stanje)', async () => {
  const before = await revs(mac);
  const macLayout = (await layout(mac)).canon;
  await win.eval(async () => {
    const tabs = await chrome.tabs.query({});
    const syncable = tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl));
    await chrome.tabs.remove(syncable.map((t) => t.id));
  });
  await sleep(6000);
  assert.equal(await revs(mac), before);
  assert.equal((await layout(mac)).canon, macLayout);
});

test('prazan Chrome se sam napuni: novi prozor bez tabova dobije zajednički raspored', async () => {
  await win.eval(() => chrome.windows.create({ url: 'chrome://newtab/', focused: true }));
  await waitFor(sameLayout, { label: 'Windows napunjen zajedničkim rasporedom' });
  assert.ok((await layout(win)).snap.w.length > 0);
});

test('tab otvoren izvana (npr. poveznica iz maila) ne nestaje kad stigne promjena s drugog računala', async () => {
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await win.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('iz-maila'));
  await sleep(2500);
  await mac.eval(async (url) => { await chrome.tabs.create({ url, active: false }); }, site.url('mac-nova'));
  await waitFor(async () => (await layout(win)).canon.includes('/mac-nova'), { label: 'promjena s Maca stigla' });
  await sleep(1500);
  assert.ok((await layout(win)).canon.includes('/iz-maila'), 'vanjski tab ostao');
  await win.setDebug({ presence: 'present', graceMs: 0 });
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
  await win.eval(async () => { const t = (await chrome.tabs.query({}))[0]; await chrome.tabs.update(t.id, { active: true }); });
  await waitFor(async () => (await layout(mac)).canon.includes('/iz-maila') && sameLayout(), { label: 'vanjski tab stigao na Mac kad se radi na Windowsu' });
});

test('povijest: Windows vrati raspored jednim klikom i on opet postaje zajednički', async () => {
  const st = (await win.message('status')).result;
  assert.ok(st.history.length > 0);
  const idx = st.history.findIndex((h) => h.tabs > 0);
  const res = await win.message('restore', { index: idx });
  assert.ok(['publish', 'defer'].includes(res.result.action), JSON.stringify(res)); // defer = zapis za ~2 s (ograničenje brzine)
  try {
    await waitFor(async () => (await layout(win)).snap.w.length > 0 && sameLayout(), { label: 'vraćeno i zrcaljeno' });
  } catch (e) {
    console.log('REVS', await revs(win), '/', await revs(mac), 'res', JSON.stringify(res), 'idx', idx, JSON.stringify(st.history)); console.log('WIN', (await layout(win)).canon, '\nMAC', (await layout(mac)).canon, '\nMACST', JSON.stringify((await mac.message('status')).result), '\nMACSTATE', JSON.stringify(await mac.eval(async () => (await chrome.storage.local.get('tm.state'))['tm.state'].lastApplied)));
    throw e;
  }
});
