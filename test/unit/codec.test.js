import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSnapshot, decodeSnapshot, CHUNK_CHARS, MAX_CHUNKS_PER_DEVICE } from '../../extension/src/codec.js';

function bigSnapshot(tabCount) {
  const t = [];
  for (let i = 0; i < tabCount; i++) t.push([`https://www.primjer-${i % 37}.com/clanak/${i}/neki-dugi-naslov-stranice?utm_source=x&id=${i * 7919}`, 0, i % 5 === 0 ? 0 : -1]);
  return { v: 1, w: [{ t, g: [{ n: 'Posao', c: 'blue', x: 0 }], a: 0 }] };
}

test('kodiranje → dekodiranje vraća isti snapshot', async () => {
  const s = bigSnapshot(40);
  const { chunks, h } = await encodeSnapshot(s);
  assert.deepEqual(await decodeSnapshot(chunks, h), s);
});

test('svaki dio stane u kvotu jedne stavke storage.sync (8192 B s ključem)', async () => {
  const { chunks } = await encodeSnapshot(bigSnapshot(3000));
  assert.ok(chunks.length > 1);
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.length <= CHUNK_CHARS);
    assert.ok(JSON.stringify(c).length + `c.abcdefgh.${i}`.length <= 8192);
  }
});

test('500 tabova stane u pretinac jednog uređaja', async () => {
  const { chunks } = await encodeSnapshot(bigSnapshot(500));
  assert.ok(chunks.length <= MAX_CHUNKS_PER_DEVICE, `dijelova: ${chunks.length}`);
});

test('nepotpuni ili tuđi dijelovi → null (čeka se, ništa se ne primjenjuje)', async () => {
  const { chunks, h } = await encodeSnapshot(bigSnapshot(1500));
  assert.ok(chunks.length > 1);
  assert.equal(await decodeSnapshot(chunks.slice(0, -1), h), null);
  assert.equal(await decodeSnapshot([...chunks.slice(0, -1), undefined], h), null);
  const other = await encodeSnapshot({ ...bigSnapshot(1500), w: [{ ...bigSnapshot(1500).w[0], a: 7 }] });
  assert.equal(await decodeSnapshot([other.chunks[0], ...chunks.slice(1)], h), null);
  assert.equal(await decodeSnapshot(chunks, 'krivihash'), null);
});
