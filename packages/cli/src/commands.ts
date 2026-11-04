import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, parseConfig } from '@forkui/core';
import { LocalDriver, runChecks } from '@forkui/sandbox';
import { startServer } from '@forkui/server';
import { detect } from './detect.ts';
import { MARK } from './init.ts';

type Out = { log: (s: string) => void };
const env = (k: string) => process.env[k];

function client(o: { url?: string; secret?: string }) {
  const url = (o.url ?? env('FORKUI_URL') ?? 'http://127.0.0.1:4400').replace(/\/+$/, '');
  const secret = o.secret ?? env('FORKUI_SECRET');
  if (!secret) throw new Error('Set FORKUI_SECRET (shown by `forkui dev`, or your server deployment).');
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${url}${path}`, { ...init, headers: { 'x-forkui-key': secret, ...(init.headers as object) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return { url, call };
}

/** `forkui dev`: run a local forkui server for this repo, with a persistent secret and data dir. */
export async function dev(root: string, o: { port: number }, out: Out) {
  const dataDir = join(root, '.forkui');
  mkdirSync(dataDir, { recursive: true });
  const secretFile = join(dataDir, 'secret');
  const secret = env('FORKUI_SECRET') ?? (existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : randomBytes(24).toString('hex'));
  if (!existsSync(secretFile)) writeFileSync(secretFile, secret, { mode: 0o600 });
  const s = await startServer({ dataDir, secret, port: o.port });
  if (!(await s.svc.store.latestBase())) {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await s.svc.importBase({ version: `dev-${sha}`, ref: 'HEAD', repoPath: root });
    out.log(`Imported HEAD as base release dev-${sha}`);
  }
  out.log(`forkui dev server: http://127.0.0.1:${o.port}`);
  out.log('Give your app server these env vars:');
  out.log(`  FORKUI_URL=http://127.0.0.1:${o.port}`);
  out.log(`  FORKUI_SECRET=${secret}`);
  out.log('Ship a new base with: forkui release');
  return s;
}

/**
 * `forkui release [version]`: publish HEAD as a base release, then carry every tenant onto it.
 * Safe to re-run: an already-published commit isn't uploaded again and the rollout simply runs again
 * (up-to-date tenants are a no-op; pinned ones are retried). Only commits the server doesn't have are uploaded.
 */
export async function release(root: string, o: { version?: string; url?: string; secret?: string; wait?: boolean }, out: Out) {
  const cfg = join(root, CONFIG_FILE);
  if (!existsSync(cfg)) throw new Error(`No ${CONFIG_FILE}. Run \`npx forkui init\` first.`);
  parseConfig(readFileSync(cfg, 'utf8'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const head = git('rev-parse', 'HEAD');
  if (o.version && /^[0-9a-f]{40}$/.test(o.version) && o.version !== head)
    throw new Error(`Commit ${o.version} is not checked out (HEAD is ${head}). Check it out first.`);
  const version = o.version ? (/^[0-9a-f]{40}$/.test(o.version) ? o.version.slice(0, 12) : o.version) : head.slice(0, 12);
  if (git('status', '--porcelain', '--untracked-files=no')) out.log('! Uncommitted changes are not included; releasing the last commit.');

  const c = client(o);
  const bases = (await c.call('/v1/bases')) as { version: string; sha: string }[];
  const same = bases.find((b) => b.version === version);
  if (same && same.sha !== head) throw new Error(`Version ${version} is already published for a different commit (${same.sha.slice(0, 12)}). Pick a new version name.`);
  const q = `/v1/bases?version=${encodeURIComponent(version)}&ref=HEAD`;
  if (same) out.log(`Base release ${version} is already published; resuming the rollout.`);
  else if (bases.some((b) => b.sha === head)) {
    await c.call(`${q}&sha=${head}`, { method: 'POST' });
    out.log(`Published base release ${version} (commit already on the server, nothing uploaded).`);
  } else {
    // Upload only what the server doesn't have: exclude every base it already has that we can see locally.
    const known = bases.map((b) => b.sha).filter((sha) => {
      try {
        git('merge-base', '--is-ancestor', sha, 'HEAD');
        return true;
      } catch {
        return false;
      }
    });
    const commits = git('rev-list', '--count', 'HEAD', ...known.map((k) => `^${k}`));
    const bundle = execFileSync('git', ['bundle', 'create', '-', 'HEAD', ...known.map((k) => `^${k}`)], {
      cwd: root,
      maxBuffer: 1 << 30,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await c.call(q, { method: 'POST', body: bundle });
    out.log(`Published base release ${version} to ${c.url} (${commits} new commit${commits === '1' ? '' : 's'}, ${Math.ceil(bundle.length / 1024)} KB).`);
  }

  const job = await c.call('/v1/rollouts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }) });
  if (o.wait === false) return { version, jobId: job.id as string };
  let seen = 0;
  for (;;) {
    const j = await c.call(`/v1/jobs/${job.id}`);
    for (const line of (j.log as string[]).slice(seen)) out.log(`  ${line}`);
    seen = j.log.length;
    if (j.status === 'failed') throw new Error(`Rollout failed: ${j.error}`);
    if (j.status === 'done') {
      const rows = j.result as { tenantId: string; outcome: string; reason?: string }[];
      out.log(rows.length ? '\nTenant                 Result' : '\nNo customized tenants yet.');
      for (const r of rows) out.log(`${r.tenantId.padEnd(22)} ${r.outcome}${r.reason ? ` — ${r.reason}` : ''}`);
      const errors = rows.filter((r) => r.outcome === 'error');
      if (errors.length) process.exitCode = 1; // pins are expected outcomes, errors are not
      return { version, jobId: job.id as string, results: rows };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function tenants(o: { url?: string; secret?: string }, out: Out) {
  const rows = (await client(o).call('/v1/tenants')) as { tenantId: string; base: string; current: string | null; pinned: { reason: string } | null }[];
  if (!rows.length) out.log('No tenants yet.');
  for (const r of rows) out.log(`${r.tenantId.padEnd(22)} base ${r.base.padEnd(14)} ${r.pinned ? `PINNED: ${r.pinned.reason}` : r.current ? 'live' : 'no fork'}`);
}

type Finding = { level: 'ok' | 'warn' | 'fail'; message: string };

/** `forkui doctor`: is this repo ready for forkui? */
export async function doctor(root: string, o: { checks: boolean; url?: string }, out: Out): Promise<Finding[]> {
  const f: Finding[] = [];
  const add = (level: Finding['level'], message: string) => f.push({ level, message });
  const cfgPath = join(root, CONFIG_FILE);
  let config: ReturnType<typeof parseConfig> | null = null;
  if (!existsSync(cfgPath)) add('fail', `${CONFIG_FILE} missing (run \`npx forkui init\`)`);
  else {
    try {
      config = parseConfig(readFileSync(cfgPath, 'utf8'));
      add('ok', `${CONFIG_FILE} is valid (model ${config.agent.model})`);
    } catch (e) {
      add('fail', (e as Error).message);
    }
  }
  const d = detect(root);
  if (!d.vite || !d.react) add('warn', 'forkui v0.1 supports Vite + React apps');
  const entryText = d.entry ? readFileSync(join(root, d.entry), 'utf8') : '';
  add(entryText.includes('<Customize') ? 'ok' : 'warn', entryText.includes('<Customize') ? `<Customize /> is rendered (${d.entry})` : '<Customize /> not found in your app root');
  const serverText = d.server ? readFileSync(join(root, d.server.file), 'utf8') : '';
  if (serverText.includes('@forkui/node')) add('ok', `forkui middleware installed (${d.server!.file})`);
  else add('warn', 'forkui middleware not found; customers will always get the base app');
  if (serverText.includes(MARK) && /tenant:\s*\([^)]*\)\s*=>\s*\([^)]*\)\.user\?\.orgId/.test(serverText))
    add('warn', 'tenant() still uses the generated default (req.user?.orgId); make sure your auth sets it');

  const src = join(root, 'src');
  if (existsSync(src)) {
    const grep = (re: RegExp) => {
      try {
        return execFileSync('git', ['grep', '-l', '-E', re.source, '--', 'src'], { cwd: root, encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    };
    const sw = grep(/serviceWorker\.register/);
    if (sw) add('warn', `Service worker found (${sw.split('\n')[0]}): it may cache one tenant's build for another user on the same device`);
  }
  if (config) {
    for (const f2 of ['vite.config.ts', 'vite.config.js', 'vitest.config.ts', 'vitest.config.js']) {
      const p = join(root, f2);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      if (/\binclude\s*:/.test(text) && !text.includes(config.paths.tenantTests))
        add('warn', `${f2} sets test.include without ${config.paths.tenantTests}/; tenant acceptance tests won't run`);
    }
    const kitName = ['testkit.ts', 'testkit.tsx', 'testkit.js', 'testkit.jsx'].find((f) => existsSync(join(root, 'forkui', f)));
    const kit = join(root, 'forkui', kitName ?? 'testkit.ts');
    if (!kitName) add('warn', 'No test kit (forkui/testkit.*): tenant tests will be fragile');
    else if (/const routes[^=]*=\s*\{\s*(\/\/[^\n]*\n\s*)*\};/.test(readFileSync(kit, 'utf8')))
      add('warn', 'forkui/testkit.ts has no routes yet: add the endpoints your screens call to mockApi(), or tenant tests will get 404s');
    else add('ok', 'test kit defines mock routes');
    if (o.checks) {
      out.log('Running your checks…');
      const box = await new LocalDriver({ envAllow: ['PATH', 'HOME', 'TMPDIR', 'LANG'] }).open(root);
      for (const r of await runChecks(box, config.checks))
        add(r.ok ? 'ok' : 'fail', r.ok ? `check "${r.name}" passes (${Math.round(r.durationMs / 100) / 10}s)` : `check "${r.name}" fails:\n${r.output.slice(-1500)}`);
    }
  }
  const url = (o.url ?? env('FORKUI_URL') ?? 'http://127.0.0.1:4400').replace(/\/+$/, '');
  let reachable = false;
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    reachable = r.ok;
    add(r.ok ? 'ok' : 'warn', r.ok ? `forkui server reachable at ${url}` : `forkui server at ${url} returned ${r.status}`);
  } catch {
    add('warn', `forkui server not reachable at ${url} (start one with \`npx forkui dev\`)`);
  }
  if (reachable) {
    const devSecret = join(root, '.forkui', 'secret');
    const secret = env('FORKUI_SECRET') ?? (existsSync(devSecret) ? readFileSync(devSecret, 'utf8').trim() : undefined);
    if (!secret) add('warn', 'Set FORKUI_SECRET to let doctor check for base releases');
    else {
      try {
        const bases = (await client({ url, secret }).call('/v1/bases')) as { version: string }[];
        add(
          bases.length ? 'ok' : 'warn',
          bases.length
            ? `${bases.length} base release${bases.length === 1 ? '' : 's'} published (latest ${bases.at(-1)!.version})`
            : 'No base release yet: customers cannot customize until you run `npx forkui release`',
        );
      } catch (e) {
        add('warn', `Could not list base releases: ${(e as Error).message}`);
      }
    }
  }
  for (const x of f) out.log(`${x.level === 'ok' ? '✓' : x.level === 'warn' ? '!' : '✗'} ${x.message}`);
  if (f.some((x) => x.level === 'fail')) process.exitCode = 1;
  return f;
}
