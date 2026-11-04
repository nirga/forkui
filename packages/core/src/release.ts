/** A built, content-addressed tenant release. Served by @forkui/node at the app's normal URL paths. */
export type ReleaseManifest = {
  releaseId: string;
  tenantId: string;
  /** Tenant commit the release was built from. */
  sha: string;
  /** Base release the commit sits on. */
  baseVersion: string;
  /** URL path -> sha256 of the file, e.g. { "/index.html": "…", "/assets/index-3f9a.js": "…" } */
  files: Record<string, string>;
  /** Extra hosts allowed in CSP connect-src (from config.network.allowHosts). */
  connectSrc: string[];
  createdAt: string;
};

/** Where release files live. Filesystem first; S3/R2 later. */
export interface ArtifactStore {
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array | null>;
  putRelease(m: ReleaseManifest): Promise<void>;
  getRelease(id: string): Promise<ReleaseManifest | null>;
}
