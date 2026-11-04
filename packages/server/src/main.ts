import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { ForkuiServices, type ServerOptions } from './services.ts';

export async function startServer(opts: ServerOptions & { port?: number; hostname?: string }) {
  const svc = await ForkuiServices.create(opts);
  const app = createApp(svc);
  const server = serve({ fetch: app.fetch, port: opts.port ?? 4400, hostname: opts.hostname ?? '127.0.0.1' });
  return { svc, app, close: () => new Promise<void>((r) => server.close(() => r())) };
}
