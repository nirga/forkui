// Vendor-maintained test helper. Tenant acceptance tests use this so they
// keep working when the vendor changes endpoints or response shapes.
import { vi } from 'vitest';
import { deals as defaultDeals } from './fixtures';
import type { Deal } from '../api';

export function mockApi(deals: Deal[] = defaultDeals) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/v2/opportunities') {
      return new Response(JSON.stringify({ items: deals, nextCursor: null }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export { defaultDeals as deals };
