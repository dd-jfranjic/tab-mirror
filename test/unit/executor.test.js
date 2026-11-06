// Primjena na lažnom Chromeu: slučajevi koje je teško namjerno izazvati u pravom pregledniku.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshot } from '../../extension/src/executor.js';

function fakeChrome(tabs, groups, { goneGroups = [] } = {}) {
  const win = () => ({ id: 1, type: 'normal', tabs: tabs.map((t, index) => ({ ...t, index })) });
  let nextGroup = 100;
  return {
    windows: { getAll: async () => [win()], get: async () => win() },
    tabGroups: { query: async () => groups, update: async (id, c) => { Object.assign(groups.find((g) => g.id === id), c); } },
    tabs: {
      get: async (id) => tabs.find((t) => t.id === id),
      query: async () => tabs,
      move: async () => {},
      update: async () => {},
      remove: async () => {},
      ungroup: async () => {},
      discard: async () => {},
      group: async ({ groupId, tabIds }) => {
        if (goneGroups.includes(groupId)) throw new Error(`No group with id: ${groupId}.`);
        const id = groupId ?? nextGroup++;
        if (!groups.some((g) => g.id === id)) groups.push({ id, windowId: 1, title: '', color: 'grey', collapsed: false });
        for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = id;
        return id;
      },
    },
  };
}

const target = { v: 1, w: [{ t: [['https://a/', 0, 0], ['https://b/', 0, 0]], g: [{ n: 'Posao', c: 'blue', x: 0 }], a: 0 }] };
const open = () => [
  { id: 1, windowId: 1, url: 'https://a/', pinned: false, active: true, groupId: 7 },
  { id: 2, windowId: 1, url: 'https://b/', pinned: false, active: false, groupId: 7 },
];

test('grupa koju je Chrome u međuvremenu ugasio: primjena ne pada, tabovi dobiju novu grupu', async () => {
  const tabs = open();
  const groups = [{ id: 7, windowId: 1, title: 'Posao', color: 'blue', collapsed: false }];
  const res = await applySnapshot(fakeChrome(tabs, groups, { goneGroups: [7] }), target);
  assert.equal(res.error, undefined);
  assert.deepEqual(tabs.map((t) => t.groupId), [100, 100]);
  assert.equal(groups.find((g) => g.id === 100).title, 'Posao');
});

test('grupa koja postoji se koristi i dalje', async () => {
  const tabs = open();
  const res = await applySnapshot(fakeChrome(tabs, [{ id: 7, windowId: 1, title: 'Posao', color: 'blue', collapsed: false }]), target);
  assert.equal(res.error, undefined);
  assert.deepEqual(tabs.map((t) => t.groupId), [7, 7]);
});
