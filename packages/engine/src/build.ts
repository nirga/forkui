import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ArtifactStore, ReleaseManifest } from '@forkui/core';
import type { EngineDeps } from './types.ts';

export class BuildError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'BuildError';
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Build one tenant commit with the vendor's build command and store it as a release (not yet current). */
export async function buildRelease(
  d: EngineDeps,
  artifacts: ArtifactStore,
  o: { tenantId: string; sha: string },
): Promise<ReleaseManifest> {
  const base = await d.store.tenantBase(o.tenantId, o.sha);
  const config = await d.store.readConfig(base.version);
  const wt = await d.store.worktree(o.sha, `build-${o.tenantId}`);
  const box = await d.driver.open(wt.path);
  try {
    d.onEvent?.({ type: 'phase', tenantId: o.tenantId, phase: 'build', detail: o.sha.slice(0, 10) });
    await d.deps.link(box, config);
    const r = await box.exec(config.build.run, { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new BuildError(`Build failed (${r.code})`, `${r.stdout}\n${r.stderr}`.slice(-8000));
    const outDir = join(wt.path, config.build.outDir);
    const files: Record<string, string> = {};
    for (const abs of await walk(outDir)) {
      const urlPath = '/' + relative(outDir, abs).split(sep).join('/');
      files[urlPath] = await artifacts.putBlob(new Uint8Array(await readFile(abs)));
    }
    if (!files['/index.html']) throw new BuildError(`Build produced no index.html in ${config.build.outDir}/`, '');
    const manifest: ReleaseManifest = {
      releaseId: `rel_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      tenantId: o.tenantId,
      sha: o.sha,
      baseVersion: base.version,
      files,
      connectSrc: config.network.allowHosts.map((h) => (h.includes('://') ? h : `https://${h}`)),
      createdAt: new Date().toISOString(),
    };
    await artifacts.putRelease(manifest);
    return manifest;
  } finally {
    await box.dispose();
    await wt.dispose();
  }
}
