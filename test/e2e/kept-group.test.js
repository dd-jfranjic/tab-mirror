// Tab koji postoji samo na Windowsu, a stoji u zajedničkoj grupi: nakon promjena s Maca ostaje u toj grupi
// (ne nastaje druga grupa istog imena), i kad Windows postane glavni na Mac stiže jedna grupa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchDevice, createCloud, startSite, layout, waitFor, sleep } from './harness.js';

let mac, win, cloud, site;
const sameLayout = async () => (await layout(mac)).canon === (await layout(win)).canon;
const groupOf = (lay, path) => {
  const tab = lay.windows.flatMap((w) => w.tabs).find((t) => (t.url || t.pendingUrl).endsWith(path));
  return lay.groups.find((g) => g.id === tab?.groupId)?.title ?? null;
};
const titles = (lay) => lay.groups.map((g) => g.title).sort();
const addToGroup = (d, title, url) => d.eval(async ({ title, url }) => {
  const g = (await chrome.tabGroups.query({ title }))[0];
  const t = await chrome.tabs.create({ url, active: false });
  await chrome.tabs.group({ groupId: g.id, tabIds: [t.id] });
}, { title, url });

before(async () => {
  site = await startSite();
  [mac, win] = await Promise.all([launchDevice('mac'), launchDevice('win')]);
  await mac.setName('Mac');
  await win.setName('Windows');
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  cloud = createCloud([mac, win]);
  cloud.start(300);
  await mac.eval(async (u) => {
    const [w] = await chrome.windows.getAll();
    const ids = [];
    for (const x of [u.a, u.b]) ids.push((await chrome.tabs.create({ url: x, windowId: w.id, active: false })).id);
    await chrome.tabs.create({ url: u.c, windowId: w.id, active: false });
    const g = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(g, { title: 'github', color: 'blue' });
  }, { a: site.url('gh-a'), b: site.url('gh-b'), c: site.url('c') });
  await mac.clickButton(await mac.options(), 'Ovo računalo je izvor');
  await sleep(2000);
  await win.clickButton(await win.options(), 'Preuzmi raspored s računala');
  await waitFor(sameLayout, { label: 'Windows = Mac' });
});

after(async () => {
  cloud?.stop();
  await Promise.allSettled([mac?.close(), win?.close()]);
  site?.close();
});

test('Windowsov tab u grupi ostaje u njoj kad Mac doda tab u tu grupu (nema druge grupe istog imena)', async () => {
  await addToGroup(win, 'github', site.url('win-vlastiti'));
  await sleep(2500);
  await addToGroup(mac, 'github', site.url('gh-c'));
  await waitFor(async () => (await layout(win)).canon.includes('gh-c'), { label: 'gh-c stigao na Windows' });
  await sleep(2000);
  const w = await layout(win);
  assert.deepEqual(titles(w), ['github']);
  assert.equal(groupOf(w, '/win-vlastiti'), 'github');
});

test('Mac preimenuje grupu → Windowsov tab je u preimenovanoj grupi', async () => {
  await mac.eval(async () => {
    const g = (await chrome.tabGroups.query({ title: 'github' }))[0];
    await chrome.tabGroups.update(g.id, { title: 'posao', color: 'red' });
  });
  await waitFor(async () => (await layout(win)).canon.includes('posao'), { label: 'posao stigao na Windows' });
  await sleep(2000);
  const w = await layout(win);
  assert.deepEqual(titles(w), ['posao']);
  assert.equal(groupOf(w, '/win-vlastiti'), 'posao');
});

test('Windows postane glavni → na Mac stiže jedna grupa s Windowsovim tabom', async () => {
  await mac.setDebug({ presence: 'absent', graceMs: 0 });
  await win.setDebug({ presence: 'present', graceMs: 0 });
  await win.eval(async () => { const t = (await chrome.tabs.query({}))[0]; await chrome.tabs.update(t.id, { active: true }); });
  await waitFor(async () => (await layout(mac)).canon.includes('win-vlastiti') && sameLayout(), { label: 'Mac prati Windows' });
  const m = await layout(mac);
  assert.deepEqual(titles(m), ['posao']);
  assert.equal(groupOf(m, '/win-vlastiti'), 'posao');
});

test('Mac raspusti grupu → Windowsov tab izlazi iz grupe, ne ostaje sam u staroj', async () => {
  await win.setDebug({ presence: 'absent', graceMs: 0 });
  await mac.setDebug({ presence: 'present', graceMs: 0 });
  await sleep(1500);
  await win.eval(async (url) => { const t = await chrome.tabs.create({ url, active: false });
    const g = (await chrome.tabGroups.query({ title: 'posao' }))[0]; await chrome.tabs.group({ groupId: g.id, tabIds: [t.id] }); }, site.url('win-drugi'));
  await sleep(2500);
  await mac.eval(async () => {
    const g = (await chrome.tabGroups.query({ title: 'posao' }))[0];
    await chrome.tabs.ungroup((await chrome.tabs.query({ groupId: g.id })).map((t) => t.id));
  });
  await waitFor(async () => !(await layout(win)).canon.includes('posao') || titles(await layout(win)).length === 0, { label: 'raspuštanje stiglo' });
  await sleep(2000);
  const w = await layout(win);
  assert.deepEqual(titles(w), []);
  assert.equal(groupOf(w, '/win-drugi'), null);
});
