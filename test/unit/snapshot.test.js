import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, isSyncableUrl, isEmptySnapshot, isValidSnapshot, canonicalString, countTabs } from '../../extension/src/snapshot.js';
import { tab, win, group } from './helpers.js';

test('preskače incognito, popup prozore i interne stranice Chromea', () => {
  const s = serialize([
    win([tab('https://a.hr/'), tab('chrome://settings/'), tab('chrome-extension://abc/x.html'), tab('https://b.hr/')]),
    win([tab('https://tajno.hr/')], { incognito: true }),
    win([tab('https://popup.hr/')], { type: 'popup' }),
  ], []);
  assert.equal(s.w.length, 1);
  assert.deepEqual(s.w[0].t.map((t) => t[0]), ['https://a.hr/', 'https://b.hr/']);
});

test('isSyncableUrl: samo http(s); lokalne datoteke se ne prenose (put s Maca ne postoji na Windowsu)', () => {
  assert.ok(isSyncableUrl('https://x.hr/a?b=1'));
  assert.ok(isSyncableUrl('http://x.hr/'));
  for (const u of ['file:///Users/j/doc.pdf', 'ftp://x/', 'chrome://newtab/', 'about:blank', 'devtools://x', 'view-source:https://a', '', null, 'nije url']) {
    assert.equal(isSyncableUrl(u), false, u);
  }
});

test('grupe: naziv, boja, sklopljenost i indeks po prozoru; zakvačeni tab nije u grupi', () => {
  const s = serialize([win([
    tab('https://pin.hr/', { pinned: true }),
    tab('https://a.hr/', { groupId: 7 }), tab('https://b.hr/', { groupId: 7 }),
    tab('https://c.hr/', { groupId: 9, active: true }), tab('https://d.hr/'),
  ])], [group(7, 'Posao', 'red', true), group(9, 'Kupnja', 'green')]);
  const w = s.w[0];
  assert.deepEqual(w.g, [{ n: 'Posao', c: 'red', x: 1 }, { n: 'Kupnja', c: 'green', x: 0 }]);
  assert.deepEqual(w.t.map((t) => [t[1], t[2]]), [[1, -1], [0, 0], [0, 0], [0, 1], [0, -1]]);
  assert.equal(w.a, 3);
});

test('tab koji se još učitava koristi pendingUrl', () => {
  const s = serialize([win([tab('', { pendingUrl: 'https://ucitava.hr/' })])], []);
  assert.equal(s.w[0].t[0][0], 'https://ucitava.hr/');
});

test('zaštita praznog stanja: bez sinkronih tabova = prazno', () => {
  assert.ok(isEmptySnapshot(serialize([], [])));
  assert.ok(isEmptySnapshot(serialize([win([tab('chrome://newtab/')])], [])));
  assert.ok(!isEmptySnapshot(serialize([win([tab('https://a.hr/')])], [])));
  assert.equal(countTabs(null), 0);
});

test('kanonski zapis ne ovisi o redoslijedu prozora', () => {
  const a = { v: 1, w: [{ t: [['https://a.hr/', 0, -1]], g: [], a: 0 }, { t: [['https://b.hr/', 0, -1]], g: [], a: 0 }] };
  const b = { v: 1, w: [a.w[1], a.w[0]] };
  assert.equal(canonicalString(a), canonicalString(b));
  const c = { v: 1, w: [{ ...a.w[0], a: -1 }, a.w[1]] };
  assert.notEqual(canonicalString(a), canonicalString(c));
});

test('isValidSnapshot odbija neispravan podatak iz synca', () => {
  assert.ok(isValidSnapshot({ v: 1, w: [{ t: [['https://a.hr/', 0, 0]], g: [{ n: '', c: 'blue', x: 0 }], a: 0 }] }));
  assert.ok(!isValidSnapshot({ v: 2, w: [] }));
  assert.ok(!isValidSnapshot({ v: 1, w: [{ t: [['javascript:alert(1)', 0, -1]], g: [], a: 0 }] }));
  assert.ok(!isValidSnapshot({ v: 1, w: [{ t: [['https://a.hr/', 0, 3]], g: [], a: 0 }] }));
  assert.ok(!isValidSnapshot(null));
});

test('mergeUrls: unija po broju ponavljanja, bez gubitka redoslijeda', async () => {
  const { mergeUrls } = await import('../../extension/src/snapshot.js');
  assert.deepEqual(mergeUrls(['a', 'b', 'a'], ['a', 'c']), ['a', 'b', 'a', 'c']);
  assert.deepEqual(mergeUrls(['a'], ['a', 'a']), ['a', 'a']);
  assert.deepEqual(mergeUrls(null, ['a']), ['a']);
});

