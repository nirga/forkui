import { describe, expect, test, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler, forkui, signToken, verifyToken, type ReleaseManifest } from '../src/index.ts';

const SECRET = 'test-secret-test-secret-test-secret-123';
const enc = (s: string) => new TextEncoder().encode(s);

const manifest: ReleaseManifest = {
  releaseId: 'rel-a1',
  tenantId: 'acme',
  files: { '/index.html': 'h-index', '/assets/index-3f9a8b7c.js': 'h-js', '/logo.svg': 'h-logo' },
  connectSrc: ['https://api.acme.test'],
};
const preview: ReleaseManifest = { ...manifest, releaseId: 'rel-preview', files: { '/index.html': 'h-preview' } };
const blobs: Record<string, string> = {
  'h-index': '<html>tenant build</html>',
  'h-js': 'console.log(1)',
  'h-logo': '<svg/>',
  'h-preview': '<html>preview</html>',
};

function fakeServer(opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (opts.down) throw new Error('ECONNREFUSED');
    if ((init?.headers as Record<string, string>)['x-forkui-key'] !== SECRET) return new Response('no', { status: 401 });
    if (u.pathname === '/v1/tenants/acme/release') return Response.json(manifest);
    if (u.pathname === '/v1/tenants/plain/release') return new Response('none', { status: 404 });
    if (u.pathname === '/v1/releases/rel-preview') return Response.json(preview);
    const m = u.pathname.match(/^\/v1\/blobs\/(.+)$/);
    if (m && blobs[m[1]!]) return new Response(enc(blobs[m[1]!]!));
    return new Response('not found', { status: 404 });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

type Ctx = { tenant: string | null; admin?: boolean };
const req = (path: string, init: RequestInit & { html?: boolean } = {}) =>
  new Request(`http://app.test${path}`, {
    ...init,
    headers: { ...(init.html ? { accept: 'text/html', 'sec-fetch-mode': 'navigate' } : {}), ...(init.headers as object) },
  });

function handler(server = fakeServer(), extra: Partial<Parameters<typeof createHandler<Ctx>>[0]> = {}) {
  return createHandler<Ctx>({
    secret: SECRET,
    server: 'http://forkui.test',
    fetch: server.fetch,
    tenant: (c) => c.tenant,
    canCustomize: (c) => !!c.admin,
    ...extra,
  });
}

describe('tokens', () => {
  test('sign/verify, expiry, tampering, type', async () => {
    const t = await signToken({ typ: 'editor', t: 'acme', u: 'u1', c: true }, SECRET);
    expect(await verifyToken(t, SECRET)).toMatchObject({ typ: 'editor', t: 'acme', u: 'u1', c: true });
    expect(await verifyToken(t, SECRET, 'preview')).toBeNull();
    expect(await verifyToken(t, SECRET.replace('1', '2'))).toBeNull();
    const [h, p, s] = t.split('.');
    const forged = btoa(JSON.stringify({ typ: 'editor', t: 'other', c: true, exp: 9e9 })).replace(/=+$/, '');
    expect(await verifyToken(`${h}.${forged}.${s}`, SECRET)).toBeNull();
    expect(await verifyToken(`${h}.${p}`, SECRET)).toBeNull();
    const old = await signToken({ typ: 'editor', t: 'acme', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect(await verifyToken(old, SECRET)).toBeNull();
    await expect(signToken({ typ: 'editor', t: 'x' }, 'short')).rejects.toThrow(/32/);
  });
});

describe('serving', () => {
  test('tenant with a fork: navigation gets its index.html with CSP and no shared caching', async () => {
    const h = handler();
    const r = (await h(req('/deals/42', { html: true }), { tenant: 'acme' }))!;
    expect(await r.text()).toBe('<html>tenant build</html>');
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cache-control')).toBe('private, no-cache');
    expect(r.headers.get('content-security-policy')).toBe("connect-src 'self' https://api.acme.test");
    expect(r.headers.get('x-forkui-release')).toBe('rel-a1');
  });

  test('assets: hashed are immutable, unhashed are private', async () => {
    const h = handler();
    const js = (await h(req('/assets/index-3f9a8b7c.js'), { tenant: 'acme' }))!;
    expect(await js.text()).toBe('console.log(1)');
    expect(js.headers.get('cache-control')).toMatch(/immutable/);
    const logo = (await h(req('/logo.svg'), { tenant: 'acme' }))!;
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(logo.headers.get('cache-control')).toBe('private, no-cache');
  });

  test('falls through: API calls, unknown assets, non-GET, no tenant, tenant without a fork', async () => {
    const h = handler();
    expect(await h(req('/api/deals', { headers: { accept: 'application/json' } }), { tenant: 'acme' })).toBeNull();
    expect(await h(req('/assets/base-only.js'), { tenant: 'acme' })).toBeNull();
    expect(await h(req('/', { method: 'POST', html: true }), { tenant: 'acme' })).toBeNull();
    expect(await h(req('/', { html: true }), { tenant: null })).toBeNull();
    expect(await h(req('/', { html: true }), { tenant: 'plain' })).toBeNull();
  });

  test('fails open when forkui is down, and caches manifests', async () => {
    const down = fakeServer({ down: true });
    const onError = vi.fn();
    expect(await handler(down, { onError })(req('/', { html: true }), { tenant: 'acme' })).toBeNull();
    expect(onError).toHaveBeenCalled();

    const up = fakeServer();
    const h = handler(up);
    await h(req('/', { html: true }), { tenant: 'acme' });
    await h(req('/', { html: true }), { tenant: 'acme' });
    expect(up.calls.filter((c) => c.endsWith('/release'))).toHaveLength(1);
    expect(up.calls.filter((c) => c.startsWith('/v1/blobs/'))).toHaveLength(1); // blob cached too
  });

  test('stale-while-error: serves the last known release if the server goes away', async () => {
    let down = false;
    const base = fakeServer();
    const flaky = (async (u: string, i?: RequestInit) => {
      if (down) throw new Error('down');
      return base.fetch(u, i);
    }) as unknown as typeof fetch;
    const h = handler({ fetch: flaky, calls: [] }, { manifestTtlMs: 0 });
    expect(await (await h(req('/', { html: true }), { tenant: 'acme' }))!.text()).toContain('tenant build');
    down = true;
    expect(await (await h(req('/', { html: true }), { tenant: 'acme' }))!.text()).toContain('tenant build');
  });
});

describe('editor token and preview', () => {
  test('/_forkui/token only for users allowed to customize', async () => {
    const h = handler();
    expect((await h(req('/_forkui/token'), { tenant: 'acme' }))!.status).toBe(403);
    expect((await h(req('/_forkui/token'), { tenant: null, admin: true }))!.status).toBe(401);
    const ok = (await h(req('/_forkui/token'), { tenant: 'acme', admin: true }))!;
    const body = (await ok.json()) as { token: string; editorUrl: string };
    expect(body.editorUrl).toBe('http://forkui.test/editor');
    expect(await verifyToken(body.token, SECRET, 'editor')).toMatchObject({ t: 'acme', c: true });
  });

  test('a preview grant sets an HttpOnly cookie that overrides the release for that tenant only', async () => {
    const h = handler();
    const grant = await signToken({ typ: 'preview', t: 'acme', r: 'rel-preview' }, SECRET, 600);
    expect((await h(req(`/_forkui/preview?grant=${grant}`), { tenant: 'other' }))!.status).toBe(403);
    const set = (await h(req(`/_forkui/preview?grant=${grant}`), { tenant: 'acme' }))!;
    expect(set.status).toBe(302);
    const c = set.headers.get('set-cookie')!;
    expect(c).toMatch(/^forkui_preview=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
    const cookieHeader = c.split(';')[0]!;
    const page = (await h(req('/', { html: true, headers: { cookie: cookieHeader } }), { tenant: 'acme' }))!;
    expect(await page.text()).toBe('<html>preview</html>');
    // Same cookie presented under another tenant is ignored.
    expect(await h(req('/', { html: true, headers: { cookie: cookieHeader } }), { tenant: 'plain' })).toBeNull();
    const status = (await (await h(req('/_forkui/status', { headers: { cookie: cookieHeader } }), { tenant: 'acme' }))!.json()) as object;
    expect(status).toEqual({ tenantId: 'acme', release: 'rel-preview', preview: true });
  });
});

describe('express adapter', () => {
  test('serves forked builds and falls through to the app otherwise', async () => {
    const server = fakeServer();
    const mw = forkui<IncomingMessage & { tenant?: string }>({
      secret: SECRET,
      server: 'http://forkui.test',
      fetch: server.fetch,
      tenant: (r) => r.headers['x-tenant'] as string | undefined,
    });
    const http = createServer((rq, rs) => {
      void mw(rq, rs, () => {
        rs.setHeader('content-type', 'text/plain');
        rs.end('base app');
      });
    });
    await new Promise<void>((r) => http.listen(0, r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    try {
      const forked = await fetch(`${base}/`, { headers: { accept: 'text/html', 'x-tenant': 'acme' } });
      expect(await forked.text()).toBe('<html>tenant build</html>');
      expect(forked.headers.get('content-security-policy')).toContain("'self'");
      const plain = await fetch(`${base}/`, { headers: { accept: 'text/html', 'x-tenant': 'plain' } });
      expect(await plain.text()).toBe('base app');
      const api = await fetch(`${base}/api/deals`, { headers: { 'x-tenant': 'acme' } });
      expect(await api.text()).toBe('base app');
    } finally {
      http.close();
    }
  });
});
