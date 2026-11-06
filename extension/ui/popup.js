import { send, ago, counts, el, ROLE_TEXT, errorText } from './common.js';

const $ = (id) => document.getElementById(id);

function renderRole(st) {
  const pill = $('role');
  pill.className = `pill ${st.role}`;
  const followName = st.role === 'follower' && st.newest ? ` ${st.newest.name}` : '';
  pill.lastElementChild.textContent = ROLE_TEXT[st.role] + followName;
}

function renderNotes(st) {
  const notes = $('notes');
  notes.replaceChildren();
  if (st.role === 'setup') {
    notes.append(el('div', { class: 'note' }, 'Ovo računalo još nije povezano. ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); } }, 'Otvori postavke'), ' i odaberi izvor.'));
  }
  if (st.conflict) {
    notes.append(el('div', { class: 'note bad' }, 'Drugo računalo je objavilo raspored prije nego je stigao tvoj zadnji. Tvoj je spremljen u povijest (vrh popisa). ',
      el('button', { onclick: () => act('dismissConflict') }, 'U redu')));
  }
  if (st.lastError) notes.append(el('div', { class: 'note bad' }, errorText(st.lastError)));
}

function renderHistory(st) {
  const list = $('history');
  list.replaceChildren(...(st.history.length ? st.history.map((h) => el('li', {},
    el('div', {}, el('div', {}, h.label), el('div', { class: 'small muted' }, `${ago(h.at)} · ${counts(h)}`)),
    el('button', { onclick: () => confirm('Vratiti ovaj raspored? Postat će zajednički i za drugo računalo.') && act('restore', { index: h.index }) }, 'Vrati'),
  )) : [el('li', { class: 'muted' }, 'Povijest je prazna.')]));
}

function render(st) {
  $('device').textContent = st.settings.deviceName || 'Tab Mirror';
  renderRole(st);
  const shared = st.newest ? `Zajedničko: ${counts(st.newest)}` : 'Zajedničkog rasporeda još nema.';
  $('summary').textContent = `${shared}. Zadnja sinkronizacija: ${ago(st.lastSync)}.`;
  $('pause').textContent = st.settings.paused ? 'Nastavi' : 'Pauza';
  $('apply').disabled = !st.newest || st.newest.mine;
  renderNotes(st);
  renderHistory(st);
}

async function refresh() {
  try { render(await send('status')); } catch (e) { $('summary').textContent = e.message; }
}

async function act(type, extra) {
  document.body.style.cursor = 'progress';
  try { await send(type, extra); } catch (e) { alert(e.message); }
  document.body.style.cursor = '';
  await refresh();
}

$('take').addEventListener('click', () => act('takeControl'));
$('apply').addEventListener('click', () => act('applyNow'));
$('pause').addEventListener('click', async () => act('setPaused', { value: !(await send('status')).settings.paused }));
$('toggleHistory').addEventListener('click', () => { $('history').hidden = !$('history').hidden; });
$('options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

refresh();
setInterval(refresh, 2000);
