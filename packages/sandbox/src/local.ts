import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolve, relative, isAbsolute } from 'node:path';
import { SandboxPathError, type ExecOptions, type ExecResult, type Sandbox, type SandboxDriver } from './types.ts';

const MAX_OUTPUT = 1024 * 1024;
const DEFAULT_ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SHELL', 'USER'];

function capped() {
  let buf = '';
  return {
    push(chunk: Buffer) {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_OUTPUT) buf = buf.slice(-MAX_OUTPUT);
    },
    get value() {
      return buf;
    },
  };
}

export type LocalDriverOptions = {
  /** Host env vars passed through. Everything else (API keys, tokens) is dropped. */
  envAllow?: string[];
  defaultTimeoutMs?: number;
};

/** Runs commands directly on the host, with a scrubbed environment. NOT an isolation boundary. */
export class LocalDriver implements SandboxDriver {
  readonly name = 'local';
  readonly isolated = false;
  constructor(private readonly opts: LocalDriverOptions = {}) {}

  async open(worktreePath: string): Promise<Sandbox> {
    const root = resolve(worktreePath);
    const envAllow = this.opts.envAllow ?? DEFAULT_ENV_ALLOW;
    const defaultTimeout = this.opts.defaultTimeoutMs ?? 300_000;
    const baseEnv: Record<string, string> = {};
    for (const k of envAllow) if (process.env[k] !== undefined) baseEnv[k] = process.env[k]!;

    return {
      root,
      exec: (command: string[], o: ExecOptions = {}) => {
        const cwd = resolve(root, o.cwd ?? '.');
        const rel = relative(root, cwd);
        if (rel.startsWith('..') || isAbsolute(rel)) return Promise.reject(new Error(`cwd escapes sandbox: ${o.cwd}`));
        return run(command, cwd, { ...baseEnv, CI: '1', FORCE_COLOR: '0', ...o.env }, o.timeoutMs ?? defaultTimeout);
      },
      readFile: async (p) => {
        const abs = await confine(root, p);
        return readFile(abs, 'utf8').catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
          throw e;
        });
      },
      writeFile: async (p, content) => {
        const abs = await confine(root, p);
        await mkdir(dirname(abs), { recursive: true });
        await confine(root, p); // re-check after creating parents
        await writeFile(abs, content);
      },
      removeFile: async (p) => {
        const abs = await confine(root, p);
        try {
          await rm(abs);
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw e;
        }
      },
      dispose: async () => {},
    };
  }
}

function run(command: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ExecResult> {
  const [cmd, ...args] = command;
  if (!cmd) return Promise.reject(new Error('empty command'));
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const out = capped();
    const err = capped();
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL'); // whole process group
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);
    const finish = (code: number | null, extraErr = '') => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: out.value, stderr: err.value + extraErr, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (e) => finish(127, String(e.message)));
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve `p` under `root`, rejecting `..`, absolute paths and symlinks that point outside. */
async function confine(root: string, p: string): Promise<string> {
  const abs = resolve(root, p);
  if (!inside(root, abs) || abs === root) throw new SandboxPathError(p);
  const realRoot = await realpath(root);
  // Walk up to the nearest existing ancestor and make sure its real path stays inside.
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(realRoot, real)) throw new SandboxPathError(p);
      break;
    } catch (e) {
      if (e instanceof SandboxPathError) throw e;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return abs;
}
