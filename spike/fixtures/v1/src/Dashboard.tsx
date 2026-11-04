import { Deal, formatMoney } from './api';

export function Dashboard({ deals }: { deals: Deal[] }) {
  const open = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
  const won = deals.filter((d) => d.stage === 'won');
  const pipeline = open.reduce((sum, d) => sum + d.amount, 0);
  const wonTotal = won.reduce((sum, d) => sum + d.amount, 0);

  return (
    <div className="cards">
      <div className="card">
        <span className="card-label">Open pipeline</span>
        <strong className="card-value">{formatMoney(pipeline)}</strong>
      </div>
      <div className="card">
        <span className="card-label">Won</span>
        <strong className="card-value">{formatMoney(wonTotal)}</strong>
      </div>
      <div className="card">
        <span className="card-label">Open deals</span>
        <strong className="card-value">{open.length}</strong>
      </div>
    </div>
  );
}
