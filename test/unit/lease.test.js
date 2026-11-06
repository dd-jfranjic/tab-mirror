import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePublish, decideApply, isConflict, nextRevision, START_GRACE_MS, MIN_WRITE_GAP_MS, HOURLY_WRITE_BUDGET } from '../../extension/src/lease.js';

const base = {
  paused: false, initialized: true, manual: false, present: true, now: 100_000, startedAt: 0,
  applyingUntil: 0, reconciled: true, isEmpty: false, hash: 'novo', sharedHashes: ['staro'], lastWriteAt: 0, writesLastHour: 0,
};
const pub = (o) => decidePublish({ ...base, ...o });

test('objavljuje promjenu kad korisnik radi na ovom računalu', () => {
  assert.equal(pub({}).action, 'publish');
});

test('nikad ne objavljuje prazno stanje — ni ručno', () => {
  assert.equal(pub({ isEmpty: true }).reason, 'empty');
  assert.equal(pub({ isEmpty: true, manual: true }).reason, 'empty');
});

test('pratitelj bez korisnika ne preuzima vodstvo (npr. stranica sama promijeni adresu)', () => {
  assert.deepEqual(pub({ present: false }), { action: 'wait-present', reason: 'not-present' }); // ne objavljuje, čeka povratak
  assert.equal(pub({ present: false, hash: 'isti', sharedHashes: ['isti'] }).reason, 'unchanged'); // nema promjene → ništa ne čeka
});

test('zaštita od petlje: stanje koje je već zajedničko se ne objavljuje ponovno', () => {
  assert.equal(pub({ hash: 'staro' }).reason, 'unchanged');
});

test('za vrijeme primjene i kratko nakon nje događaji nisu korisnikovi → odgoda', () => {
  const d = pub({ applyingUntil: base.now + 800 });
  assert.equal(d.action, 'defer');
  assert.equal(d.delayMs, 800);
});

test('nakon pokretanja Chromea čeka se da Google sync dohvati tuđe stanje', () => {
  const d = pub({ startedAt: base.now - 1000 });
  assert.equal(d.reason, 'start-grace');
  assert.equal(d.delayMs, START_GRACE_MS - 1000);
  assert.equal(pub({ startedAt: base.now - 1000, graceMs: 0 }).action, 'publish');
});

test('ograničenje brzine i satni budžet kvote', () => {
  assert.equal(pub({ lastWriteAt: base.now - 500 }).delayMs, MIN_WRITE_GAP_MS - 500);
  assert.equal(pub({ writesLastHour: HOURLY_WRITE_BUDGET }).reason, 'hourly-budget');
});

test('neinicijalizirano računalo ne objavljuje dok korisnik ne potvrdi', () => {
  assert.equal(pub({ initialized: false }).reason, 'not-initialized');
});

test('ručno "Uzmi raspored s ovog računala" preskače prisutnost, grace i isto stanje', () => {
  assert.equal(pub({ manual: true, present: false, startedAt: base.now, hash: 'staro' }).action, 'publish');
  assert.equal(pub({ manual: true, paused: true }).reason, 'paused');
});

const newest = { dev: 'mac', rev: 7, sh: 'S7', name: 'Mac' };
const ap = (o) => decideApply({ me: 'win', newest, lastApplied: null, paused: false, autoApply: true, initialized: true, manual: false, ...o });

test('pratitelj primjenjuje novije stanje drugog računala', () => {
  assert.equal(ap({}).action, 'apply');
});

test('ne primjenjuje vlastito ni već primijenjeno stanje', () => {
  assert.equal(ap({ me: 'mac' }).reason, 'i-am-leader');
  assert.equal(ap({ lastApplied: { dev: 'mac', rev: 7 } }).reason, 'already-applied');
});

test('raniji raspored koji se vratio kao NOVIJA revizija se primjenjuje (vraćanje iz povijesti)', () => {
  assert.equal(ap({ lastApplied: { dev: 'mac', rev: 3 } }).action, 'apply');
});

test('prvo preuzimanje traži klik; pauza i isključena auto-primjena se poštuju', () => {
  assert.equal(ap({ initialized: false }).reason, 'needs-first-confirmation');
  assert.equal(ap({ initialized: false, manual: true }).action, 'apply');
  assert.equal(ap({ paused: true }).reason, 'paused');
  assert.equal(ap({ autoApply: false }).reason, 'auto-apply-off');
});

test('sukob: drugo računalo objavilo stanje koje nije vidjelo moje zadnje', () => {
  assert.ok(isConflict({ dev: 'win', rev: 9, base: 5 }, { rev: 8 }, 'mac'));
  assert.ok(isConflict({ dev: 'win', rev: 8, base: 7 }, { rev: 8 }, 'mac'), 'ista revizija, pobijedio je kasniji');
  assert.ok(!isConflict({ dev: 'win', rev: 9, base: 8 }, { rev: 8 }, 'mac'));
  assert.ok(!isConflict({ dev: 'mac', rev: 9, base: 1 }, { rev: 8 }, 'mac'));
  assert.ok(!isConflict({ dev: 'win', rev: 9, base: 1 }, null, 'mac'));
});

test('revizija je uvijek veća od svega viđenog (monotono)', () => {
  assert.equal(nextRevision(10, 4), 11);
  assert.equal(nextRevision(3, 12), 13);
  assert.equal(nextRevision(0, undefined), 1);
});

test('otvoriš pa zatvoriš tab (A → A+X → A): povratak na A se objavljuje', async () => {
  const { currentShared } = await import('../../extension/src/store.js');
  let shared = currentShared('A');
  assert.equal(pub({ hash: 'A+X', sharedHashes: shared }).action, 'publish');
  shared = currentShared('A+X'); // nakon objave A+X zajedničko je samo A+X
  assert.equal(pub({ hash: 'A', sharedHashes: shared }).action, 'publish');
  assert.equal(pub({ hash: 'A', sharedHashes: currentShared('A') }).reason, 'unchanged');
});

test('prazan Chrome (otvoren bez tabova ili novi prozor) vraća zajednički raspored — i vlastiti', () => {
  assert.equal(ap({ me: 'mac', restoreIfEmpty: true }).reason, 'restore-empty');
  assert.equal(ap({ lastApplied: { dev: 'mac', rev: 7 }, restoreIfEmpty: true }).reason, 'restore-empty');
  assert.equal(ap({ restoreIfEmpty: true, paused: true }).reason, 'paused');
  assert.equal(ap({ restoreIfEmpty: true, autoApply: false }).reason, 'auto-apply-off');
  assert.equal(ap({ restoreIfEmpty: true, initialized: false }).reason, 'needs-first-confirmation');
});

test('nakon pokretanja Chromea ništa se ne objavljuje dok se lokalno ne uskladi sa zajedničkim', () => {
  assert.equal(pub({ reconciled: false }).reason, 'reconciling');
  assert.equal(pub({ reconciled: false, manual: true }).action, 'publish');
});

test('pokretanje: usklađivanje se radi i kad je zadnje stanje vlastito ili već primijenjeno', () => {
  assert.equal(ap({ me: 'mac', reconcile: true }).reason, 'reconcile');
  assert.equal(ap({ lastApplied: { dev: 'mac', rev: 7 }, reconcile: true }).reason, 'reconcile');
  assert.equal(ap({ reconcile: true, initialized: false }).reason, 'needs-first-confirmation');
});

test('dok se Chrome pri pokretanju ne uskladi, druga primjena čeka (inače dupli tabovi)', () => {
  assert.deepEqual(ap({ reconciled: false }), { action: 'wait', reason: 'reconciling' });
  assert.equal(ap({ reconciled: false, restoreIfEmpty: true }).reason, 'reconciling');
  assert.equal(ap({ reconciled: false, reconcile: true }).reason, 'reconcile');
  assert.equal(ap({ reconciled: false, manual: true }).action, 'apply');
  assert.equal(ap({ reconciled: true }).action, 'apply');
});

test('objava čeka novije tuđe stanje koje još nije primijenjeno', async () => {
  const { hasUnappliedRemote } = await import('../../extension/src/lease.js');
  assert.equal(hasUnappliedRemote({ dev: 'w', rev: 7 }, { dev: 'w', rev: 6 }, 'm'), true);
  assert.equal(hasUnappliedRemote({ dev: 'w', rev: 7 }, { dev: 'w', rev: 7 }, 'm'), false);
  assert.equal(hasUnappliedRemote({ dev: 'm', rev: 8 }, { dev: 'w', rev: 7 }, 'm'), false);
  assert.equal(hasUnappliedRemote(null, null, 'm'), false);
});

test('baza pri sukobu = stanje na kojem je drugo računalo gradilo', async () => {
  const { rememberBase, baseAt } = await import('../../extension/src/lease.js');
  let b = rememberBase([], 5, ['a']);
  b = rememberBase(b, 6, ['a']); // iste adrese (promjena aktivnog taba) ne troše popis
  b = rememberBase(b, 8, ['a', 'b']);
  assert.deepEqual(b.map((x) => x.rev), [5, 8]);
  assert.deepEqual(baseAt(b, 7), ['a']);
  assert.deepEqual(baseAt(b, 8), ['a', 'b']);
  assert.deepEqual(baseAt(b, 1), ['a']); // starije od popisa → najstarije zapamćeno
  assert.equal(baseAt([], 3), null);
});
