// Snimke za README: dva prava preglednika s proširenjem i izmišljenim stranicama (ništa stvarno).
// Pokretanje: xvfb-run -a -s "-screen 0 1400x1100x24" node tools/readme-shots.mjs docs
// Traži ImageMagick (import, convert).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { launchDevice, createCloud, sleep, waitFor, layout } from '../test/e2e/harness.js';

const out = process.argv[2];
const pages = {
  'mail.example/inbox': 'Inbox', 'calendar.example/week': 'Calendar', 'notes.example/today': 'Notes',
  'news.example/front': 'Morning news', 'recipes.example/soup': 'Tomato soup', 'travel.example/split': 'Weekend in Split',
};
const server = http.createServer((req, res) => {
  const title = pages[`${req.headers.host.split(':')[0]}${req.url}`] || 'Example';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><body style="font:20px system-ui;margin:40px;color:#5d6670">${title}`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const browserArgs = (y) => [`--host-resolver-rules=MAP *.example 127.0.0.1:${port}`, '--test-type', '--no-first-run', '--window-size=1360,300', `--window-position=20,${y}`];
const [mac, win] = await Promise.all([
  launchDevice('mac', { headless: false, args: browserArgs(20) }),
  launchDevice('win', { headless: false, args: browserArgs(365) }),
]);
await mac.setName('Mac');
await win.setName('Windows');
await mac.setDebug({ presence: 'present', graceMs: 0 });
await win.setDebug({ presence: 'absent', graceMs: 0 });
const cloud = createCloud([mac, win]);
cloud.start(300);

await mac.eval(async (u) => {
  const old = await chrome.tabs.query({});
  const open = async (url, active = false) => (await chrome.tabs.create({ url: `http://${url}`, active })).id;
  const work = [await open(u[0], true), await open(u[1]), await open(u[2])];
  await open(u[3]);
  const reading = [await open(u[4]), await open(u[5])];
  await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: work }), { title: 'Work', color: 'green' });
  await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: reading }), { title: 'Reading', color: 'orange' });
  await chrome.tabs.remove(old.map((t) => t.id));
}, Object.keys(pages));
await sleep(1500);
const closeExtensionPages = async (d) => d.eval(async () => {
  const mine = (await chrome.tabs.query({})).filter((t) => (t.url || '').startsWith('chrome-extension://'));
  if (mine.length) await chrome.tabs.remove(mine.map((t) => t.id));
});
await mac.message('takeControl');
await sleep(3500);
await win.message('applyNow');
const same = async () => (await layout(mac)).canon === (await layout(win)).canon;
await closeExtensionPages(win);
await closeExtensionPages(mac);
await waitFor(same, { timeout: 40_000, label: 'isti raspored' });
await win.eval(async () => { for (const t of await chrome.tabs.query({})) await chrome.tabs.reload(t.id); }); // uspavani tabovi nemaju naslov
await sleep(3000);
await waitFor(same, { timeout: 20_000, label: 'isti raspored nakon učitavanja' });
// Samo trake s tabovima; pokazivač miša (sredina ekrana) stoji na stranici donjeg prozora, da nijedan tab nije označen.
execFileSync('import', ['-window', 'root', `${out}/.ekran.png`]);
execFileSync('convert', [`${out}/.ekran.png`,
  '(', '-clone', '0', '-crop', '1360x90+20+20', '+repage', ')',
  '(', '-clone', '0', '-crop', '1360x24+20+20', '+repage', '-fill', 'white', '-colorize', '100', ')',
  '(', '-clone', '0', '-crop', '1360x90+20+365', '+repage', ')',
  '-delete', '0', '-append', '-strip', `${out}/two-computers.png`]);
rmSync(`${out}/.ekran.png`);
console.log('dvije trake snimljene, isti raspored:', await same());

// Izbornik s poviješću: Windows jednom preuzme novu promjenu, pa u povijesti ima zapis.
await mac.eval(async () => { await chrome.tabs.create({ url: 'http://news.example/front', active: false }); });
await waitFor(async () => (await win.eval(async () => (await chrome.storage.local.get('tm.history'))['tm.history'] || [])).length > 0, { timeout: 30_000, label: 'zapis u povijesti' });
await sleep(1500);
const popup = await win.browser.newPage();
await popup.setViewport({ width: 340, height: 560, deviceScaleFactor: 2 });
await popup.goto(`chrome-extension://${win.id}/ui/popup.html`);
await sleep(800);
await popup.evaluate(() => document.getElementById('toggleHistory').click());
await sleep(400);
const h = await popup.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
await popup.screenshot({ path: `${out}/menu.png`, clip: { x: 0, y: 0, width: 340, height: Math.min(h, 560) } });
const settings = await win.browser.newPage();
await settings.setViewport({ width: 760, height: 900, deviceScaleFactor: 1.5 });
await settings.goto(`chrome-extension://${win.id}/ui/options.html`);
await sleep(800);
await settings.screenshot({ path: `${out}/settings.png`, fullPage: true });
cloud.stop();
await Promise.allSettled([mac.close(), win.close()]);
server.close();
console.log('gotovo');
process.exit(0); // preglednik drži vezu otvorenom
