import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ForkuiConfig } from '@forkui/core';
import type { Sandbox, SandboxDriver } from './types.ts';

/** Files besides the manifest and lockfile that change what an install produces. */
const INSTALL_CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];

/**
 * Caches installed node_modules keyed by (package.json deps + lockfile) hash, and links them
 * into worktrees. Most tenants share the base's dependencies, so installs are rare.
 */
export class DependencyCache {
  constructor(
    readonly dir: string,
    private readonly driver: SandboxDriver,
  ) {}

  async key(worktreeRoot: string, config: ForkuiConfig): Promise<string> {
    const h = createHash('sha256');
    for (const f of ['package.json', config.install.lockfile, ...INSTALL_CONFIG_FILES]) {
      const p = join(worktreeRoot, f);
      h.update(f + '\0' + (existsSync(p) ? await readFile(p) : '') + '\0');
    }
    h.update(JSON.stringify(config.install.run));
    return h.digest('hex').slice(0, 24);
  }

  /** In-flight installs, so concurrent jobs needing the same dependencies install once. */
  private installing = new Map<string, Promise<boolean>>();

  /** Ensure `<root>/node_modules` points at a cached install for this worktree's manifest. */
  async link(sandbox: Sandbox, config: ForkuiConfig): Promise<{ key: string; installed: boolean }> {
    const key = await this.key(sandbox.root, config);
    const entry = resolve(this.dir, key);
    let installed = false;
    if (!existsSync(join(entry, 'node_modules'))) {
      let pending = this.installing.get(key);
      if (!pending) {
        pending = this.install(sandbox.root, entry, config).finally(() => this.installing.delete(key));
        this.installing.set(key, pending);
        installed = await pending;
      } else await pending;
    }
    const target = join(sandbox.root, 'node_modules');
    const st = await lstat(target).catch(() => null);
    if (st) await rm(target, { recursive: true, force: true });
    await symlink(join(entry, 'node_modules'), target, 'dir');
    return { key, installed };
  }

  /**
   * Install IN the worktree (so relative `file:` deps, .npmrc/.yarnrc, patches/ etc. resolve exactly as in the
   * vendor's repo; lockfiles like yarn v1's encode paths relative to the project), then move node_modules into
   * the cache.
   */
  private async install(root: string, entry: string, config: ForkuiConfig): Promise<boolean> {
    if (existsSync(join(entry, 'node_modules'))) return false;
    const target = join(root, 'node_modules');
    await rm(target, { recursive: true, force: true });
    const box = await this.driver.open(root);
    const r = await box.exec(config.install.run, { timeoutMs: 15 * 60_000 });
    await box.dispose();
    if (r.code !== 0) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`Dependency install failed (${r.code}):\n${(r.stderr || r.stdout).slice(-4000)}`);
    }
    // Unique staging dir (other processes may install the same key concurrently).
    const staging = `${entry}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    await mkdir(staging, { recursive: true });
    await rename(target, join(staging, 'node_modules'));
    try {
      await rename(staging, entry);
      return true;
    } catch (e) {
      // Another process won the race; use theirs.
      await rm(staging, { recursive: true, force: true });
      if (!existsSync(join(entry, 'node_modules'))) throw e;
      return false;
    }
  }

}
