import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.name = 'GitError';
  }
}

export type GitResult = { code: number; stdout: string; stderr: string };

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
};

/** Run git. Throws GitError on non-zero exit unless `allowFail` is set. */
export function git(
  cwd: string,
  args: string[],
  opts: { allowFail?: boolean; env?: Record<string, string>; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...BASE_ENV, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const res = { code, stdout: String(stdout), stderr: String(stderr) };
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, code, res.stdout, res.stderr));
        else resolve(res);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export const FORKUI_IDENTITY = { name: 'forkui', email: 'forkui@localhost' };

export function identityArgs(author?: { name: string; email: string }): string[] {
  const a = author ?? FORKUI_IDENTITY;
  return ['-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`];
}
