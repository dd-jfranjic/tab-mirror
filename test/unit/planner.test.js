import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWindows, assignTabs, mapGroups } from '../../extension/src/planner.js';

const T = (url, g = -1, p = 0) => [url, p, g];
const lw = (id, urls, startId) => ({ id, tabs: urls.map((url, i) => ({ id: startId + i, url, index: i, groupId: -1, pinned: false })) });

test('prozori se sparuju po najvećem broju istih adresa', () => {
  const local = [lw(1, ['https://a/', 'https://b/'], 10), lw(2, ['https://x/', 'https://y/', 'https://z/'], 20)];
  const target = [{ t: [T('https://y/'), T('https://z/')], g: [] }, { t: [T('https://a/')], g: [] }];
  assert.deepEqual(matchWindows(local, target), [2, 1]);
});

test('prazan prozor (samo nova kartica) se koristi umjesto otvaranja novog', () => {
  const local = [lw(1, ['chrome://newtab/'], 10)];
  const target = [{ t: [T('https://a/')], g: [] }];
  assert.deepEqual(matchWindows(local, target), [1]);
});

test('prozor bez zajedničkih adresa i sa svojim sadržajem se ne preuzima', () => {
  const local = [lw(1, ['https://tudje/'], 10)];
  assert.deepEqual(matchWindows(local, [{ t: [T('https://a/')], g: [] }]), [null]);
});

test('postojeći tabovi se ponovno koriste, višak se zatvara, nedostajući se stvaraju', () => {
  const local = [lw(1, ['https://a/', 'https://visak/', 'https://b/'], 10)];
  const target = [{ t: [T('https://b/'), T('https://novi/'), T('https://a/')], g: [] }];
  const { assign, closeTabIds } = assignTabs(local, target, [1]);
  assert.deepEqual(assign, [[12, null, 10]]);
  assert.deepEqual(closeTabIds, [11]);
});

test('duplikati iste adrese: svaki ciljni tab dobiva svoj lokalni tab', () => {
  const local = [lw(1, ['https://a/', 'https://a/'], 10)];
  const { assign, closeTabIds } = assignTabs(local, [{ t: [T('https://a/'), T('https://a/'), T('https://a/')], g: [] }], [1]);
  assert.deepEqual(assign[0].slice(0, 2).sort(), [10, 11]);
  assert.equal(assign[0][2], null);
  assert.deepEqual(closeTabIds, []);
});

test('tab se premješta iz drugog prozora umjesto da se zatvori i otvori iznova', () => {
  const local = [lw(1, ['https://a/'], 10), lw(2, ['https://b/', 'https://c/'], 20)];
  const target = [{ t: [T('https://a/'), T('https://c/')], g: [] }, { t: [T('https://b/')], g: [] }];
  const { assign, closeTabIds } = assignTabs(local, target, matchWindows(local, target));
  assert.deepEqual(assign, [[10, 21], [20]]);
  assert.deepEqual(closeTabIds, []);
});

test('interne stranice (postavke) se ne diraju, prazna nova kartica u punjenom prozoru se zatvara', () => {
  const local = [lw(1, ['chrome://settings/', 'chrome://newtab/', 'https://a/'], 10)];
  const { closeTabIds } = assignTabs(local, [{ t: [T('https://a/')], g: [] }], [1]);
  assert.deepEqual(closeTabIds, [11]);
});

test('grupe: postojeća grupa s najviše istih tabova zadržava svoj ID', () => {
  const current = new Map([[1, 50], [2, 50], [3, 60], [4, -1]]);
  const tw = { t: [T('u1', 0), T('u2', 0), T('u3', 1), T('u4', 1)], g: [{}, {}] };
  assert.deepEqual(mapGroups(current, tw, [1, 2, 3, 4]), [50, 60]);
});

test('grupe: jedna lokalna grupa ne može pokriti dvije ciljne', () => {
  const current = new Map([[1, 50], [2, 50], [3, 50]]);
  const tw = { t: [T('u1', 0), T('u2', 0), T('u3', 1)], g: [{}, {}] };
  assert.deepEqual(mapGroups(current, tw, [1, 2, 3]), [50, null]);
});

test('tab koji drugo računalo nikad nije vidjelo se ne zatvara (npr. Chrome otvoren poveznicom iz maila)', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  const local = [lw(1, ['https://a/', 'https://iz-maila/', 'https://staro/'], 10)];
  const base = ['https://a/', 'https://staro/'];
  const keep = localOnlyUrls(local, base);
  assert.deepEqual([...keep], [['https://iz-maila/', 1]]);
  const { closeTabIds } = assignTabs(local, [{ t: [T('https://a/')], g: [] }], [1], keep);
  assert.deepEqual(closeTabIds, [12]); // "staro" je drugo računalo zatvorilo → zatvara se; "iz-maila" ostaje
});

test('bez baze (prvo preuzimanje) ništa se ne čuva', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  assert.equal(localOnlyUrls([lw(1, ['https://a/'], 10)], null).size, 0);
  const keep = localOnlyUrls([lw(1, ['https://a/', 'https://a/'], 10)], ['https://a/']);
  assert.equal(keep.get('https://a/'), 1);
});

test('preusmjereni tab (otvoren za U, stranica ga poslala na prijavu) se sparuje s U — ne otvara se iznova', () => {
  const local = [{ id: 1, tabs: [{ id: 10, url: 'https://login.hr/?next=u', key: 'https://u.hr/', index: 0 }] }];
  const { assign, closeTabIds } = assignTabs(local, [{ t: [T('https://u.hr/')], g: [] }], [1]);
  assert.deepEqual(assign, [[10]]);
  assert.deepEqual(closeTabIds, []);
});

test('navigacija unutar iste stranice: tab se preusmjeri, ne zatvara i otvara', () => {
  const local = [lw(1, ['https://mail.hr/inbox', 'https://drugo.hr/'], 10)];
  const { assign, navigate, closeTabIds } = assignTabs(local, [{ t: [T('https://mail.hr/poruka/7'), T('https://drugo.hr/')], g: [] }], [1]);
  assert.deepEqual(assign, [[10, 11]]);
  assert.deepEqual(navigate, [{ tabId: 10, url: 'https://mail.hr/poruka/7' }]);
  assert.deepEqual(closeTabIds, []);
});

test('sačuvani lokalni tab se ne preusmjerava ni zatvara', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  const local = [lw(1, ['https://mail.hr/moje'], 10)];
  const keep = localOnlyUrls(local, []);
  const { assign, navigate, closeTabIds } = assignTabs(local, [{ t: [T('https://mail.hr/drugo')], g: [] }], [1], keep);
  assert.deepEqual(assign, [[null]]);
  assert.deepEqual(navigate, []);
  assert.deepEqual(closeTabIds, []);
});

test('tab koji Chrome nije mogao otvoriti se izbaci, grupe i aktivni tab se prilagode', async () => {
  const { withoutTabs } = await import('../../extension/src/planner.js');
  const tw = { t: [T('https://a/', 0), T('https://b/', 1), T('https://c/', 1)], g: [{ n: 'A' }, { n: 'B' }], a: 2 };
  assert.deepEqual(withoutTabs(tw, new Set([0])), { t: [T('https://b/', 0), T('https://c/', 0)], g: [{ n: 'B' }], a: 1 });
  assert.equal(withoutTabs(tw, new Set([2])).a, -1);
  assert.equal(withoutTabs(tw, new Set()), tw);
});

test('raspored sa starije verzije: file:// tab se preskoči, ostatak se primijeni', async () => {
  const { sanitizeSnapshot } = await import('../../extension/src/planner.js');
  const old = { v: 1, w: [
    { t: [['file:///Users/j/a.pdf', 0, 0], ['https://a/', 0, 0], ['https://b/', 0, -1]], g: [{ n: 'G', c: 'red', x: 0 }], a: 2 },
    { t: [['file:///x', 0, -1]], g: [], a: 0 },
  ] };
  assert.deepEqual(sanitizeSnapshot(old), { v: 1, w: [{ t: [['https://a/', 0, 0], ['https://b/', 0, -1]], g: [{ n: 'G', c: 'red', x: 0 }], a: 1 }] });
  assert.equal(sanitizeSnapshot({ v: 1, w: [{ t: 'x', g: [] }] }), null);
  assert.equal(sanitizeSnapshot(null), null);
});

test('neaktivan tab koji je sam promijenio adresu ne duplira se: vraća se na zajedničku adresu', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  const base = ['https://app.hr/', 'https://mail.hr/'];
  const local = [lw(1, ['https://app.hr/login', 'https://mail.hr/'], 10)];
  const target = [{ t: [T('https://app.hr/'), T('https://mail.hr/')], g: [] }];
  const { assign, navigate, keptTabIds } = assignTabs(local, target, [1], localOnlyUrls(local, base), base);
  assert.deepEqual(assign, [[10, 11]]);
  assert.deepEqual(navigate, [{ tabId: 10, url: 'https://app.hr/' }]);
  assert.deepEqual(keptTabIds, []);
});

test('namjerno otvoren tab se ne dira: aktivan, u drugom prozoru, pri pokretanju ili sukobu', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  const base = ['https://docs.hr/a'];
  const target = [{ t: [T('https://docs.hr/a')], g: [] }];
  const active = [{ id: 1, tabs: [{ id: 10, url: 'https://docs.hr/link', active: true, index: 0 }] }];
  assert.deepEqual(assignTabs(active, target, [1], localOnlyUrls(active, base), base).keptTabIds, [10]);
  const other = [lw(1, ['https://x.hr/'], 10), lw(2, ['https://docs.hr/link'], 20)];
  const inOther = assignTabs(other, target, [1], localOnlyUrls(other, base), base);
  assert.ok(inOther.keptTabIds.includes(20));
  assert.ok(!inOther.closeTabIds.includes(20));
  const idle = [lw(1, ['https://docs.hr/link'], 10)];
  assert.deepEqual(assignTabs(idle, target, [1], localOnlyUrls(idle, base), null).keptTabIds, [10]); // pokretanje, sukob
});

test('preusmjerenje na drugu domenu ostaje sačuvano (poznato ograničenje)', async () => {
  const { localOnlyUrls } = await import('../../extension/src/planner.js');
  const base = ['https://app.hr/'];
  const local = [lw(1, ['https://sso.hr/'], 10)];
  const { keptTabIds } = assignTabs(local, [{ t: [T('https://app.hr/')], g: [] }], [1], localOnlyUrls(local, base), base);
  assert.deepEqual(keptTabIds, [10]);
});
