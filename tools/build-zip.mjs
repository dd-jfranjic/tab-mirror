// ZIP ekstenzije za "Load unpacked" (raspakiraj → učitaj mapu). Ključevi i testovi ne ulaze.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(`${root}/extension/manifest.json`, 'utf8'));
const stage = `${root}/dist/tab-mirror`;
const zip = `${root}/dist/tab-mirror-${version}.zip`;
rmSync(`${root}/dist`, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(`${root}/extension`, stage, { recursive: true });
cpSync(`${root}/README.md`, `${stage}/README.md`);
execFileSync('zip', ['-rq', '-X', zip, 'tab-mirror'], { cwd: `${root}/dist` });
console.log(zip);
