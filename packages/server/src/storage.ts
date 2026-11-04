import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactStore, ReleaseManifest } from '@forkui/core';

async function writeAtomic(path: string, data: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^rel_[a-z0-9_]+$/;

/** Content-addressed blobs + release manifests on the local filesystem. */
export class FsArtifactStore implements ArtifactStore {
  constructor(readonly dir: string) {}

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const p = this.blobPath(hash);
    if (!existsSync(p)) await writeAtomic(p, bytes);
    return hash;
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    if (!HASH.test(hash)) return null;
    return readFile(this.blobPath(hash)).then((b) => new Uint8Array(b)).catch(() => null);
  }

  async putRelease(m: ReleaseManifest): Promise<void> {
    await writeAtomic(join(this.dir, 'releases', `${m.releaseId}.json`), JSON.stringify(m));
  }

  async getRelease(id: string): Promise<ReleaseManifest | null> {
    if (!RELEASE.test(id)) return null;
    return readFile(join(this.dir, 'releases', `${id}.json`), 'utf8')
      .then((t) => JSON.parse(t) as ReleaseManifest)
      .catch(() => null);
  }

  private blobPath(hash: string) {
    return join(this.dir, 'blobs', hash.slice(0, 2), hash);
  }
}

export type TenantState = {
  tenantId: string;
  /** Release served to the tenant's users. null = no fork (vendor's own deploy). */
  current: string | null;
  history: { releaseId: string | null; at: string; by: string }[];
  /** Set when the last rollout could not carry this tenant to the new base. */
  pinned: { toVersion: string; reason: string; at: string } | null;
  /** The one unpublished change (always the top commit of the branch), if any. */
  pending?: PendingChange | null;
};

export type PendingChange = {
  intentId: string;
  title: string;
  request: string;
  criteria: string[];
  sha: string;
  releaseId: string;
  by: string;
  at: string;
};

/** Per-tenant serving state (which release is live). JSON files; swap for a DB later. */
export class TenantStateStore {
  constructor(readonly dir: string) {}

  private path(tenantId: string) {
    return join(this.dir, 'tenants', `${tenantId}.json`);
  }

  async get(tenantId: string): Promise<TenantState> {
    return readFile(this.path(tenantId), 'utf8')
      .then((t) => JSON.parse(t) as TenantState)
      .then((st) => ({ pending: null, ...st }))
      .catch(() => ({ tenantId, current: null, history: [], pinned: null, pending: null }));
  }

  async update(tenantId: string, fn: (s: TenantState) => TenantState | void): Promise<TenantState> {
    const s = await this.get(tenantId);
    const next = fn(s) ?? s;
    await writeAtomic(this.path(tenantId), JSON.stringify(next, null, 2));
    return next;
  }

  async publish(tenantId: string, releaseId: string | null, by: string) {
    return this.update(tenantId, (s) => {
      s.current = releaseId;
      s.history.push({ releaseId, at: new Date().toISOString(), by });
    });
  }
}

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text: string;
  /** User messages: who said it. */
  author?: string;
  kind: 'text' | 'proposal' | 'build' | 'result' | 'notice';
  proposal?: { title: string; request: string; criteria: string[] };
  /** proposal: proposed -> building -> done | superseded */
  status?: 'proposed' | 'building' | 'done' | 'superseded';
  jobId?: string;
  releaseId?: string;
  outcome?: 'committed' | 'rejected' | 'pinned' | 'failed' | 'published' | 'discarded';
};

/**
 * A feature's conversation and draft title. Everything about what's *built* (versions, status) lives in git:
 * a feature's versions are the branch commits carrying its intent id.
 */
export type FeatureRecord = {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

/** One record per (tenant, feature), shared by the customer's admins. JSON files. */
export class FeatureStore {
  constructor(readonly dir: string) {}

  private folder(tenantId: string) {
    return join(this.dir, 'features', tenantId.replace(/[^a-z0-9-]/g, '_'));
  }

  private path(tenantId: string, id: string) {
    return join(this.folder(tenantId), `${id.replace(/[^a-z0-9-]/g, '_')}.json`);
  }

  async get(tenantId: string, id: string): Promise<FeatureRecord | null> {
    return readFile(this.path(tenantId, id), 'utf8')
      .then((t) => JSON.parse(t) as FeatureRecord)
      .catch(() => null);
  }

  async list(tenantId: string): Promise<FeatureRecord[]> {
    const names = await readdir(this.folder(tenantId)).catch(() => [] as string[]);
    const out: FeatureRecord[] = [];
    for (const n of names.filter((n) => n.endsWith('.json'))) {
      const r = await this.get(tenantId, n.slice(0, -5));
      if (r) out.push(r);
    }
    return out;
  }

  async remove(tenantId: string, id: string) {
    await rm(this.path(tenantId, id), { force: true });
  }

  private locks = new Map<string, Promise<unknown>>();

  /** Serialized read-modify-write; creates the record if `init` is given. */
  async update(tenantId: string, id: string, fn: (r: FeatureRecord) => void, init?: () => FeatureRecord): Promise<FeatureRecord> {
    const key = `${tenantId}/${id}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const r = (await this.get(tenantId, id)) ?? init?.();
      if (!r) throw new Error(`No feature ${id}`);
      fn(r);
      r.updatedAt = new Date().toISOString();
      await writeAtomic(this.path(tenantId, id), JSON.stringify(r, null, 2));
      return r;
    });
    this.locks.set(key, next.catch(() => {}));
    return next;
  }
}
