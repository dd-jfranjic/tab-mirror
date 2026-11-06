// Odluke "smijem li objaviti" i "trebam li primijeniti" — čiste funkcije, bez Chrome API-ja (testirane u test/lease.test.js).

export const START_GRACE_MS = 12_000; // nakon pokretanja Chromea Google sync prvo dohvaća tuđe stanje
export const APPLY_SETTLE_MS = 1_500; // događaji tabova odmah nakon primjene su naši, ne korisnikovi
export const MIN_WRITE_GAP_MS = 2_500; // max ~24 zapisa/min (kvota 120/min)
export const HOURLY_WRITE_BUDGET = 1_500; // kvota 1800/h, ostavljamo rezervu
export const REMOTE_WAIT_MS = 60_000; // koliko objava čeka tuđe stanje koje još stiže (dijelovi) prije nego krene svejedno

/** Koliko čekati prije objave, ovisno o vrsti promjene. */
export const DEBOUNCE_MS = {
  structure: 1_500, // novi/zatvoreni/premješteni tab, grupa, pin
  active: 5_000, // samo promjena aktivnog taba — česta, nije hitna
  windowRemoved: 4_000, // gašenje Chromea zatvara prozore jedan po jedan → pričekaj da se vidi je li kraj
};

/**
 * @param {object} c
 * @param {boolean} c.paused
 * @param {boolean} c.initialized uređaj je primijenio zajedničko stanje ili je proglašen izvorom
 * @param {boolean} c.manual korisnik je kliknuo "Preuzmi ovdje" (preskače prisutnost i grace)
 * @param {boolean} c.present korisnik upravo radi na ovom računalu (idle 'active' + Chrome u fokusu)
 * @param {number} c.now
 * @param {number} c.startedAt
 * @param {number} [c.graceMs] zadano START_GRACE_MS
 * @param {number} c.applyingUntil
 * @param {boolean} c.reconciled nakon pokretanja Chromea lokalno je usklađeno sa zajedničkim
 * @param {boolean} c.isEmpty
 * @param {string} c.hash kanonski hash lokalnog stanja
 * @param {string[]} c.sharedHashes hashevi TRENUTNOG zajedničkog stanja (objavljeno ili primijenjeno + postignuto)
 * @param {number} c.lastWriteAt
 * @param {number} c.writesLastHour
 * @returns {{action: 'publish'|'skip'|'defer'|'wait-present', reason: string, delayMs?: number}}
 */
export function decidePublish(c) {
  if (c.paused) return { action: 'skip', reason: 'paused' };
  if (!c.initialized) return { action: 'skip', reason: 'not-initialized' };
  if (c.isEmpty) return { action: 'skip', reason: 'empty' };
  if (!c.manual) {
    const grace = c.graceMs ?? START_GRACE_MS;
    if (c.now < c.startedAt + grace) return { action: 'defer', reason: 'start-grace', delayMs: c.startedAt + grace - c.now };
    if (c.now < c.applyingUntil) return { action: 'defer', reason: 'applying', delayMs: c.applyingUntil - c.now };
    if (!c.reconciled) return { action: 'defer', reason: 'reconciling', delayMs: 2_000 };
    if (c.sharedHashes.includes(c.hash)) return { action: 'skip', reason: 'unchanged' };
    if (!c.present) return { action: 'wait-present', reason: 'not-present' }; // objavi se kad se korisnik vrati
  }
  if (c.writesLastHour >= HOURLY_WRITE_BUDGET) return { action: 'defer', reason: 'hourly-budget', delayMs: 60_000 };
  const sinceLast = c.now - c.lastWriteAt;
  if (sinceLast < MIN_WRITE_GAP_MS) return { action: 'defer', reason: 'rate', delayMs: MIN_WRITE_GAP_MS - sinceLast };
  return { action: 'publish', reason: c.manual ? 'manual' : 'change' };
}

/**
 * @param {object} c
 * @param {string} c.me ID ovog uređaja
 * @param {object|null} c.newest najnovija meta iz synca
 * @param {{rev:number, dev:string}|null} c.lastApplied
 * @param {boolean} c.paused
 * @param {boolean} c.autoApply
 * @param {boolean} c.initialized
 * @param {boolean} c.manual "Preuzmi zadnje" / prvo preuzimanje s klikom
 * @param {boolean} [c.restoreIfEmpty] novi prozor bez ijednog sinkronog taba → vrati zajednički raspored,
 *   i kad je zadnje stanje ovog računala (ništa se ne gubi, lokalno je prazno)
 * @param {boolean} [c.reconcile] Chrome je upravo pokrenut → uvijek se uskladi sa zajedničkim (i s vlastitim), a
 *   tabovi koje drugo računalo nikad nije vidjelo ostaju (vidi planner.localOnlyUrls)
 * @param {boolean} [c.reconciled] false = Chrome se upravo pokreće i još sam vraća svoje tabove; dok se
 *   usklađivanje ne obavi, druga primjena bi otvorila tabove koje Chrome zatim vrati još jednom (dupli tabovi)
 */
export function decideApply(c) {
  if (!c.newest) return { action: 'skip', reason: 'nothing-shared' };
  if (c.manual) {
    if (c.newest.dev === c.me && !c.restoreIfEmpty && !c.reconcile) return { action: 'skip', reason: 'i-am-leader' };
    return { action: 'apply', reason: 'manual' };
  }
  if (c.paused) return { action: 'skip', reason: 'paused' };
  if (!c.initialized) return { action: 'skip', reason: 'needs-first-confirmation' };
  if (!c.autoApply) return { action: 'skip', reason: 'auto-apply-off' };
  if (c.reconcile) return { action: 'apply', reason: 'reconcile' };
  if (c.reconciled === false) return { action: 'wait', reason: 'reconciling' };
  if (c.restoreIfEmpty) return { action: 'apply', reason: 'restore-empty' };
  if (c.newest.dev === c.me) return { action: 'skip', reason: 'i-am-leader' };
  const la = c.lastApplied;
  if (la && la.dev === c.newest.dev && la.rev >= c.newest.rev) return { action: 'skip', reason: 'already-applied' };
  return { action: 'apply', reason: 'newer-remote' };
}

/**
 * Sukob: drugi uređaj je objavio stanje koje nije građeno na mojoj zadnjoj objavi
 * (npr. sjeo si za Windows prije nego je stiglo zadnje s Maca). Moje zadnje stanje tada ide u povijest.
 */
export function isConflict(newest, lastPublished, me) {
  if (!newest || !lastPublished || newest.dev === me) return false;
  // newest je već pobijedio moju objavu (veća revizija, ili ista revizija i kasnije vrijeme)
  return newest.rev >= lastPublished.rev && (newest.base || 0) < lastPublished.rev;
}

/** Revizija nove objave: Lamportov sat — veća od svega viđenog. */
export function nextRevision(maxSeenRev, lastPublishedRev) {
  return Math.max(maxSeenRev || 0, lastPublishedRev || 0) + 1;
}

/** Stiglo je novije stanje s drugog računala koje još nije primijenjeno: objava bi ga pregazila zastarjelim rasporedom. */
export function hasUnappliedRemote(newest, lastApplied, me) {
  if (!newest || newest.dev === me) return false;
  return !(lastApplied && lastApplied.dev === newest.dev && lastApplied.rev >= newest.rev);
}

/** Popis stanja koja znaju oba računala: { rev, urls }. Upis samo kad se adrese promijene (promjena aktivnog taba ga ne troši). */
export function rememberBase(list, rev, urls, max = 10) {
  const last = list.at(-1);
  if (last && last.urls.join('\n') === urls.join('\n')) return list;
  return [...list, { rev, urls }].slice(-max);
}

/** Adrese stanja na kojem je tuđa objava građena: zadnje s revizijom do `rev`, a kad je toliko staro, najstarije zapamćeno. */
export function baseAt(list, rev) {
  const known = list.filter((b) => b.rev <= rev).at(-1) || list[0];
  return known ? known.urls : null;
}
