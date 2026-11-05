// Builds the web client for a target.
//   node scripts/build-variant.mjs serverless          -> dist/ that needs no hub (public brokers), relative paths
//   node scripts/build-variant.mjs pages /celchat/     -> same, for GitHub Pages under /celchat/
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [variant = 'serverless', base] = process.argv.slice(2);
const env = { ...process.env, VITE_SERVERLESS: '1' };
if (base) env.VITE_BASE = base;
console.log(`building ${variant} client${base ? ` (base ${base})` : ''}...`);
const r = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.config.ts'], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
