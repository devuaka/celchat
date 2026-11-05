// Builds the static website into site/:
//   site/index.html   landing page (about, features, FAQ, "Web" and "Windows" buttons)
//   site/app/         the serverless web app (same build as the desktop app uses)
//   site/sw.js        retires the service worker of the days when the app lived at the root
// Env: SITE_REPO=owner/name (for GitHub links, default devuaka/celchat)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.SITE_REPO || process.env.GH_REPO || 'devuaka/celchat';
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-variant.mjs'), 'serverless'], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

const dist = path.join(root, 'dist');
const site = path.join(root, 'site');
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(dist, path.join(site, 'app'), { recursive: true });
cpSync(path.join(dist, 'icon.svg'), path.join(site, 'icon.svg'));
cpSync(path.join(dist, 'icons'), path.join(site, 'icons'), { recursive: true });

// The Windows installer of this version (GitHub turns spaces in asset names into dots).
let winUrl = `https://github.com/${repo}/releases/latest`;
let winSize = 'about 120 MB';
const rel = path.join(root, 'release');
const installer = existsSync(rel) ? readdirSync(rel).find((f) => /^CelChat Setup .*\.exe$/.test(f) && f.includes(version)) : undefined;
if (installer) {
  winUrl = `https://github.com/${repo}/releases/download/v${version}/${installer.replace(/ /g, '.')}`;
  winSize = `${Math.round(statSync(path.join(rel, installer)).size / 1024 / 1024)} MB`;
} else console.warn(`No installer for ${version} in release/: the Windows button points to the latest release page.`);

const html = readFileSync(path.join(root, 'landing', 'index.html'), 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{REPO}}', repo)
  .replaceAll('{{WIN_URL}}', winUrl)
  .replaceAll('{{WIN_SIZE}}', winSize);
writeFileSync(path.join(site, 'index.html'), html);

writeFileSync(
  path.join(site, 'sw.js'),
  `// CelChat used to run at this path and now lives in ./app/. This retires the old service worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll({ type: 'window' })).then((cs) => Promise.all(cs.map((c) => c.navigate(c.url).catch(() => undefined)))),
  );
});
`,
);
writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`site/ ready: landing + app (v${version}), Windows button -> ${winUrl}`);
