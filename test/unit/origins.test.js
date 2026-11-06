import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPageNavigation, originKey, withOriginUrls, originEntries, afterNavigation, originPairs, rebuildOrigins, PAGE_SETTLE_MS, LANDING_WAIT_MS } from '../../extension/src/origins.js';
import { serialize } from '../../extension/src/snapshot.js';
import { tab, win } from './helpers.js';

// Tipovi i kvalifikatori izmjereni u Chromiumu (webNavigation.onCommitted / onHistoryStateUpdated).
const landed = { landed: 'https://x.hr/prijava', tabActive: true, sinceCommitMs: 60_000, applying: false };
const commit = (type, q = []) => ({ transitionType: type, transitionQualifiers: q });

test('prvo slijetanje taba koji je Tab Mirror otvorio je stranica, i kad poslužitelj preusmjeri', () => {
  assert.equal(isPageNavigation('commit', commit('link', ['server_redirect']), { ...landed, landed: null, sinceCommitMs: 1_000 }), true);
  assert.equal(isPageNavigation('commit', commit('link'), { ...landed, landed: null, sinceCommitMs: 9_000 }), true); // sporo krenula
});

test('tab koji nikad ne sleti (preuzimanje datoteke) ne čeka vječno: kasniji klik je korisnikov', () => {
  assert.equal(isPageNavigation('commit', commit('link'), { ...landed, landed: null, sinceCommitMs: LANDING_WAIT_MS }), false);
});

test('tab koji korisnik ne gleda ne može kliknuti — njegova navigacija je stranična', () => {
  assert.equal(isPageNavigation('commit', commit('form_submit'), { ...landed, tabActive: false }), true);
});

test('stranica koja odmah nakon učitavanja sama skoči dalje (npr. SAML obrazac) nije korisnik', () => {
  assert.equal(isPageNavigation('commit', commit('form_submit'), { ...landed, sinceCommitMs: PAGE_SETTLE_MS - 1 }), true);
});

test('za vrijeme primjene sve navigacije su Tab Mirrorove', () => {
  assert.equal(isPageNavigation('commit', commit('link'), { ...landed, applying: true }), true);
});

test('buđenje uspavanog taba nije korisnikova navigacija', () => {
  assert.equal(isPageNavigation('commit', commit('reload'), landed), true);
});

test('skripta koja preusmjeri odmah nakon učitavanja je stranica; korisnikov klik na location.replace nije', () => {
  assert.equal(isPageNavigation('commit', commit('link', ['client_redirect']), { ...landed, sinceCommitMs: 300 }), true);
  assert.equal(isPageNavigation('commit', commit('link', ['client_redirect']), landed), false); // izmjereno: klik → client_redirect
});

test('korisnikov klik, upis, obrazac i Natrag su korisnikovi — i kad ih poslužitelj preusmjeri', () => {
  for (const [type, q] of [['link', []], ['link', ['server_redirect']], ['typed', []], ['form_submit', ['server_redirect']], ['typed', ['forward_back']]]) {
    assert.equal(isPageNavigation('commit', commit(type, q), landed), false, `${type} ${q}`);
  }
});

test('promjena adrese unutar aplikacije: korisnikova samo na aktivnom tabu i ne odmah nakon učitavanja', () => {
  assert.equal(isPageNavigation('history', commit('link'), landed), false);
  assert.equal(isPageNavigation('history', commit('link'), { ...landed, tabActive: false }), true);
  assert.equal(isPageNavigation('history', commit('link'), { ...landed, sinceCommitMs: PAGE_SETTLE_MS - 1 }), true);
});

test('izvorna adresa vrijedi samo dok je tab gdje je sletio', () => {
  const e = { k: 'https://x.hr/dash', l: 'https://x.hr/prijava', t: 0 };
  assert.equal(originKey(e, 'https://x.hr/prijava'), 'https://x.hr/dash');
  assert.equal(originKey(e, 'https://x.hr/dash'), 'https://x.hr/dash');
  assert.equal(originKey(e, 'https://x.hr/drugo'), null);
  assert.equal(originKey({ ...e, l: null }, 'https://x.hr/bilo'), 'https://x.hr/dash');
  assert.equal(originKey(undefined, 'https://x.hr/'), null);
});

test('snapshot objavljuje izvornu adresu preusmjerenog taba, ostale tabove ne dira', () => {
  const redirected = tab('https://x.hr/prijava');
  const moved = tab('https://x.hr/korisnik-otisao');
  const other = tab('https://y.hr/');
  const origins = {
    [redirected.id]: { k: 'https://x.hr/dash', l: 'https://x.hr/prijava', t: 0 },
    [moved.id]: { k: 'https://x.hr/a', l: 'https://x.hr/b', t: 0 },
  };
  const snap = serialize(withOriginUrls([win([redirected, moved, other])], origins), []);
  assert.deepEqual(snap.w[0].t.map((t) => t[0]), ['https://x.hr/dash', 'https://x.hr/korisnik-otisao', 'https://y.hr/']);
});

test('zapisi nakon primjene: tab koji se još učitava čeka slijetanje, zatvoreni tab nema zapis', () => {
  const tabs = [{ id: 1, url: 'https://x.hr/prijava' }, { id: 2, url: '', pendingUrl: 'https://y.hr/' }];
  assert.deepEqual(originEntries({ 1: 'https://x.hr/dash', 2: 'https://y.hr/', 3: 'https://z.hr/' }, tabs, 7, new Set([2])), {
    1: { k: 'https://x.hr/dash', l: 'https://x.hr/prijava', t: 0 }, 2: { k: 'https://y.hr/', l: null, t: 7 },
  }); // tab 1 je otprije učitan → rok od 5 s ne vrijedi za njega
});

test('nakon navigacije: stranica pomakne slijetanje, korisnik makne vezu, ostale veze ostaju', () => {
  const o = { 1: { k: 'a', l: 'b', t: 0 }, 2: { k: 'c', l: 'c', t: 0 } };
  assert.deepEqual(afterNavigation(o, 1, 'b2', true, 5), { 1: { k: 'a', l: 'b2', t: 5 }, 2: o[2] });
  assert.deepEqual(afterNavigation(o, 1, 'm', false, 5), { 2: o[2] });
});

test('restart Chromea: preusmjereni tab opet dobije izvornu adresu iz trajno spremljenih parova', () => {
  const o = { 1: { k: 'https://x.hr/dash', l: 'https://x.hr/prijava', t: 0 }, 2: { k: 'https://y.hr/', l: 'https://y.hr/', t: 0 }, 9: { k: 'a', l: 'b', t: 0 } };
  const pairs = originPairs(o, new Set([1, 2]));
  assert.deepEqual(pairs, [['https://x.hr/dash', 'https://x.hr/prijava']]); // bez nepreusmjerenih i zatvorenih
  const tabs = [{ id: 50, url: 'https://y.hr/' }, { id: 51, url: 'https://x.hr/prijava' }, { id: 52, url: 'https://x.hr/prijava' }];
  assert.deepEqual(rebuildOrigins(pairs, tabs, 3), { 51: { k: 'https://x.hr/dash', l: 'https://x.hr/prijava', t: 3 } });
});

test('restart: tab koji se još učitava i prijava s novim jednokratnim kodom također dobiju vezu', () => {
  const pairs = [['https://a.hr/', 'https://a.hr/login'], ['https://b.hr/', 'https://id.b.hr/auth?state=1']];
  const tabs = [{ id: 1, url: '', pendingUrl: 'https://a.hr/login' }, { id: 2, url: 'https://id.b.hr/auth?state=2' }, { id: 3, url: 'https://c.hr/' }];
  assert.deepEqual(Object.keys(rebuildOrigins(pairs, tabs, 0)), ['1', '2']);
});
