import { signToken, verifyToken } from './token.ts';

/** What the forkui server returns for a tenant's current (or a preview) release. */
export type ReleaseManifest = {
  releaseId: string;
  tenantId: string;
  /** URL path -> content hash, e.g. { "/index.html": "ab12…", "/assets/index-3f9a.js": "cd34…" } */
  files: Record<string, string>;
  /** Extra hosts allowed in CSP connect-src, from the vendor's forkui.config.json. */
  connectSrc: string[];
};

type MaybePromise<T> = T | Promise<T>;

export type ForkuiOptions<Ctx> = {
  /** Which customer is this request for? Return null/undefined for "no tenant" (base app). */
  tenant: (ctx: Ctx) => MaybePromise<string | null | undefined>;
  /** May this user open the editor? Default: nobody. */
  canCustomize?: (ctx: Ctx) => MaybePromise<boolean>;
  /** End-user id, recorded as the author of customizations. */
  user?: (ctx: Ctx) => MaybePromise<string | null | undefined>;
  /** forkui server URL. Default: FORKUI_URL or http://localhost:4400 */
  server?: string;
  /** Shared secret (>= 32 chars). Default: FORKUI_SECRET. */
  secret?: string;
  /** How long a release manifest is cached. Default 30s. */
  manifestTtlMs?: number;
  /** Max bytes of asset content cached in memory. Default 64 MB. */
  assetCacheBytes?: number;
  /** For tests / custom transports. */
  fetch?: typeof fetch;
  /** Called when forkui is unreachable (the request falls through to the base app). */
  onError?: (err: unknown) => void;
};

export const PREVIEW_COOKIE = 'forkui_preview';
const PREFIX = '/_forkui/';
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
  wasm: 'application/wasm',
};

function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isNavigation(req: Request, path: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const accept = req.headers.get('accept') ?? '';
  const mode = req.headers.get('sec-fetch-mode');
  const last = path.split('/').pop() ?? '';
  return (mode === 'navigate' || accept.includes('text/html')) && (!last.includes('.') || last.endsWith('.html'));
}

class LruBytes {
  private map = new Map<string, Uint8Array>();
  private size = 0;
  constructor(private readonly max: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: Uint8Array) {
    if (v.byteLength > this.max / 4) return;
    this.map.set(k, v);
    this.size += v.byteLength;
    for (const [key, val] of this.map) {
      if (this.size <= this.max) break;
      this.map.delete(key);
      this.size -= val.byteLength;
    }
  }
}

/**
 * The framework-independent core. Returns a Response for requests forkui owns,
 * or null to let the vendor's app handle it (API calls, tenants without a fork, forkui unreachable).
 */
export function createHandler<Ctx>(opts: ForkuiOptions<Ctx>) {
  const env = (k: string) => (typeof process !== 'undefined' ? process.env?.[k] : undefined);
  const server = (opts.server ?? env('FORKUI_URL') ?? 'http://localhost:4400').replace(/\/+$/, '');
  const secret = opts.secret ?? env('FORKUI_SECRET');
  if (!secret) throw new Error('forkui: set FORKUI_SECRET (or pass { secret })');
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.manifestTtlMs ?? 30_000;
  const manifests = new Map<string, { at: number; value: ReleaseManifest | null }>();
  const blobs = new LruBytes(opts.assetCacheBytes ?? 64 * 1024 * 1024);
  const auth = { 'x-forkui-key': secret };

  async function api(path: string): Promise<Response> {
    return doFetch(`${server}${path}`, { headers: auth });
  }

  /** Current release for a tenant, cached; stale on error; null = no fork. */
  async function currentRelease(tenantId: string): Promise<ReleaseManifest | null> {
    const hit = manifests.get(tenantId);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    try {
      const r = await api(`/v1/tenants/${encodeURIComponent(tenantId)}/release`);
      const value = r.status === 404 ? null : r.ok ? ((await r.json()) as ReleaseManifest) : (() => { throw new Error(`forkui server ${r.status}`); })();
      manifests.set(tenantId, { at: Date.now(), value });
      return value;
    } catch (e) {
      opts.onError?.(e);
      return hit ? hit.value : null; // stale-while-error, else fail open
    }
  }

  async function previewRelease(req: Request, tenantId: string): Promise<ReleaseManifest | null> {
    const grant = cookie(req, PREVIEW_COOKIE);
    if (!grant) return null;
    const claims = await verifyToken(grant, secret!, 'preview');
    if (!claims || claims.t !== tenantId || !claims.r) return null;
    try {
      const r = await api(`/v1/releases/${encodeURIComponent(claims.r)}`);
      return r.ok ? ((await r.json()) as ReleaseManifest) : null;
    } catch (e) {
      opts.onError?.(e);
      return null;
    }
  }

  async function blob(hash: string): Promise<Uint8Array | null> {
    const c = blobs.get(hash);
    if (c) return c;
    const r = await api(`/v1/blobs/${hash}`);
    if (!r.ok) throw new Error(`forkui blob ${hash}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    blobs.set(hash, bytes);
    return bytes;
  }

  async function own(req: Request, ctx: Ctx, url: URL): Promise<Response | null> {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const route = url.pathname.slice(PREFIX.length);

    if (route === 'token') {
      const tenantId = await opts.tenant(ctx);
      if (!tenantId) return json(401, { error: 'no tenant' });
      const allowed = (await opts.canCustomize?.(ctx)) ?? false;
      if (!allowed) return json(403, { error: 'not allowed to customize' });
      const userId = (await opts.user?.(ctx)) ?? undefined;
      const token = await signToken({ typ: 'editor', t: tenantId, c: true, ...(userId ? { u: userId } : {}) }, secret!);
      return json(200, { token, editorUrl: `${server}/editor` });
    }

    if (route === 'preview') {
      const grant = url.searchParams.get('grant') ?? '';
      const tenantId = await opts.tenant(ctx);
      const claims = await verifyToken(grant, secret!, 'preview');
      if (!claims || !tenantId || claims.t !== tenantId) return json(403, { error: 'invalid preview grant' });
      const maxAge = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': `${PREVIEW_COOKIE}=${encodeURIComponent(grant)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`,
          'cache-control': 'no-store',
        },
      });
    }

    if (route === 'preview/exit') {
      return new Response(null, {
        status: 302,
        headers: { location: '/', 'set-cookie': `${PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, 'cache-control': 'no-store' },
      });
    }

    if (route === 'status') {
      const tenantId = await opts.tenant(ctx);
      const preview = tenantId ? await previewRelease(req, tenantId) : null;
      const current = tenantId ? await currentRelease(tenantId) : null;
      return json(200, { tenantId: tenantId ?? null, release: (preview ?? current)?.releaseId ?? null, preview: !!preview });
    }
    return json(404, { error: 'not found' });
  }

  return async function handle(req: Request, ctx: Ctx): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname.startsWith(PREFIX)) return own(req, ctx, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;

    const tenantId = await opts.tenant(ctx);
    if (!tenantId) return null;
    const release = (await previewRelease(req, tenantId)) ?? (await currentRelease(tenantId));
    if (!release) return null;

    const path = decodeURIComponent(url.pathname);
    let file = release.files[path] ? path : null;
    let navigation = false;
    if (!file && isNavigation(req, path)) {
      file = '/index.html';
      navigation = true;
    }
    if (!file || !release.files[file]) return null;
    if (file === '/index.html') navigation = true;

    let body: Uint8Array | null;
    try {
      body = await blob(release.files[file]!);
    } catch (e) {
      opts.onError?.(e);
      return null; // fail open to the base app
    }
    const headers = new Headers({ 'content-type': contentType(file), 'x-forkui-release': release.releaseId, vary: 'Cookie' });
    if (navigation) {
      headers.set('cache-control', 'private, no-cache');
      headers.set('content-security-policy', `connect-src 'self' ${release.connectSrc.join(' ')}`.trim());
    } else {
      headers.set('cache-control', HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'private, no-cache');
    }
    return new Response(req.method === 'HEAD' ? null : (body as unknown as ConstructorParameters<typeof Response>[0]), { status: 200, headers });
  };
}
