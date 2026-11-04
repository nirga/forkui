import { Deal, formatMoney } from './api';

export function Dashboard({ deals }: { deals: Deal[] }) {
  const open = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
  const won = deals.filter((d) => d.stage === 'won');
  const lost = deals.filter((d) => d.stage === 'lost');
  const pipeline = open.reduce((sum, d) => sum + d.amount, 0);
  const wonTotal = won.reduce((sum, d) => sum + d.amount, 0);
  const closed = won.length + lost.length;
  const winRate = closed === 0 ? 0 : Math.round((won.length / closed) * 100);

  return (
    <div className="cards cards-dark" data-testid="dashboard">
      <div className="card card-hero">
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
      <div className="card">
        <span className="card-label">Win rate</span>
        <strong className="card-value">{winRate}%</strong>
      </div>
    </div>
  );
}
