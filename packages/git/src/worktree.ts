import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { formatIntentMessage, type IntentTrailers } from '@forkui/core';
import { FORKUI_IDENTITY, git, identityArgs, type GitResult } from './exec.ts';

export type Author = { name: string; email: string };

export type RebaseState =
  | { status: 'done'; head: string }
  | { status: 'conflict'; files: string[]; stoppedAt: { sha: string; subject: string } };

/** A checked-out working copy of the store, on its own throwaway branch. */
export class Worktree {
  constructor(
    readonly path: string,
    readonly branch: string,
    private readonly storeGitDir: string,
  ) {}

  git(args: string[], opts?: { allowFail?: boolean; env?: Record<string, string> }): Promise<GitResult> {
    return git(this.path, args, opts);
  }

  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Paths changed (committed + uncommitted + untracked) relative to `fromRef`. */
  async changedFiles(fromRef: string, env?: Record<string, string>): Promise<{ status: string; path: string }[]> {
    const opts = env ? { env } : undefined;
    const committed = (await this.git(['diff', '--name-status', '--no-renames', fromRef], opts)).stdout;
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard'], opts)).stdout;
    const out = new Map<string, string>();
    for (const line of committed.split('\n').filter(Boolean)) {
      const [status, path] = line.split('\t');
      if (status && path) out.set(path, status[0]!);
    }
    for (const path of untracked.split('\n').filter(Boolean)) out.set(path, 'A');
    return [...out].map(([path, status]) => ({ path, status }));
  }

  /** Stage everything and commit it as one tenant intent. Returns the new commit sha. */
  async commitIntent(subject: string, trailers: IntentTrailers, opts: { body?: string; author?: Author } = {}) {
    await this.git(['add', '-A']);
    const message = formatIntentMessage(subject, trailers, opts.body);
    const author = opts.author ?? FORKUI_IDENTITY;
    await git(this.path, [...identityArgs(FORKUI_IDENTITY), 'commit', '-q', '--author', `${author.name} <${author.email}>`, '-F', '-'], {
      input: message,
    });
    return this.head();
  }

  async rebaseInProgress(): Promise<boolean> {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const p = (await this.git(['rev-parse', '--path-format=absolute', '--git-path', dir])).stdout.trim();
      if (existsSync(p)) return true;
    }
    return false;
  }

  async conflictedFiles(): Promise<string[]> {
    const out = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout;
    return out.split('\n').filter(Boolean);
  }

  private async rebaseState(): Promise<RebaseState> {
    if (!(await this.rebaseInProgress())) return { status: 'done', head: await this.head() };
    const stopped = (await this.git(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], { allowFail: true })).stdout.trim();
    const subject = stopped ? (await this.git(['log', '-1', '--format=%s', stopped])).stdout.trim() : '';
    return { status: 'conflict', files: await this.conflictedFiles(), stoppedAt: { sha: stopped, subject } };
  }

  /** Rebase this worktree's branch onto `onto`. Stops (does not abort) on conflict. */
  async rebase(onto: string): Promise<RebaseState> {
    await git(this.path, [...identityArgs(), 'rebase', '--no-autosquash', onto], { allowFail: true });
    return this.rebaseState();
  }

  async continueRebase(): Promise<RebaseState> {
    await git(this.path, [...identityArgs(), 'rebase', '--continue'], { allowFail: true });
    return this.rebaseState();
  }

  /** Abort an in-progress rebase. Falls back to --quit if the tree is too messy to abort cleanly. */
  async abortRebase(): Promise<void> {
    if (!(await this.rebaseInProgress())) return;
    const r = await this.git(['rebase', '--abort'], { allowFail: true });
    if (r.code !== 0) await this.git(['rebase', '--quit']);
  }

  /** Discard every change and put the worktree at `ref` (keeps node_modules). */
  async resetTo(ref: string): Promise<void> {
    await this.abortRebase();
    await this.git(['reset', '-q', '--hard', ref]);
    await this.git(['clean', '-fdq', '-e', 'node_modules']);
  }

  /** Remove the worktree and its throwaway branch. Safe to call twice. */
  async dispose(): Promise<void> {
    await git(this.storeGitDir, ['worktree', 'remove', '--force', this.path], { allowFail: true });
    await rm(this.path, { recursive: true, force: true });
    await git(this.storeGitDir, ['worktree', 'prune'], { allowFail: true });
    await git(this.storeGitDir, ['branch', '-D', this.branch], { allowFail: true });
  }
}
