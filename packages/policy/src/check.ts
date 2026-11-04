import { copyFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import picomatch from 'picomatch';
import type { ForkuiConfig } from '@forkui/core';
import type { Worktree } from '@forkui/git';
import { checkAddedLines, checkDependencies, checkPaths, type AddedLine, type Violation } from './rules.ts';

export type PolicyInput = {
  worktree: Worktree;
  config: ForkuiConfig;
  /** The base release the tenant change is measured against. */
  baseRef: string;
  /**
   * The tenant's previous head. Existing tenant tests/specs must be byte-identical to this ref
   * (unless listed in `approvedTestChanges`). Omit for a brand-new tenant edit on a fresh base.
   */
  previousTenantRef?: string;
  /** Tenant test/spec paths whose change was approved (test-amendment proposals, new intents). */
  approvedTestChanges?: string[];
};

export type PolicyResult = { ok: boolean; violations: Violation[] };

function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let path = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) out.push({ path, line: line++, text: raw.slice(1) });
    else if (!raw.startsWith('-')) line++;
  }
  return out;
}

/** Evaluate every policy rule for the current state of a worktree (committed + uncommitted). */
export async function checkPolicy(input: PolicyInput): Promise<PolicyResult> {
  const { worktree } = input;
  // Make untracked files visible to `git diff <ref>` using a throwaway copy of the index,
  // so the worktree's real index (possibly mid-rebase) is never touched.
  const realIndex = (await worktree.git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
  const tmpIndex = `${realIndex}.forkui-policy-${process.pid}-${Date.now()}`;
  // A missing index (brand-new worktree with nothing checked out) is fine; any other failure must be loud,
  // because an empty temp index would make every file look new.
  const copied = await copyFile(realIndex, tmpIndex).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return false;
    },
  );
  // Keep the original index's timestamps. Git's "racy git" protection compares file mtimes against the
  // INDEX FILE's mtime; a fresh copy would look newer than every file, so a same-size edit made within the
  // same second as the checkout would be trusted as unchanged and slip past policy.
  if (copied) {
    const st = await stat(realIndex);
    await utimes(tmpIndex, st.atime, st.mtime);
  }
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await worktree.git(['add', '--intent-to-add', '--', '.'], { env });
    return await evaluate(input, env);
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

async function evaluate(input: PolicyInput, env: Record<string, string>): Promise<PolicyResult> {
  const { worktree, config, baseRef } = input;
  const changes = await worktree.changedFiles(baseRef, env);
  const violations: Violation[] = [];

  violations.push(...checkPaths(changes, config));

  if (changes.some((c) => c.path === 'package.json')) {
    const before = (await worktree.git(['show', `${baseRef}:package.json`], { allowFail: true })).stdout || null;
    const after = await readFile(`${worktree.path}/package.json`, 'utf8').catch(() => null);
    violations.push(...checkDependencies(before, after, config));
  }

  const diff = (await worktree.git(['diff', '--no-color', '--no-renames', '-U0', baseRef], { env })).stdout;
  violations.push(...checkAddedLines(parseAddedLines(diff), config));

  if (input.previousTenantRef) {
    const testsDir = config.paths.tenantTests.replace(/\/+$/, '');
    const approved = picomatch(input.approvedTestChanges?.length ? input.approvedTestChanges : ['\0none'], { dot: true });
    const prev = (await worktree.git(['ls-tree', '-r', '--name-only', input.previousTenantRef, '--', testsDir])).stdout
      .split('\n')
      .filter(Boolean);
    for (const p of prev) {
      if (approved(p)) continue;
      const before = (await worktree.git(['show', `${input.previousTenantRef}:${p}`])).stdout;
      const now = await readFile(`${worktree.path}/${p}`, 'utf8').catch(() => null);
      if (now !== before)
        violations.push({
          rule: 'tenant-test-modified',
          path: p,
          message:
            now === null
              ? `${p} was deleted; tenant specs and tests can only change through an approved amendment`
              : `${p} was modified; tenant specs and tests can only change through an approved amendment`,
        });
    }
  }

  return { ok: violations.length === 0, violations };
}
