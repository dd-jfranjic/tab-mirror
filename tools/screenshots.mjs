// Snimke izbornika i postavki (za README i provjeru izgleda).
import { launchDevice, startSite, sleep } from '../test/e2e/harness.js';
const out = process.argv[2];
const site = await startSite();
const d = await launchDevice('shot');
await d.setName('Mac');
const setup = await d.options();
await setup.setViewport({ width: 900, height: 900 });
await sleep(800);
await setup.screenshot({ path: `${out}/options-setup.png`, fullPage: true });
await d.eval(async (u) => {
  const ids = [];
  for (const p of ['posao/mail', 'posao/crm', 'kupnja/a', 'kupnja/b', 'vijesti']) ids.push((await chrome.tabs.create({ url: u + p, active: false })).id);
  const g = await chrome.tabs.group({ tabIds: ids.slice(0, 2) }); await chrome.tabGroups.update(g, { title: 'Posao', color: 'blue' });
}, site.url(''));
await d.message('takeControl');
const popup = await d.browser.newPage();
await popup.setViewport({ width: 340, height: 420, deviceScaleFactor: 2 });
await popup.goto(`chrome-extension://${d.id}/ui/popup.html`);
await sleep(800);
await popup.evaluate(() => document.getElementById('toggleHistory').click());
await sleep(300);
await popup.screenshot({ path: `${out}/popup.png`, fullPage: true });
await setup.reload(); await sleep(800);
await setup.screenshot({ path: `${out}/options-leader.png`, fullPage: true });
await d.close(); site.close();
console.log('ok');
