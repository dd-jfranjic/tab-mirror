// Graditelji lažnih Chrome objekata za testove.
let nextId = 1;
export function tab(url, extra = {}) {
  return { id: nextId++, url, pinned: false, groupId: -1, active: false, index: 0, ...extra };
}
export function win(tabs, extra = {}) {
  tabs.forEach((t, i) => { t.index = i; });
  return { id: nextId++, type: 'normal', incognito: false, tabs, ...extra };
}
export function group(id, title, color = 'blue', collapsed = false) {
  return { id, title, color, collapsed };
}
