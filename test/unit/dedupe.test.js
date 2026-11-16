import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTabIds } from '../../extension/src/dedupe.js';
import { withOriginUrls } from '../../extension/src/origins.js';
import { tab, win } from './helpers.js';

test('Chrome vratio svaki tab dvaput → po adresi ostaje jedna kopija u prozoru', () => {
  const a1 = tab('https://a/', { pinned: true });
  const a2 = tab('https://a/', { pinned: true });
  const b1 = tab('https://b/', { groupId: 5 });
  const b2 = tab('https://b/', { groupId: 5 });
  const c = tab('https://c/');
  assert.deepEqual(duplicateTabIds([win([a1, a2, b1, b2, c])]).sort(), [a2.id, b2.id].sort());
});

test('ostaje aktivna kopija, pa prikvačena, pa ona u grupi', () => {
  const plain = tab('https://a/');
  const active = tab('https://a/', { active: true });
  assert.deepEqual(duplicateTabIds([win([plain, active])]), [plain.id]);
  const loose = tab('https://b/');
  const pinned = tab('https://b/', { pinned: true });
  assert.deepEqual(duplicateTabIds([win([loose, pinned])]), [loose.id]);
  const out = tab('https://c/');
  const grouped = tab('https://c/', { groupId: 3 });
  assert.deepEqual(duplicateTabIds([win([out, grouped])]), [out.id]);
});

test('ista adresa u dva prozora nije duplikat; interne stranice i incognito se ne diraju', () => {
  assert.deepEqual(duplicateTabIds([win([tab('https://a/')]), win([tab('https://a/')])]), []);
  assert.deepEqual(duplicateTabIds([win([tab('chrome://settings/'), tab('chrome://settings/')])]), []);
  assert.deepEqual(duplicateTabIds([win([tab('https://a/'), tab('https://a/')], { incognito: true })]), []);
});

test('tab koji se još učitava broji se po pendingUrl', () => {
  const loaded = tab('https://a/');
  const loading = tab('', { pendingUrl: 'https://a/' });
  assert.deepEqual(duplicateTabIds([win([loaded, loading])]), [loading.id]);
});

test('preusmjereni tab broji se pod adresom pod kojom se objavljuje (izvornom)', () => {
  const real = tab('https://app.hr/');
  const login = tab('https://login.hr/?next=app');
  const windows = withOriginUrls([win([real, login])], { [login.id]: { k: 'https://app.hr/', l: 'https://login.hr/?next=app', t: 0 } });
  assert.deepEqual(duplicateTabIds(windows), [login.id]);
});

test('prava stranica ostaje, a prijava upisana pod istu adresu se zatvara — i kad je prijava lijevo ili u grupi', async () => {
  const { closeDuplicateTabs } = await import('../../extension/src/dedupe.js');
  const login = tab('https://login.hr/?next=app', { groupId: 4 });
  const real = tab('https://app.hr/');
  const removed = [];
  const api = { windows: { getAll: async () => [win([login, real])] }, tabs: { remove: async (id) => { removed.push(id); } } };
  const found = await closeDuplicateTabs(api, { [login.id]: { k: 'https://app.hr/', l: 'https://login.hr/?next=app', t: 0 } });
  assert.equal(found, 1);
  assert.deepEqual(removed, [login.id]);
});

test('Chrome odbije zatvaranje → vraća broj nađenih, da objava pričeka (ne ode s duplikatom)', async () => {
  const { closeDuplicateTabs } = await import('../../extension/src/dedupe.js');
  const api = { windows: { getAll: async () => [win([tab('https://a/'), tab('https://a/')])] }, tabs: { remove: async () => { throw new Error('Tabs cannot be edited right now'); } } };
  assert.equal(await closeDuplicateTabs(api, {}), 1);
});
