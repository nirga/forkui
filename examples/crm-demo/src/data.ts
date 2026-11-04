/** Each customer org sees its own deals. The vendor's backend; forkui never touches it. */
type Stage = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';
type Deal = { id: string; name: string; company: string; stage: Stage; amount: number; priority: 'low' | 'medium' | 'high'; owner: string };

const d = (id: string, name: string, company: string, stage: Stage, amount: number, priority: Deal['priority'], owner: string): Deal => ({
  id, name, company, stage, amount, priority, owner,
});

export const DEALS: Record<string, Deal[]> = {
  acme: [
    d('a1', 'Website revamp', 'Globex Retail', 'proposal', 12000, 'high', 'Dana'),
    d('a2', 'Support plan', 'Initech', 'won', 8000, 'low', 'Sam'),
    d('a3', 'Data migration', 'Umbrella', 'lead', 20000, 'medium', 'Dana'),
    d('a4', 'Annual license', 'Hooli', 'lost', 5000, 'low', 'Sam'),
    d('a5', 'Analytics add-on', 'Stark Industries', 'qualified', 15000, 'high', 'Dana'),
    d('a6', 'Onboarding package', 'Wayne Enterprises', 'won', 9500, 'medium', 'Sam'),
  ],
  globex: [
    d('g1', 'Fleet tracking', 'Cyberdyne', 'qualified', 42000, 'high', 'Lee'),
    d('g2', 'Warehouse sensors', 'Tyrell Corp', 'proposal', 31000, 'medium', 'Lee'),
    d('g3', 'Driver app', 'Soylent', 'won', 18000, 'low', 'Max'),
    d('g4', 'Route optimizer', 'Oscorp', 'lost', 27000, 'high', 'Max'),
    d('g5', 'Dispatch console', 'Massive Dynamic', 'lead', 12000, 'medium', 'Lee'),
  ],
  initech: [
    d('i1', 'TPS report automation', 'Penetrode', 'proposal', 7000, 'medium', 'Ivy'),
    d('i2', 'Printer fleet', 'Chotchkie’s', 'won', 3500, 'low', 'Ivy'),
    d('i3', 'Stapler inventory', 'Intertrode', 'lead', 1200, 'low', 'Ivy'),
  ],
};

/** v2 API shape: stage -> status, wrapped in { items }. Both versions stay live (backward compatible). */
export const v2 = (deals: Deal[]) => ({
  items: deals.map(({ stage, ...rest }) => ({ ...rest, status: stage })),
  nextCursor: null,
});

export type DemoUser = { id: string; name: string; orgId: string; orgName: string; isAdmin: boolean };

export const USERS: DemoUser[] = [
  { id: 'dana', name: 'Dana', orgId: 'acme', orgName: 'Acme Inc.', isAdmin: true },
  { id: 'sam', name: 'Sam', orgId: 'acme', orgName: 'Acme Inc.', isAdmin: false },
  { id: 'lee', name: 'Lee', orgId: 'globex', orgName: 'Globex Logistics', isAdmin: true },
  { id: 'ivy', name: 'Ivy', orgId: 'initech', orgName: 'Initech', isAdmin: true },
];
