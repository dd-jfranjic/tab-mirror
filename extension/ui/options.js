import { send, ago, counts, el, ROLE_TEXT } from './common.js';

const $ = (id) => document.getElementById(id);
let busy = false;

async function act(type, extra) {
  if (busy) return;
  busy = true;
  try { await send(type, extra); } catch (e) { alert(e.message); }
  busy = false;
  await refresh();
}

function setupSection(st) {
  const other = st.newest && !st.newest.mine ? st.newest : null;
  if (st.role !== 'setup') {
    const who = st.role === 'follower' && st.newest ? ` (glavno: ${st.newest.name})` : '';
    return [el('h2', {}, 'Stanje'), el('p', {}, `${ROLE_TEXT[st.role]}${who}. Zadnja sinkronizacija: ${ago(st.lastSync)}.`)];
  }
  const out = [el('h2', {}, 'Prvo postavljanje')];
  if (other) {
    out.push(
      el('p', {}, `Na računalu „${other.name}“ već postoji raspored: ${counts(other)} (${ago(other.ts)}).`),
      el('p', { class: 'note' }, 'Kad ga preuzmeš, tabovi koji su sada otvoreni ovdje, a nema ih tamo, zatvorit će se. Ostaju spremljeni u povijesti (popup → Povijest → Vrati).'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => act('applyNow') }, `Preuzmi raspored s računala „${other.name}“`),
        el('button', { onclick: () => confirm('Raspored OVOG računala postat će zajednički i prepisati onaj s drugog računala. Nastaviti?') && act('takeControl') }, 'Ne, ovo računalo je izvor')),
    );
  } else {
    out.push(
      el('p', {}, 'Zajedničkog rasporeda još nema. Na računalu na kojem su tabovi već složeni klikni:'),
      el('div', {}, el('button', { class: 'primary', onclick: () => act('takeControl') }, 'Ovo računalo je izvor')),
      el('p', { class: 'small muted' }, 'Na drugom računalu ova stranica će zatim ponuditi „Preuzmi raspored“ (stigne za nekoliko sekundi do minute).'),
    );
  }
  return out;
}

function render(st) {
  $('setup').replaceChildren(...setupSection(st));
  if (document.activeElement !== $('name')) $('name').value = st.settings.deviceName;
  $('auto').checked = st.settings.autoApply;
  $('paused').checked = st.settings.paused;
  $('extId').textContent = st.extensionId;
  $('devices').textContent = st.devices.length
    ? `Računala u sinkronizaciji: ${st.devices.map((d) => `${d.name}${d.mine ? ' (ovo)' : ''} — ${ago(d.ts)}`).join(' · ')}`
    : 'Još nijedno računalo nije objavilo raspored.';
  $('usage').textContent = st.bytesInUse != null ? `Zauzeto u Google sinkronizaciji: ${(st.bytesInUse / 1024).toFixed(1)} od 100 KB.` : '';
}

async function refresh() {
  try { render(await send('status')); } catch (e) { $('setup').textContent = e.message; }
}

$('name').addEventListener('change', async (e) => {
  await send('setName', { value: e.target.value.trim() });
  $('nameSaved').textContent = 'Spremljeno';
  setTimeout(() => { $('nameSaved').textContent = ''; }, 1500);
});
$('auto').addEventListener('change', (e) => act('setAutoApply', { value: e.target.checked }));
$('paused').addEventListener('change', (e) => act('setPaused', { value: e.target.checked }));
$('openSync').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/syncSetup/advanced' }));
$('clear').addEventListener('click', () => {
  if (prompt('Ovo briše zajednički raspored za SVA računala. Upiši OBRIŠI za potvrdu.') === 'OBRIŠI') act('clearShared');
});

refresh();
setInterval(refresh, 3000);
