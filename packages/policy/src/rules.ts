import picomatch from 'picomatch';
import type { ForkuiConfig } from '@forkui/core';

export type Violation = {
  rule:
    | 'locked-path'
    | 'vendor-owned-path'
    | 'tenant-test-modified'
    | 'dependency-not-allowed'
    | 'forbidden-code'
    | 'network-host-not-allowed'
    | 'conflict-marker';
  path: string;
  message: string;
  line?: number;
};

export type FileChange = { status: string; path: string };
export type AddedLine = { path: string; line: number; text: string };

const CODE_EXT = /\.(m?[jt]sx?|html|vue|svelte)$/;

const FORBIDDEN: { re: RegExp; what: string }[] = [
  { re: /\beval\s*\(/, what: 'eval()' },
  { re: /\bnew\s+Function\s*\(/, what: 'new Function()' },
  { re: /\bdocument\.cookie\b/, what: 'document.cookie' },
  { re: /<script\b/i, what: 'inline <script>' },
  { re: /\bimport\s*\(\s*['"`]https?:/, what: 'remote dynamic import' },
  { re: /\bimportScripts\s*\(/, what: 'importScripts()' },
];

const URL_RE = /\b(?:https?|wss?):\/\/([a-z0-9.-]+)(?::\d+)?/gi;

const SAFE_HOSTS = ['localhost', 'www.w3.org']; // xmlns etc.

function matcher(globs: string[]) {
  return globs.length ? picomatch(globs, { dot: true }) : () => false;
}

/** Path-level rules: which files a tenant change touched. */
export function checkPaths(changes: FileChange[], config: ForkuiConfig): Violation[] {
  const locked = matcher(config.paths.locked);
  const vendorOwned = matcher(config.paths.vendorOwned);
  const out: Violation[] = [];
  for (const c of changes) {
    if (locked(c.path)) out.push({ rule: 'locked-path', path: c.path, message: `${c.path} is locked by the vendor` });
    else if (vendorOwned(c.path))
      out.push({ rule: 'vendor-owned-path', path: c.path, message: `${c.path} is owned by the vendor (test kit / contract tests)` });
  }
  return out;
}

/** package.json: only allow-listed dependencies may be added or changed. */
export function checkDependencies(before: string | null, after: string | null, config: ForkuiConfig): Violation[] {
  if (after === null || before === after) return [];
  const allowed = matcher(config.dependencies.allow);
  const parse = (s: string | null) => {
    try {
      return s ? (JSON.parse(s) as Record<string, unknown>) : {};
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return [{ rule: 'dependency-not-allowed', path: 'package.json', message: 'package.json is not valid JSON' }];
  const out: Violation[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const prev = (a[field] ?? {}) as Record<string, string>;
    const next = (b[field] ?? {}) as Record<string, string>;
    for (const [name, ver] of Object.entries(next)) {
      if (prev[name] === ver) continue;
      if (!allowed(name))
        out.push({
          rule: 'dependency-not-allowed',
          path: 'package.json',
          message: `${field}: "${name}@${ver}" is not in the vendor's dependency allowlist`,
        });
    }
  }
  // Anything else in package.json (scripts, config) is vendor territory.
  const strip = (o: Record<string, unknown>) => {
    const { dependencies: _d, devDependencies: _dd, peerDependencies: _p, optionalDependencies: _o, ...rest } = o;
    return JSON.stringify(rest);
  };
  if (strip(a) !== strip(b))
    out.push({ rule: 'locked-path', path: 'package.json', message: 'Only dependency entries in package.json may change' });
  return out;
}

/** Line-level rules on added code. A guardrail, not a security boundary (CSP + proxy enforce at runtime). */
export function checkAddedLines(lines: AddedLine[], config: ForkuiConfig): Violation[] {
  const hostAllowed = matcher([...config.network.allowHosts, ...SAFE_HOSTS]);
  const out: Violation[] = [];
  for (const l of lines) {
    if (/^(<{7}|>{7})( |$)|^={7}$/.test(l.text))
      out.push({ rule: 'conflict-marker', path: l.path, line: l.line, message: 'Unresolved merge conflict marker' });
    if (!CODE_EXT.test(l.path)) continue;
    for (const f of FORBIDDEN)
      if (f.re.test(l.text))
        out.push({ rule: 'forbidden-code', path: l.path, line: l.line, message: `${f.what} is not allowed in tenant code` });
    for (const m of l.text.matchAll(URL_RE)) {
      const host = m[1]!.toLowerCase();
      if (!hostAllowed(host))
        out.push({
          rule: 'network-host-not-allowed',
          path: l.path,
          line: l.line,
          message: `${host} is not an allowed host; call the backend through relative URLs (proxied)`,
        });
    }
  }
  return out;
}
