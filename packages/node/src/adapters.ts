import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandler, type ForkuiOptions } from './handler.ts';

type NodeReq = IncomingMessage & { originalUrl?: string; protocol?: string };
type Next = (err?: unknown) => void;

function toRequest(req: NodeReq): Request {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const proto = forwarded || req.protocol || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const url = `${proto}://${req.headers.host ?? 'localhost'}${req.originalUrl ?? req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  return new Request(url, { method: req.method ?? 'GET', headers });
}

/**
 * Express / Connect middleware:
 *
 *   app.use(forkui({ tenant: (req) => req.user?.orgId, canCustomize: (req) => req.user?.isAdmin }))
 *
 * Mount it before your static file handler. Anything forkui doesn't own falls through to `next()`.
 */
export function forkui<Req extends NodeReq = NodeReq>(opts: ForkuiOptions<Req>) {
  const handle = createHandler(opts);
  return async function forkuiMiddleware(req: Req, res: ServerResponse, next: Next): Promise<void> {
    let r: Response | null;
    try {
      r = await handle(toRequest(req), req);
    } catch (e) {
      opts.onError?.(e);
      return next(); // never take the vendor's app down
    }
    if (!r) return next();
    res.statusCode = r.status;
    r.headers.forEach((value, key) => {
      if (key !== 'set-cookie') res.setHeader(key, value);
    });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
  };
}

/** Hono (and anything with `c.req.raw`): `app.use(forkuiHono({ tenant: (c) => c.get('user')?.orgId }))` */
export function forkuiHono<C extends { req: { raw: Request } }>(opts: ForkuiOptions<C>) {
  const handle = createHandler(opts);
  return async (c: C, next: () => Promise<void>): Promise<Response | void> => {
    const r = await handle(c.req.raw, c).catch((e) => {
      opts.onError?.(e);
      return null;
    });
    if (r) return r;
    await next();
  };
}

/** Plain Fetch API (Cloudflare Workers, Deno, Bun): returns null when the request isn't forkui's. */
export function forkuiFetch(opts: ForkuiOptions<Request>) {
  const handle = createHandler(opts);
  return (req: Request) => handle(req, req);
}
