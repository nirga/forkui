export type ExecOptions = {
  timeoutMs?: number;
  /** Extra environment variables. The base environment is scrubbed by the driver. */
  env?: Record<string, string>;
  /** Working directory relative to the sandbox root. */
  cwd?: string;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

/** A place to run commands against one checked-out worktree. */
export interface Sandbox {
  /** Absolute path of the worktree inside the sandbox. */
  readonly root: string;
  exec(command: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** File access relative to `root`. Implementations must reject paths that escape `root` (incl. via symlinks). */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export class SandboxPathError extends Error {
  constructor(readonly path: string) {
    super(`Path escapes the sandbox: ${path}`);
    this.name = 'SandboxPathError';
  }
}

/**
 * Drivers decide the isolation level. `local` runs on the host (dev/tests only).
 * Production drivers (E2B, Daytona, Vercel Sandbox, Cloudflare Sandbox, Docker) must isolate
 * filesystem and network so one tenant's agent can't read another tenant's code or server secrets.
 */
export interface SandboxDriver {
  readonly name: string;
  readonly isolated: boolean;
  open(worktreePath: string): Promise<Sandbox>;
}
