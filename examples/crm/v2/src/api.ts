export type DealStatus = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';

export type Deal = {
  id: string;
  name: string;
  company: string;
  status: DealStatus;
  amount: number;
  priority: 'low' | 'medium' | 'high';
  owner: string;
};

type ListResponse<T> = { items: T[]; nextCursor: string | null };

export async function getDeals(): Promise<Deal[]> {
  const res = await fetch('/api/v2/opportunities');
  if (!res.ok) throw new Error(`Failed to load deals: ${res.status}`);
  const body: ListResponse<Deal> = await res.json();
  return body.items;
}

export const isOpen = (d: Deal) => d.status !== 'won' && d.status !== 'lost';
