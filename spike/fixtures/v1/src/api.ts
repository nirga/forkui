export type Stage = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';

export type Deal = {
  id: string;
  name: string;
  company: string;
  stage: Stage;
  amount: number;
  priority: 'low' | 'medium' | 'high';
  owner: string;
};

export async function getDeals(): Promise<Deal[]> {
  const res = await fetch('/api/deals');
  if (!res.ok) throw new Error(`Failed to load deals: ${res.status}`);
  return res.json();
}

export function formatMoney(n: number): string {
  return '$' + n.toLocaleString('en-US');
}
