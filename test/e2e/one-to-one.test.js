// „1:1“: što je na jednom računalu mora završiti i na drugom — bez druge grupe istog imena i bez izgubljenih promjena.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launchDevice, createCloud, startSite, layout, waitFor, sleep } from './harness.js';

let mac, win, cloud, site;
const sameLayout = async () => (await layout(mac)).canon === (await layout(win)).canon;
const sameTabs = async () => {
  const urls = (l) => l.snap.w.flatMap((w) => w.t.map((t) => `${t[0]}|${t[2] >= 0 ? w.g[t[2]].n : ''}`)).sort().join('\n');
  return urls(await layout(mac)) === urls(await layout(win));
};
const titles = (lay) => lay.groups.map((g) => g.title).sort();
const has = async (d, part) => (await layout(d)).canon.includes(part);
const addTab = (d, url, extra = {}) => d.eval(async ({ url, extra }) => { await chrome.tabs.create({ url, active: false, ...extra }); }, { url, extra });
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
    const ids = [];
    for (const x of [u.a, u.b]) ids.push((await chrome.tabs.create({ url: x, windowId: w.id, active: false })).id);
    await chrome.tabs.create({ url: u.c, windowId: w.id, active: true });
    const g = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(g, { title: 'github', color: 'blue' });
  }, { a: site.url('gh-a'), b: site.url('gh-b'), c: site.url('c') });
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

test('A: promjena dok korisnik nije prisutan stiže čim se vrati (bez nove promjene)', async () => {
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
  await addTab(mac, site.url('odsutan'));
  await sleep(4000); // objava je odbijena: nije prisutan
  await mac.setDebug({ presence: 'present', graceMs: 0 }); // vratio se, ništa više ne dira
  await waitFor(() => has(win, 'odsutan'), { timeout: 45_000, label: 'promjena stigla na Windows' });
});

test('B: tab koji postoji samo na Windowsu stiže i na Mac (oba imaju isto)', async () => {
  await present(mac, win);
  await addTab(win, site.url('samo-win'));
  await sleep(2500);
  await addTab(mac, site.url('s-maca'));
  await waitFor(() => has(win, 's-maca'), { label: 's-maca na Windowsu' });
  await present(win, mac); // korisnik sjeo za Windows, ništa ne dira
  await waitFor(() => has(mac, 'samo-win'), { timeout: 45_000, label: 'samo-win stigao na Mac' });
  await waitFor(sameTabs, { timeout: 15_000, label: 'isti tabovi na oba' });
});

test('C: aktivna interna stranica na Macu ne prepravlja grupe na Windowsu', async () => {
  await present(mac, win);
  const ids = async () => (await layout(win)).groups.map((g) => g.id).sort().join();
  await waitFor(sameTabs, { timeout: 15_000, label: 'polazno isto' });
  await win.eval(async () => { const [t] = await chrome.tabs.query({ title: '*c*' }); const all = await chrome.tabs.query({}); const web = all.find((x) => /^http/.test(x.url) && x.groupId < 0); if (web) await chrome.tabs.update(web.id, { active: true }); });
  await sleep(1000);
  const before = await ids();
  await mac.eval(async () => { await chrome.tabs.create({ url: 'chrome://version/', active: true }); });
  await sleep(7000);
  await addTab(mac, site.url('uz-internu'));
  await waitFor(() => has(win, 'uz-internu'), { label: 'uz-internu na Windowsu' });
  await sleep(2000);
  assert.equal(await ids(), before, 'ID grupe se promijenio: grupa je srušena i složena iznova');
});

test('D: interna stranica u grupi na Windowsu ne ostavlja drugu grupu istog imena', async () => {
  await present(mac, win);
  await win.eval(async () => {
    const g = (await chrome.tabGroups.query({ title: 'github' }))[0];
    const t = await chrome.tabs.create({ url: 'chrome://version/', active: false });
    await chrome.tabs.group({ groupId: g.id, tabIds: [t.id] });
  });
  await sleep(2500);
  // Mac zamijeni sve tabove grupe adresama druge domene (ne mogu se ponovno iskoristiti)
  const other = site.url('novi').replace('127.0.0.1', 'localhost');
  await mac.eval(async (url) => {
    const g = (await chrome.tabGroups.query({ title: 'github' }))[0];
    const old = (await chrome.tabs.query({ groupId: g.id })).map((t) => t.id);
    const n = await chrome.tabs.create({ url, active: false });
    await chrome.tabs.group({ groupId: g.id, tabIds: [n.id] });
    await chrome.tabs.remove(old);
  }, other);
  await waitFor(() => has(win, 'localhost'), { label: 'zamjena stigla na Windows' });
  await sleep(3000);
  assert.deepEqual(titles(await layout(win)), ['github']);
});

test('E: oba računala promijene nešto prije nego stigne sync → ništa se ne gubi', async () => {
  await present(mac, win);
  await waitFor(sameTabs, { timeout: 20_000, label: 'polazno isto' });
  cloud.stop();
  await sleep(500);
  await addTab(mac, site.url('mac-offline'));
  await sleep(4000);
  await present(win, mac);
  await addTab(win, site.url('win-offline'));
  await sleep(4000);
  cloud.start(300);
  await waitFor(() => has(mac, 'win-offline'), { timeout: 30_000, label: 'Windowsova promjena na Macu' });
  assert.ok(await has(mac, 'mac-offline'), 'Mac je zatvorio tab koji Windows nije vidio');
  await present(mac, win); // korisnik se vratio za Mac
  await waitFor(async () => (await has(mac, 'win-offline')) && (await has(win, 'mac-offline')) && (await has(mac, 'mac-offline')) && (await has(win, 'win-offline')),
    { timeout: 60_000, label: 'obje promjene na oba računala' });
  await waitFor(sameTabs, { timeout: 15_000, label: 'isti tabovi na oba' });
});

test('F: dvije grupe istog imena spoje se u jednu, a na drugo računalo stiže jedna', async () => {
  await present(mac, win);
  await waitFor(sameTabs, { timeout: 20_000, label: 'polazno isto' });
  await mac.eval(async (url) => {
    const t = await chrome.tabs.create({ url, active: false });
    const g = await chrome.tabs.group({ tabIds: [t.id] });
    await chrome.tabGroups.update(g, { title: 'github', color: 'grey' }); // kao otvorena spremljena grupa
  }, site.url('spremljena'));
  await waitFor(() => has(win, 'spremljena'), { timeout: 30_000, label: 'tab stigao na Windows' });
  await sleep(2000);
  assert.deepEqual(titles(await layout(mac)), ['github']);
  assert.deepEqual(titles(await layout(win)), ['github']);
});

test('G: nadogradnja jednom otvori uputu, a gumb otvara Chromeove postavke sinkronizacije', async () => {
  const noteTabs = async (d) => (await d.eval(async () => chrome.tabs.query({}))).filter((t) => (t.url || t.pendingUrl || '').endsWith('options.html#chrome-sync'));
  await win.reloadExtension();
  await waitFor(async () => (await noteTabs(win)).length === 1, { label: 'uputa otvorena' });
  const page = await win.browser.targets().find((t) => t.type() === 'page' && t.url().endsWith('#chrome-sync')).page();
  assert.ok(await page.evaluate(() => document.getElementById('chrome-sync').textContent.includes('Saved tab groups')));
  await page.click('#openSync');
  await waitFor(async () => (await win.eval(async () => chrome.tabs.query({}))).some((t) => (t.url || t.pendingUrl || '').startsWith('chrome://settings/syncSetup')), { label: 'postavke otvorene' });
  await page.close();
  await win.reloadExtension();
  await sleep(3000);
  assert.equal((await noteTabs(win)).length, 0, 'uputa se otvorila drugi put');
});

test('H: uz Pauzu se grupe ne spajaju; bez nje spajanje ostavi stanje u povijesti', async () => {
  await present(win, mac);
  await win.eval(async () => {
    const s = (await chrome.storage.local.get('tm.settings'))['tm.settings'];
    await chrome.storage.local.set({ 'tm.settings': { ...s, paused: true } });
  });
  const makeDup = (d, url) => d.eval(async (url) => {
    const t = await chrome.tabs.create({ url, active: false });
    const g = await chrome.tabs.group({ tabIds: [t.id] });
    await chrome.tabGroups.update(g, { title: 'dvojnik' });
    const t2 = await chrome.tabs.create({ url: url + '2', active: false });
    const g2 = await chrome.tabs.group({ tabIds: [t2.id] });
    await chrome.tabGroups.update(g2, { title: 'dvojnik' });
  }, url);
  await makeDup(win, site.url('dup'));
  await sleep(4000);
  assert.equal((await layout(win)).groups.filter((g) => g.title === 'dvojnik').length, 2, 'Pauza mora ostaviti grupe');
  await win.eval(async () => {
    const s = (await chrome.storage.local.get('tm.settings'))['tm.settings'];
    await chrome.storage.local.set({ 'tm.settings': { ...s, paused: false } });
    await chrome.tabs.create({ url: 'about:blank', active: false });
  });
  await waitFor(async () => (await layout(win)).groups.filter((g) => g.title === 'dvojnik').length === 1, { timeout: 45_000, label: 'grupe spojene' });
  const history = await win.eval(async () => (await chrome.storage.local.get('tm.history'))['tm.history'] || []);
  assert.ok(history.some((h) => h.label === 'Prije spajanja grupa istog imena'), 'nema zapisa u povijesti');
  await waitFor(() => has(mac, 'dvojnik'), { timeout: 30_000, label: 'jedna grupa stigla na Mac' });
  assert.equal((await layout(mac)).groups.filter((g) => g.title === 'dvojnik').length, 1);
});

test('I: tab koji je nestao preuzimanjem spremljen je u povijesti i „Vrati“ ga vraća na oba računala', async () => {
  await present(mac, win);
  await waitFor(sameTabs, { timeout: 30_000, label: 'polazno isto' });
  const url = site.url('vazan-tab');
  await addTab(mac, url);
  await waitFor(() => has(win, 'vazan-tab'), { timeout: 30_000, label: 'tab stigao na Windows' });
  await sleep(1500);
  await mac.eval(async (url) => { const [t] = await chrome.tabs.query({ url }); await chrome.tabs.remove(t.id); }, url);
  await waitFor(async () => !(await has(win, 'vazan-tab')), { timeout: 30_000, label: 'tab zatvoren na Windowsu' });
  const history = await win.eval(async () => (await chrome.storage.local.get('tm.history'))['tm.history'] || []);
  const index = history.findIndex((h) => JSON.stringify(h.snapshot).includes('vazan-tab'));
  assert.ok(index >= 0, 'stanje prije preuzimanja nije spremljeno u povijest');
  assert.match(history[index].label, /^Prije preuzimanja/);
  await present(win, mac);
  const res = await win.message('restore', { index });
  assert.ok(res.ok, JSON.stringify(res));
  await waitFor(() => has(win, 'vazan-tab'), { timeout: 30_000, label: 'tab vraćen na Windows' });
  await waitFor(() => has(mac, 'vazan-tab'), { timeout: 30_000, label: 'tab vraćen i na Mac' });
  await waitFor(sameTabs, { timeout: 20_000, label: 'isti tabovi na oba' });
});

