import picomatch from 'picomatch';
import type { ForkuiConfig } from '@forkui/core';

export type WriteGuard = (path: string) => string | null;

/**
 * Immediate feedback for agent write tools: returns a reason if the path may not be written.
 * This mirrors `checkPolicy` (which remains the authoritative, after-the-fact check).
 */
export function createWriteGuard(config: ForkuiConfig, opts: { writableTenantTests?: string[] } = {}): WriteGuard {
  const locked = picomatch(config.paths.locked.length ? config.paths.locked : ['\0'], { dot: true });
  const vendorOwned = picomatch(config.paths.vendorOwned.length ? config.paths.vendorOwned : ['\0'], { dot: true });
  const testsDir = config.paths.tenantTests.replace(/\/+$/, '');
  const writableTests = new Set(opts.writableTenantTests ?? []);
  return (raw) => {
    const path = raw.replace(/^\.\/+/, '');
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) return 'path must be relative to the repo root';
    if (path === '.git' || path.startsWith('.git/') || path.split('/').includes('node_modules'))
      return 'git metadata and node_modules are managed by forkui';
    if (locked(path)) return `${path} is locked by the vendor`;
    if (vendorOwned(path)) return `${path} is owned by the vendor (test kit, fixtures or contract tests)`;
    if ((path === testsDir || path.startsWith(testsDir + '/')) && !writableTests.has(path))
      return `${path} is a frozen tenant spec/test; it may only change through an approved amendment`;
    return null;
  };
}
