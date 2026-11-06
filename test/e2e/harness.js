// Dva prava Chromiuma (Puppeteer; Playwright zatvori kontekst kad Chrome uspava tab) s učitanom ekstenzijom = "Mac" i "Windows".
// Google sync glumi most koji kopira ključeve storage.sync između njih (isto što Google radi preko mreže).
import puppeteer from 'puppeteer';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { serialize, canonicalString } from '../../extension/src/snapshot.js';

export const EXT_DIR = resolve(import.meta.dirname, '../../extension');
const isSlotKey = (k) => k.startsWith('m.') || k.startsWith('c.');

export async function startSite() {
  const server = http.createServer((req, res) => {
    // "Windows" nije prijavljen: /privatno ga šalje na prijavu (kao Gmail na računalu bez prijave)
    if (req.url.startsWith('/privatno') && String(req.headers['user-agent']).includes('TabMirrorWin')) {
      res.writeHead(302, { location: '/prijava' });
      return res.end();
    }
    // /kroz/X = poveznica koja preusmjerava (npr. praćenje klikova, prijava → nadzorna ploča)
    if (req.url.startsWith('/kroz/')) {
      res.writeHead(302, { location: req.url.slice('/kroz'.length) });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${req.url}</title><h1>${req.url}</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { url: (p) => `${base}/${p}`, close: () => server.close() };
}

const CHROMIUM = [process.env.TM_CHROMIUM].find((p) => p && existsSync(p)); // inače Puppeteerov Chrome

export async function launchDevice(name, { userAgent, headless = true, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `tm-${name}-`));
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM, headless, pipe: true, userDataDir: dir, defaultViewport: headless ? undefined : null,
    ignoreDefaultArgs: headless ? undefined : ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-sandbox', ...(userAgent ? [`--user-agent=${userAgent}`] : []), ...args],
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const sw = await target.worker();
  const id = new URL(target.url()).host;
  const device = { name, browser, sw, id, dir };
  await waitFor(() => sw.evaluate(() => !!(globalThis.chrome && chrome.windows && chrome.tabs)), { label: 'Chrome API u workeru' });
  return Object.assign(device, deviceApi(device));
}

/** Chrome uspava service worker (MV3); tada se ponovno nađe ili probudi otvaranjem stranice proširenja. */
async function wakeWorker(d) {
  const find = () => d.browser.targets().filter((t) => t.type() === 'service_worker' && t.url().includes(d.id)).at(-1); // najnoviji
  if (!find()) {
    const page = await d.browser.newPage();
    await page.goto(`chrome-extension://${d.id}/ui/popup.html`);
    await waitFor(() => find(), { label: 'budan worker' });
    await page.close();
  }
  return find().worker();
}

function deviceApi(d) {
  return {
    async eval(fn, arg) {
      try {
        // Stari worker nakon ↻ ostaje na popisu i ne odgovara nikad — bez roka bi zapeo i lažni sync.
        return await Promise.race([d.sw.evaluate(fn, arg), sleep(15_000).then(() => { throw new Error('Target ne odgovara'); })]);
      } catch (err) {
        if (!/closed|detached|destroyed|Target/i.test(String(err?.message))) throw err;
        d.sw = await wakeWorker(d);
        return d.sw.evaluate(fn, arg);
      }
    },
    async setDebug(debug) {
      await d.eval((dbg) => chrome.storage.local.set({ 'tm.debug': dbg }), debug);
    },
    async setName(n) {
      await d.eval(async (n) => {
        const s = (await chrome.storage.local.get('tm.settings'))['tm.settings'] || {};
        await chrome.storage.local.set({ 'tm.settings': { ...s, deviceName: n } });
      }, n);
    },
    async options() {
      const page = await d.browser.newPage();
      await page.goto(`chrome-extension://${d.id}/ui/options.html`);
      return page;
    },
    /** Klik na gumb po tekstu (kao korisnik). */
    async clickButton(page, text, timeout = 15_000) {
      await page.waitForFunction((t) => [...document.querySelectorAll('button')].some((b) => b.textContent.includes(t)), { timeout }, text);
      await page.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t)).click(), text);
    },
    async message(type, extra = {}) {
      // Ne browser.pages(): spaja se na sve kartice i zapne na uspavanoj (Network.enable, Chrome 148).
      const target = d.browser.targets().find((t) => t.type() === 'page' && t.url().startsWith(`chrome-extension://${d.id}/`));
      const page = target ? await target.page() : await d.options();
      return page.evaluate((type, extra) => chrome.runtime.sendMessage({ type, ...extra }), type, extra);
    },
    /** Gumb ↻ na chrome://extensions (uz Developer mode, inače Chrome isključi raspakirano proširenje). Briše sesiju kao restart. */
    async reloadExtension() {
      const isOurs = (x) => x.type() === 'service_worker' && x.url().includes(d.id);
      const old = new Set(d.browser.targets().filter(isOurs)); // stari worker ostaje na popisu, ali više ne odgovara
      const mgr = await d.browser.newPage();
      await mgr.goto('chrome://extensions');
      await mgr.evaluate(async (id) => {
        await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
        await chrome.developerPrivate.reload(id, { failQuietly: false });
      }, d.id);
      await mgr.close();
      await sleep(1500);
      await waitFor(async () => {
        const t = d.browser.targets().find((x) => isOurs(x) && !old.has(x));
        if (!t) return false;
        d.sw = await t.worker();
        return d.sw.evaluate(() => !!chrome.tabs).catch(() => false);
      }, { label: 'worker nakon ponovnog učitavanja' });
    },
    async close() {
      await d.browser.close();
      rmSync(d.dir, { recursive: true, force: true });
    },
  };
}

/** Lažni Google sync: zadnji zapis po ključu pobjeđuje, kao u pravom syncu. */
export function createCloud(devices) {
  const cloud = new Map();
  const seen = new Map(devices.map((d) => [d, new Map()]));
  const readSlots = (d) => d.eval(async () => chrome.storage.sync.get(null)).then((all) => new Map(Object.entries(all).filter(([k]) => isSlotKey(k)).map(([k, v]) => [k, JSON.stringify(v)])));
  async function tick() {
    for (const d of devices) {
      const cur = await readSlots(d);
      const prev = seen.get(d);
      for (const [k, v] of cur) if (prev.get(k) !== v) { cloud.set(k, v); prev.set(k, v); }
      for (const k of [...prev.keys()]) if (!cur.has(k)) { cloud.delete(k); prev.delete(k); }
    }
    for (const d of devices) {
      // Ključ koji je uređaj u međuvremenu sam promijenio NE prepisuj (to bi bio lažni gubitak zapisa);
      // pokupit će ga idući krug — isto kao pravi Google sync, koji lokalni zapis ne vraća na staro.
      const cur = await readSlots(d);
      const prev = seen.get(d);
      const localChanged = (k) => cur.get(k) !== prev.get(k);
      const set = {};
      for (const [k, v] of cloud) if (cur.get(k) !== v && !localChanged(k)) set[k] = JSON.parse(v);
      const remove = [...cur.keys()].filter((k) => !cloud.has(k) && !localChanged(k));
      if (Object.keys(set).length) await d.eval((s) => chrome.storage.sync.set(s), set);
      if (remove.length) await d.eval((r) => chrome.storage.sync.remove(r), remove);
      const next = new Map(cloud);
      for (const k of new Set([...cur.keys(), ...prev.keys()])) if (localChanged(k)) prev.has(k) ? next.set(k, prev.get(k)) : next.delete(k);
      seen.set(d, next);
    }
  }
  let timer = null;
  return {
    start(ms = 300) { const loop = async () => { await tick().catch(() => {}); timer = setTimeout(loop, ms); }; loop(); },
    stop() { clearTimeout(timer); },
    tick,
  };
}

/** Kanonski opis lokalnog rasporeda (isti kod kao ekstenzija, izvršen u Nodeu nad podacima iz Chromea). */
export async function layout(d) {
  const { windows, groups } = await d.eval(async () => ({
    windows: await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    groups: await chrome.tabGroups.query({}),
  }));
  const snap = serialize(windows, groups);
  return { canon: canonicalString(snap), snap, windows, groups };
}

export async function waitFor(fn, { timeout = 20_000, interval = 250, label = 'uvjet' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Isteklo čekanje: ${label}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
