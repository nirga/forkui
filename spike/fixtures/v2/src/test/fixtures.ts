import type { Deal } from '../api';

export const deals: Deal[] = [
  { id: 'd1', name: 'Website revamp', company: 'Globex', status: 'proposal', amount: 12000, priority: 'high', owner: 'Dana' },
  { id: 'd2', name: 'Support plan', company: 'Initech', status: 'won', amount: 8000, priority: 'low', owner: 'Sam' },
  { id: 'd3', name: 'Data migration', company: 'Umbrella', status: 'lead', amount: 20000, priority: 'medium', owner: 'Dana' },
  { id: 'd4', name: 'Annual license', company: 'Hooli', status: 'lost', amount: 5000, priority: 'low', owner: 'Lee' },
];
