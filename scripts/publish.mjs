// Publish CelChat with only the GitHub CLI (no git needed):
//   - source to `main` (no node_modules, builds, local data, identities or test credentials)
//   - the serverless web app to `gh-pages` (GitHub Pages)
//   - the Windows installer from release/ as a GitHub Release asset (if it exists)
//
//   node scripts/publish.mjs              Env: GH_REPO=owner/name (default <you>/celchat), SKIP_SOURCE=1, SKIP_RELEASE=1
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const api = (method, path, body) => {
  const out = gh(['api', '-X', method, path, ...(body ? ['--input', '-'] : [])], body ? JSON.stringify(body) : undefined);
  return out ? JSON.parse(out) : null;
};
/** GitHub's API sometimes drops a request (HTTP/2 REFUSED_STREAM, 502): retry writes a few times. */
const apiRetry = (method, path, body) => {
  for (let i = 0; ; i++) {
    try {
      return api(method, path, body);
    } catch (e) {
      if (i >= 5) throw e;
      // back off harder each time: GitHub's secondary rate limit on writes needs ~a minute to clear
      const secs = [3, 8, 15, 30, 60][i];
      process.stdout.write(`\n  (GitHub refused a request, retrying in ${secs}s: ${String(e.stderr || e.message).split('\n')[0].slice(0, 120)})\n`);
      execSync(process.platform === 'win32' ? `ping -n ${secs + 1} 127.0.0.1 > nul` : `sleep ${secs}`);
    }
  }
};
const tryApi = (...a) => {
  try {
    return api(...a);
  } catch {
    return null;
  }
};

const user = gh(['api', 'user', '--jq', '.login']).trim();
const repo = process.env.GH_REPO || `${user}/celchat`;
const name = repo.split('/')[1];
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`Publishing CelChat ${version} to ${repo}`);

if (!tryApi('GET', `repos/${repo}`)) {
  console.log('Creating public repository...');
  gh(['repo', 'create', repo, '--public', '--add-readme', '--description', 'CelChat: free, peer-to-peer community chat. Voice, video, files, deep customization. No servers required.']);
}

console.log('Building the website (landing page + web app)...');
execSync('node scripts/build-site.mjs', { stdio: 'inherit', env: { ...process.env, SITE_REPO: repo } });

function walk(dir, skip) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skip(entry, full)) continue;
    if (statSync(full).isDirectory()) files.push(...walk(full, skip));
    else files.push(full);
  }
  return files;
}

/** git's blob id for some bytes: unchanged files are already on GitHub and need no upload. */
const gitSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

function pushTree(branch, root, files, extra, message) {
  const tree = [];
  const all = [...files.map((f) => [relative(root, f).split(sep).join('/'), readFileSync(f)]), ...extra];
  const ref = tryApi('GET', `repos/${repo}/git/ref/heads/${branch}`);
  const have = new Set();
  if (ref) {
    const head = tryApi('GET', `repos/${repo}/git/commits/${ref.object.sha}`);
    const old = head && tryApi('GET', `repos/${repo}/git/trees/${head.tree.sha}?recursive=1`);
    for (const e of old?.tree ?? []) if (e.type === 'blob') have.add(e.sha);
  }
  let sent = 0;
  for (const [path, buf] of all) {
    let sha = gitSha(buf);
    if (!have.has(sha)) {
      sha = apiRetry('POST', `repos/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' }).sha;
      sent++;
      process.stdout.write(`\r  ${branch}: uploaded ${sent} changed file${sent === 1 ? '' : 's'}`);
    }
    tree.push({ path, mode: '100644', type: 'blob', sha });
  }
  process.stdout.write(`\r  ${branch}: ${sent} changed of ${all.length} files\n`);
  const t = apiRetry('POST', `repos/${repo}/git/trees`, { tree });
  const parents = ref ? [ref.object.sha] : [];
  const commit = api('POST', `repos/${repo}/git/commits`, { message, tree: t.sha, parents });
  if (ref) api('PATCH', `repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else api('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  console.log(`  ${branch} -> ${commit.sha.slice(0, 7)}`);
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

if (process.env.SKIP_SOURCE !== '1') {
  // .github is skipped: pushing workflow files needs a token with the `workflow` scope.
  const skipNames = new Set(['node_modules', 'dist', 'site', 'release', 'data', '.github', '.claude', '.env', '.env.local', 'test-accounts.json', '.profiles', 'artifacts']);
  const src = walk('.', (n) => skipNames.has(n) || n.endsWith('.log') || n.endsWith('.tsbuildinfo') || n.endsWith('.sqlite') || n === 'identity.json');
  pushTree('main', '.', src, [], `CelChat ${version} source (${stamp})`);
}

pushTree('gh-pages', 'site', walk('site', (n) => n === '.nojekyll'), [['.nojekyll', Buffer.from('')]], `Deploy CelChat ${version} (${stamp})`);

if (!tryApi('GET', `repos/${repo}/pages`)) {
  console.log('Enabling GitHub Pages from gh-pages...');
  // GitHub often enables Pages by itself when a gh-pages branch appears (then this returns 409).
  tryApi('POST', `repos/${repo}/pages`, { source: { branch: 'gh-pages', path: '/' } });
}
const pages = tryApi('GET', `repos/${repo}/pages`);
const site = pages?.html_url || `https://${user}.github.io/${name}/`;

if (process.env.SKIP_RELEASE !== '1' && existsSync('release')) {
  const installer = readdirSync('release').find((f) => /^CelChat Setup .*\.exe$/.test(f) && f.includes(version));
  if (installer) {
    const tag = `v${version}`;
    const file = join('release', installer);
    if (!tryApi('GET', `repos/${repo}/releases/tags/${tag}`)) {
      console.log(`Creating release ${tag} with ${installer}...`);
      gh(['release', 'create', tag, file, '--repo', repo, '--title', `CelChat ${version}`, '--notes', `Windows desktop app. Or use it in the browser: ${site}`]);
    } else {
      console.log(`Updating ${installer} on release ${tag}...`);
      gh(['release', 'upload', tag, file, '--repo', repo, '--clobber']);
    }
  }
}

console.log(`\nDone. Website: ${site} (the first Pages deploy can take a minute or two)`);
console.log(`Releases: https://github.com/${repo}/releases`);
