// Zajedničko za popup i postavke: poruke service workeru i laičko oblikovanje.

export async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || 'Nema odgovora od proširenja');
  return res.result;
}

export function ago(ts) {
  if (!ts) return 'još nikad';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `prije ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `prije ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `prije ${h} h`;
  return new Date(ts).toLocaleString('hr-HR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 1 tab, 2 taba, 5 tabova — hrvatska množina. */
export function plural(n, one, few, many) {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} ${one}`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function counts(x) {
  if (!x) return '';
  return [
    plural(x.windows || 0, 'prozor', 'prozora', 'prozora'),
    plural(x.tabs || 0, 'tab', 'taba', 'tabova'),
    plural(x.groups || 0, 'grupa', 'grupe', 'grupa'),
  ].join(' · ');
}

export const ROLE_TEXT = {
  leader: 'Glavno računalo',
  follower: 'Prati',
  paused: 'Pauzirano',
  setup: 'Čeka prvo postavljanje',
};

export const ERROR_TEXT = {
  'too-big': 'Raspored je prevelik za Google sinkronizaciju (oko 500+ tabova). Zatvori dio tabova.',
};

export function errorText(code) {
  return ERROR_TEXT[code] || code;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}
