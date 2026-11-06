// Snapshot = kompaktan, uređajno neovisan opis rasporeda: prozori → tabovi (redom) → grupe.
// Ne sadrži ID-jeve tabova ni grupa (oni su različiti na svakom računalu), samo adrese, redoslijed i svojstva.
//
// Oblik (v1):
//   { v: 1, w: [ { t: [[url, pinned(0|1), groupIndex(-1 = bez grupe)], …],
//                  g: [ { n: naslov, c: boja, x: sklopljena(0|1) }, … ],
//                  a: indeks aktivnog taba (-1 = nijedan sinkroni) } ] }

export const SNAPSHOT_VERSION = 1;

// Samo web adrese: file:///Users/… s Maca ne postoji na Windowsu (i obrnuto), a Chrome ekstenziji bez posebne
// dozvole ne da otvoriti lokalnu datoteku.
const SYNCABLE_SCHEMES = ['http:', 'https:'];

/** Smije li se adresa prenositi na drugo računalo (incognito i interne stranice Chromea se preskaču). */
export function isSyncableUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return SYNCABLE_SCHEMES.includes(parsed.protocol);
}

/** Adresa taba: tab koji se još učitava ima pravu adresu u pendingUrl. */
export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

/** Prazna nova kartica koju Chrome sam otvori (na startu, u novom prozoru) — smije se zatvoriti pri primjeni. */
export function isBlankNewTab(tab) {
  const url = tabUrl(tab);
  return url === 'chrome://newtab/' || url === 'chrome://new-tab-page/' || url === 'about:blank';
}

/** Prozori koje zrcalimo: obični, ne incognito. */
export function isMirroredWindow(win) {
  return win && !win.incognito && (win.type === undefined || win.type === 'normal');
}

/**
 * Iz chrome.windows.getAll({populate: true}) i chrome.tabGroups.query({}) složi snapshot.
 * @param {chrome.windows.Window[]} windows
 * @param {chrome.tabGroups.TabGroup[]} groups
 */
export function serialize(windows, groups) {
  const groupById = new Map((groups || []).map((g) => [g.id, g]));
  const out = { v: SNAPSHOT_VERSION, w: [] };
  const sortedWindows = [...(windows || [])].filter(isMirroredWindow).sort((a, b) => a.id - b.id);

  for (const win of sortedWindows) {
    const tabs = [...(win.tabs || [])].sort((a, b) => a.index - b.index);
    const groupIndex = new Map(); // chrome groupId → indeks u ovom prozoru
    const w = { t: [], g: [], a: -1 };
    for (const tab of tabs) {
      const url = tabUrl(tab);
      if (!isSyncableUrl(url)) continue;
      let gi = -1;
      const gid = tab.groupId;
      if (typeof gid === 'number' && gid >= 0 && !tab.pinned) {
        if (!groupIndex.has(gid)) {
          const g = groupById.get(gid) || {};
          groupIndex.set(gid, w.g.length);
          w.g.push({ n: g.title || '', c: g.color || 'grey', x: g.collapsed ? 1 : 0 });
        }
        gi = groupIndex.get(gid);
      }
      if (tab.active) w.a = w.t.length;
      w.t.push([url, tab.pinned ? 1 : 0, gi]);
    }
    if (w.t.length > 0) out.w.push(w);
  }
  return out;
}

export function countTabs(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.w)) return 0;
  return snapshot.w.reduce((n, w) => n + (Array.isArray(w.t) ? w.t.length : 0), 0);
}

/** Zaštita: prazno stanje se NIKAD ne objavljuje (gašenje zadnjeg prozora, Chrome bez prozora na Macu). */
export function isEmptySnapshot(snapshot) {
  return countTabs(snapshot) === 0;
}

/** Je li snapshot ispravnog oblika (podatak iz synca dolazi izvana — provjeri prije primjene). */
export function isValidSnapshot(s) {
  if (!s || s.v !== SNAPSHOT_VERSION || !Array.isArray(s.w)) return false;
  for (const w of s.w) {
    if (!w || !Array.isArray(w.t) || !Array.isArray(w.g)) return false;
    for (const t of w.t) {
      if (!Array.isArray(t) || typeof t[0] !== 'string' || !isSyncableUrl(t[0])) return false;
      if (typeof t[2] !== 'number' || t[2] < -1 || t[2] >= w.g.length) return false;
    }
  }
  return true;
}

/**
 * Kanonski zapis za usporedbu: redoslijed prozora nije bitan (ID-jevi prozora su na svakom računalu drugačiji),
 * pa se prozori sortiraju po sadržaju.
 */
export function canonicalString(snapshot) {
  const wins = (snapshot?.w || []).map((w) => JSON.stringify([w.t, w.g, w.a]));
  wins.sort();
  return `${snapshot?.v ?? 0}|${wins.join('\n')}`;
}

/** Sve adrese snapshota (s ponavljanjem) — "baza" za odluku koje lokalne tabove drugo računalo nikad nije vidjelo. */
export function snapshotUrls(snapshot) {
  return (snapshot?.w || []).flatMap((w) => w.t.map((t) => t[0]));
}

/** Spoj dvaju popisa adresa: svaka adresa onoliko puta koliko je ima na duljem popisu. */
export function mergeUrls(a, b) {
  const out = [...(a || [])];
  const left = new Map();
  for (const u of out) left.set(u, (left.get(u) || 0) + 1);
  for (const u of b || []) {
    if (left.get(u) > 0) left.set(u, left.get(u) - 1);
    else out.push(u);
  }
  return out;
}

export function summarize(snapshot) {
  const windows = snapshot?.w?.length || 0;
  const tabs = countTabs(snapshot);
  const groups = (snapshot?.w || []).reduce((n, w) => n + w.g.length, 0);
  return { windows, tabs, groups };
}
