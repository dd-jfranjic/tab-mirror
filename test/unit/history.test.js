import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushHistory, HISTORY_LIMIT } from '../../extension/src/history.js';

const snap = { v: 1, w: [{ t: [['https://a/', 0, -1]], g: [], a: 0 }] };

test('povijest čuva najviše 20 stanja, najnovije prvo, bez uzastopnih duplikata', () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = pushHistory(list, { snapshot: snap, sh: `h${i}`, label: 'x', at: i });
  assert.equal(list.length, HISTORY_LIMIT);
  assert.equal(list[0].sh, 'h24');
  assert.equal(pushHistory(list, { snapshot: snap, sh: 'h24', label: 'x', at: 99 }), list);
  assert.equal(list[0].tabs, 1);
});
