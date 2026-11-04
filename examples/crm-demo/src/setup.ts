import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'user.name=Acme Vendor', '-c', 'user.email=vendor@acme-crm.test', ...args], cwd);

export type DemoPaths = { root: string; work: string; vendor: string; examples: string; overlay: string; tarball: string };

/** Copy a release of examples/crm into the vendor repo, plus the forkui integration overlay (what `forkui init` adds). */
function applyRelease(p: DemoPaths, version: 'v1' | 'v2', model: { model: string; escalateTo: string | null }) {
  const src = join(p.examples, 'crm', version);
  for (const entry of readdirSync(p.vendor)) {
    if (['.git', 'node_modules', 'package.json', 'package-lock.json', 'dist'].includes(entry)) continue;
    rmSync(join(p.vendor, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(src)) {
    if (['node_modules', 'package-lock.json', 'package.json'].includes(entry)) continue;
    cpSync(join(src, entry), join(p.vendor, entry), { recursive: true });
  }
  cpSync(p.overlay, p.vendor, { recursive: true });
  const config = JSON.parse(readFileSync(join(p.examples, 'crm', 'forkui.config.json'), 'utf8'));
  config.agent = { ...config.agent, ...model };
  config.paths.locked = [...new Set([...config.paths.locked, 'index.html', 'src/main.tsx'])];
  writeFileSync(join(p.vendor, 'forkui.config.json'), JSON.stringify(config, null, 2) + '\n');
}

/** Build the vendor repo from scratch: v1 + forkui integration, installed, committed and built. */
export function setupVendor(p: DemoPaths, model: { model: string; escalateTo: string | null }, log: (s: string) => void) {
  mkdirSync(p.work, { recursive: true });
  log('Packing @forkui/react (what `npm i @forkui/react` would install)…');
  run('npx', ['tsc', '-b', 'packages/react'], p.root);
  for (const f of readdirSync(p.work)) if (f.endsWith('.tgz')) rmSync(join(p.work, f));
  const packed = run('npm', ['pack', '--silent', '--pack-destination', p.work], join(p.root, 'packages', 'react')).trim().split('\n').pop()!;
  cpSync(join(p.work, packed), p.tarball);

  log('Creating the vendor repo (Acme CRM v1, integrated with forkui)…');
  rmSync(p.vendor, { recursive: true, force: true });
  mkdirSync(p.vendor, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(p.examples, 'crm', 'v1', 'package.json'), 'utf8'));
  pkg.dependencies['@forkui/react'] = `file:${p.tarball}`;
  writeFileSync(join(p.vendor, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  applyRelease(p, 'v1', model);
  log('Installing dependencies (one-time)…');
  run('npm', ['install', '--no-audit', '--no-fund'], p.vendor);
  git(p.vendor, 'init', '-q', '-b', 'main');
  git(p.vendor, 'add', '-A');
  git(p.vendor, 'commit', '-q', '-m', 'Acme CRM v1');
  log('Building the vendor app…');
  run('npm', ['run', 'build'], p.vendor);
}

/** What the vendor's CI would do for v2: commit, build, deploy. forkui release happens after this. */
export function shipV2(p: DemoPaths, model: { model: string; escalateTo: string | null }) {
  applyRelease(p, 'v2', model);
  git(p.vendor, 'add', '-A');
  git(p.vendor, 'commit', '-q', '-m', 'Acme CRM v2: DealTable, status field, v2 API, StatCards, search');
  run('npm', ['run', 'build'], p.vendor);
}

export function vendorReady(p: DemoPaths) {
  return existsSync(join(p.vendor, '.git')) && existsSync(join(p.vendor, 'dist', 'index.html'));
}

export function vendorVersion(p: DemoPaths): 'v1' | 'v2' {
  return run('git', ['log', '-1', '--format=%s'], p.vendor).includes('v2') ? 'v2' : 'v1';
}
