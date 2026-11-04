import { Deal, isOpen } from './api';
import { formatMoney } from './lib/format';
import { StatCard } from './components/dashboard/StatCard';

export function Dashboard({ deals }: { deals: Deal[] }) {
  const open = deals.filter(isOpen);
  const won = deals.filter((d) => d.status === 'won');
  const pipeline = open.reduce((sum, d) => sum + d.amount, 0);
  const wonTotal = won.reduce((sum, d) => sum + d.amount, 0);
  const avg = open.length === 0 ? 0 : Math.round(pipeline / open.length);

  return (
    <div className="cards">
      <StatCard label="Open pipeline" value={formatMoney(pipeline)} />
      <StatCard label="Won" value={formatMoney(wonTotal)} />
      <StatCard label="Open deals" value={open.length} />
      <StatCard label="Avg open deal" value={formatMoney(avg)} />
    </div>
  );
}
