import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  assertTenantId,
  assertVersion,
  parseConfig,
  parseIntentTrailers,
  refs,
  type ForkuiConfig,
  type IntentTrailers,
} from '@forkui/core';
import { git, identityArgs } from './exec.ts';
import { Worktree } from './worktree.ts';

export type BaseRelease = { version: string; sha: string; createdAt: Date };
export type TenantInfo = { tenantId: string; sha: string };
export type IntentCommit = { sha: string; subject: string; author: string; trailers: IntentTrailers | null };

const ZERO = '0000000000000000000000000000000000000000';

/**
 * A forkui store: one bare repository holding the vendor's base releases (tags `base/<v>`)
 * and every tenant branch (`tenants/<id>`), plus temporary worktrees for agents and checks.
 */
export class GitStore {
  readonly gitDir: string;
  readonly worktreesDir: string;

  private constructor(readonly dir: string) {
    this.gitDir = join(dir, 'repo.git');
    this.worktreesDir = join(dir, 'worktrees');
  }

  static async init(dir: string): Promise<GitStore> {
    const store = new GitStore(resolve(dir));
    if (!existsSync(store.gitDir)) {
      await mkdir(store.dir, { recursive: true });
      await git(store.dir, ['init', '-q', '--bare', '-b', 'main', store.gitDir]);
      // Tags are immutable releases; never let gc drop tenant history.
      await git(store.gitDir, ['config', 'gc.auto', '0']);
    }
    // forkui links cached dependencies into worktrees; never let them be committed,
    // even if the vendor repo has no .gitignore entry.
    await mkdir(join(store.gitDir, 'info'), { recursive: true });
    await writeFile(join(store.gitDir, 'info', 'exclude'), 'node_modules\n');
    await mkdir(store.worktreesDir, { recursive: true });
    return store;
  }

  private g(args: string[], opts?: { allowFail?: boolean }) {
    return git(this.gitDir, args, opts);
  }

  async resolve(ref: string): Promise<string | null> {
    const r = await this.g(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * Publish a base release by fetching `sourceRef` from the vendor's repository (a path or a git bundle).
   * Idempotent: re-publishing the same commit under the same version returns the existing release.
   * A version name is never reused for a different commit.
   */
  async importBase(sourceRepo: string, sourceRef: string, version: string): Promise<BaseRelease & { existing: boolean }> {
    assertVersion(version);
    const incoming = `refs/forkui/incoming-${randomBytes(4).toString('hex')}`;
    await this.g(['fetch', '-q', '--no-tags', resolve(sourceRepo), `+${sourceRef}:${incoming}`]);
    const sha = (await this.resolve(incoming))!;
    try {
      return await this.tagBase(sha, version);
    } finally {
      await this.g(['update-ref', '-d', incoming], { allowFail: true });
    }
  }

  /** Publish a commit the store already has (e.g. a re-release) as a base release. */
  async tagBase(sha: string, version: string): Promise<BaseRelease & { existing: boolean }> {
    assertVersion(version);
    const commit = await this.resolve(sha);
    if (!commit) throw new Error(`Unknown commit ${sha}`);
    const existing = await this.resolve(refs.base(version));
    if (existing) {
      if (existing !== commit) throw new Error(`Base release ${version} already exists for a different commit (${existing.slice(0, 12)})`);
      return { ...(await this.listBases()).find((b) => b.version === version)!, existing: true };
    }
    // Validate config before accepting the release.
    const config = await this.readFile(commit, CONFIG_FILE);
    if (config === null) throw new Error(`Base release ${version} has no ${CONFIG_FILE}`);
    parseConfig(config);
    await this.g([...identityArgs(), 'tag', '-a', '-m', `forkui base release ${version}`, `base/${version}`, commit]);
    await this.g(['update-ref', refs.main, commit]);
    return { ...(await this.listBases()).find((b) => b.version === version)!, existing: false };
  }

  /** Does the store have this commit? (Used to upload only what's new.) */
  async hasCommit(sha: string): Promise<boolean> {
    return (await this.g(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
  }

  /** Base releases, oldest first. */
  async listBases(): Promise<BaseRelease[]> {
    const out = (
      await this.g(['for-each-ref', '--sort=creatordate', '--format=%(refname:strip=3)\t%(*objectname)\t%(creatordate:iso-strict)', 'refs/tags/base/'])
    ).stdout;
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [version, sha, date] = line.split('\t') as [string, string, string];
        return { version, sha, createdAt: new Date(date) };
      });
  }

  async latestBase(): Promise<BaseRelease | null> {
    return (await this.listBases()).at(-1) ?? null;
  }

  /** Config is always read from a base release, never from a tenant branch. */
  async readConfig(version: string): Promise<ForkuiConfig> {
    const text = await this.readFile(refs.base(version), CONFIG_FILE);
    if (text === null) throw new Error(`Base release ${version} has no ${CONFIG_FILE}`);
    return parseConfig(text);
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    const r = await this.g(['show', `${ref}:${path}`], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  }

  async createTenant(tenantId: string, version: string): Promise<TenantInfo> {
    assertTenantId(tenantId);
    const sha = await this.resolve(refs.base(version));
    if (!sha) throw new Error(`Unknown base release ${version}`);
    // Empty old value = must not exist yet.
    await this.g(['update-ref', refs.tenant(tenantId), sha, ZERO]).catch(() => {
      throw new Error(`Tenant ${tenantId} already exists`);
    });
    return { tenantId, sha };
  }

  async listTenants(): Promise<TenantInfo[]> {
    const out = (await this.g(['for-each-ref', '--format=%(refname:strip=3)\t%(objectname)', 'refs/heads/tenants/'])).stdout;
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [tenantId, sha] = l.split('\t') as [string, string];
        return { tenantId, sha };
      });
  }

  async tenantHead(tenantId: string): Promise<string> {
    const sha = await this.resolve(refs.tenant(tenantId));
    if (!sha) throw new Error(`Unknown tenant ${tenantId}`);
    return sha;
  }

  async isAncestor(ancestor: string, of: string): Promise<boolean> {
    return (await this.g(['merge-base', '--is-ancestor', ancestor, of], { allowFail: true })).code === 0;
  }

  /** The newest base release the tenant branch contains. */
  async tenantBase(tenantId: string, at?: string): Promise<BaseRelease> {
    const head = at ?? (await this.tenantHead(tenantId));
    const bases = (await this.listBases()).reverse();
    for (const b of bases) {
      const r = await this.g(['merge-base', '--is-ancestor', b.sha, head], { allowFail: true });
      if (r.code === 0) return b;
    }
    throw new Error(`Tenant ${tenantId} is not based on any base release`);
  }

  /** Tenant commits on top of its base, oldest first. */
  async listIntents(tenantId: string, at?: string): Promise<IntentCommit[]> {
    const head = at ?? (await this.tenantHead(tenantId));
    const base = await this.tenantBase(tenantId, head);
    const SEP = '\x1e';
    const out = (
      await this.g(['log', '--reverse', '--no-merges', `--format=%H%x1f%s%x1f%an <%ae>%x1f%B${SEP}`, `${base.sha}..${head}`])
    ).stdout;
    return out
      .split(SEP)
      .map((c) => c.replace(/^\n/, ''))
      .filter(Boolean)
      .map((c) => {
        const [sha, subject, author, body] = c.split('\x1f') as [string, string, string, string];
        return { sha, subject, author, trailers: parseIntentTrailers(body) };
      });
  }

  /**
   * Atomically move a tenant branch, failing if it changed since `expectedOld`
   * (e.g. the tenant published an edit while a rebase was running).
   */
  async updateTenant(tenantId: string, newSha: string, expectedOld: string): Promise<void> {
    const r = await this.g(['update-ref', refs.tenant(tenantId), newSha, expectedOld], { allowFail: true });
    if (r.code !== 0) throw new Error(`Tenant ${tenantId} moved concurrently; refusing to overwrite`);
  }

  /** Check out `ref` into a fresh worktree on a throwaway branch. Always dispose() it. */
  async worktree(ref: string, label = 'wt'): Promise<Worktree> {
    const id = `${label.replace(/[^a-z0-9-]/gi, '-')}-${randomBytes(4).toString('hex')}`;
    const path = join(this.worktreesDir, id);
    const branch = `forkui/work/${id}`;
    await this.g(['worktree', 'add', '-q', '-b', branch, path, ref]);
    return new Worktree(path, branch, this.gitDir);
  }
}
