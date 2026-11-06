import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMetas, pickNewest, buildSlotWrite, metaKey, chunkKey, allSlotKeys, STALE_SLOT_MS } from '../../extension/src/slots.js';

const meta = (dev, rev, ts = 1000, n = 1) => ({ dev, rev, ts, n, h: 'h', sh: 's', base: 0, name: dev });

test('readMetas prihvaća samo ispravne mete pod vlastitim ključem', () => {
  const items = { 'm.mac': meta('mac', 3), 'm.win': { ...meta('mac', 9) }, 'm.bad': { dev: 'bad' }, 'c.mac.0': 'x', other: 1 };
  assert.deepEqual(readMetas(items).map((m) => m.dev), ['mac']);
});

test('najnovije: veća revizija, pa kasnije vrijeme, pa ime uređaja', () => {
  assert.equal(pickNewest([meta('mac', 3), meta('win', 4)]).dev, 'win');
  assert.equal(pickNewest([meta('mac', 4, 2000), meta('win', 4, 1000)]).dev, 'mac');
  assert.equal(pickNewest([meta('a', 4, 1000), meta('b', 4, 1000)]).dev, 'b');
  assert.equal(pickNewest([]), null);
});

test('objava piše samo svoj pretinac i briše svoje dijelove viška', () => {
  const items = { 'm.mac': meta('mac', 2, 1000, 3), 'c.mac.0': 'a', 'c.mac.1': 'b', 'c.mac.2': 'c', 'm.win': meta('win', 1), 'c.win.0': 'w' };
  const { set, remove } = buildSlotWrite(items, meta('mac', 5, 2000, 1), ['novo'], 2000);
  assert.deepEqual(Object.keys(set).sort(), ['c.mac.0', 'm.mac']);
  assert.deepEqual(remove.sort(), ['c.mac.1', 'c.mac.2']);
});

test('pretinac uređaja koji se dugo nije javio se čisti', () => {
  const now = STALE_SLOT_MS + 10_000;
  const items = { 'm.old': meta('old', 1, 1), 'c.old.0': 'x', 'm.win': meta('win', 2, now - 1000), 'c.win.0': 'y' };
  const { remove } = buildSlotWrite(items, meta('mac', 3, now), ['z'], now);
  assert.deepEqual(remove.sort(), ['c.old.0', 'm.old']);
});

test('ključevi i brisanje svih pretinaca', () => {
  assert.equal(metaKey('mac'), 'm.mac');
  assert.equal(chunkKey('mac', 2), 'c.mac.2');
  assert.deepEqual(allSlotKeys({ 'm.a': 1, 'c.a.0': 1, 'tm.x': 1 }).sort(), ['c.a.0', 'm.a']);
});

test('kvota: stari pretinac (npr. nakon ponovne instalacije) se briše da nova objava stane, najnoviji tuđi nikad', () => {
  const big = 'x'.repeat(7900);
  const slot = (dev, rev, ts) => {
    const o = { [`m.${dev}`]: meta(dev, rev, ts, 5) };
    for (let i = 0; i < 5; i++) o[`c.${dev}.${i}`] = big;
    return o;
  };
  const items = { ...slot('stari', 3, 1000), ...slot('win', 9, 5000) };
  const chunks = Array(5).fill(big);
  const { remove } = buildSlotWrite(items, meta('mac', 10, 6000, 5), chunks, 6000);
  assert.ok(remove.includes('m.stari') && remove.includes('c.stari.4'));
  assert.ok(!remove.some((k) => k.includes('.win') || k === 'm.win'));
});
