import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planKeptGroups, duplicateGroups } from '../../extension/src/kept.js';

const T = (url, g = -1) => [url, 0, g];
const local = (tabs) => [{ id: 1, tabs: tabs.map(([id, groupId]) => ({ id, groupId })) }];

test('sačuvani tab iz grupe ide uz zajedničke tabove te grupe', () => {
  const plan = planKeptGroups(local([[10, 7], [11, 7], [12, 7]]), [12], [{ t: [T('https://a/', 0), T('https://b/', 0)], g: [{}] }], [[10, 11]]);
  assert.deepEqual(plan, [{ tabId: 12, i: 0, gi: 0 }]);
});

test('drugo računalo raspustilo grupu → sačuvani tab izlazi iz nje', () => {
  const plan = planKeptGroups(local([[10, 7], [11, 7]]), [11], [{ t: [T('https://a/')], g: [] }], [[10]]);
  assert.deepEqual(plan, [{ tabId: 11, ungroup: true }]);
});

test('grupa samo s lokalnim tabovima i tab bez grupe ostaju kakvi jesu', () => {
  const plan = planKeptGroups(local([[10, -1], [11, 8], [12, -1]]), [11, 12], [{ t: [T('https://a/')], g: [] }], [[10]]);
  assert.deepEqual(plan, []);
});

test('zajednički tabovi grupe razdvojeni u dvije ciljne grupe → sačuvani ide uz većinu', () => {
  const target = [{ t: [T('https://a/', 0), T('https://b/', 1), T('https://c/', 1), T('https://novi/', 0)], g: [{}, {}] }];
  const plan = planKeptGroups(local([[10, 7], [11, 7], [12, 7], [13, 7]]), [13], target, [[10, 11, 12, null]]);
  assert.deepEqual(plan, [{ tabId: 13, i: 0, gi: 1 }]);
});

test('zajednički tabovi stare grupe zamijenjeni novima → sačuvani ide u ciljnu grupu istog imena', () => {
  const target = [{ t: [T('https://x/'), T('https://novi/', 0)], g: [{ n: 'github' }] }];
  const plan = planKeptGroups(local([[10, -1], [11, 7], [12, 7]]), [12], target, [[10, null]], new Map([[7, 'github']]), [11]);
  assert.deepEqual(plan, [{ tabId: 12, i: 0, gi: 0 }]);
});

test('lokalna grupa drugog imena bez zajedničkih tabova ostaje lokalna', () => {
  const target = [{ t: [T('https://novi/', 0)], g: [{ n: 'github' }] }];
  const plan = planKeptGroups(local([[11, 7]]), [11], target, [[null]], new Map([[7, 'moje']]));
  assert.deepEqual(plan, []);
});

test('lokalna grupa istog imena kao zajednička spaja se s njom (nikad dvije grupe istog imena)', () => {
  const target = [{ t: [T('https://a/', 0)], g: [{ n: 'github' }] }];
  const plan = planKeptGroups(local([[10, 5], [11, 7]]), [11], target, [[10]], new Map([[5, 'github'], [7, 'github']]), []);
  assert.deepEqual(plan, [{ tabId: 11, i: 0, gi: 0 }]);
});

test('sačuvani tab: zajednička grupa je nestala s drugog računala → izlazi iz grupe, ne ostaje stara grupa', () => {
  const local = [{ id: 1, tabs: [{ id: 5, groupId: 9 }, { id: 6, groupId: 9 }] }];
  const target = [{ t: [['https://x/', 0, -1]], g: [] }];
  assert.deepEqual(planKeptGroups(local, [6], target, [[null]], new Map([[9, 'github']]), [5]), [{ tabId: 6, ungroup: true }]);
});

test('dvije grupe istog imena u istom prozoru se spajaju; drugi prozor i grupe bez imena ostaju', () => {
  const groups = [
    { id: 1, windowId: 1, title: 'github' }, { id: 2, windowId: 1, title: 'github' },
    { id: 3, windowId: 2, title: 'github' }, { id: 4, windowId: 1, title: '' }, { id: 5, windowId: 1, title: '' },
  ];
  assert.deepEqual(duplicateGroups(groups), [{ from: 2, into: 1 }]);
});

test('lokalna grupa u drugom prozoru ne seli se u grupu istog imena', () => {
  const wins = [{ id: 1, tabs: [{ id: 10, groupId: -1 }] }, { id: 2, tabs: [{ id: 20, groupId: 8 }] }];
  const target = [{ t: [T('https://a/', 0)], g: [{ n: 'Posao' }] }];
  assert.deepEqual(planKeptGroups(wins, [20], target, [[10]], new Map([[8, 'Posao']]), [], [1]), []);
});

