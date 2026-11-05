// Runs the hub (auto-restarting) and the Vite dev server together.
//   npm run dev  ->  client on http://localhost:8780, hub on :8781 (proxied at /ws and /api)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (p) => path.join(root, 'node_modules', p);
const procs = [];
const hubPort = process.env.HUB_PORT || '8781';

function run(name, args, color, extraEnv = {}) {
  const env = { ...process.env, FORCE_COLOR: '1', ...extraEnv };
  const p = spawn(process.execPath, args, { cwd: root, env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    process.stdout.write(`${tag}exited with ${code}\n`);
    for (const o of procs) if (o !== p) o.kill();
    process.exit(code ?? 0);
  });
  procs.push(p);
}

run('hub', [bin('tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'hub/src/index.ts'], '35', { HUB_PORT: hubPort });
run('web', [bin('vite/bin/vite.js'), '--config', 'vite.config.ts'], '36', { HUB_DEV_URL: `http://localhost:${hubPort}` });

// `npm run dev -- --keeper` also runs a local archive peer (@archive, accepts join requests from anyone)
if (process.argv.includes('--keeper') || process.env.DEV_KEEPER) {
  setTimeout(
    () =>
      run('keeper', [bin('tsx/dist/cli.mjs'), 'keeper/src/index.ts'], '33', {
        KEEPER_HUB_URL: `ws://localhost:${hubPort}/ws`,
        KEEPER_DATA_DIR: path.join(root, 'data', 'keeper-dev'),
        KEEPER_OPEN: '1',
        KEEPER_STATUS_PORT: '8785',
      }),
    2500,
  );
}

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
