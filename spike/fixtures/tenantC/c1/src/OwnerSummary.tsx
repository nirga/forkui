import { Deal, formatMoney } from './api';

export function OwnerSummary({ deals }: { deals: Deal[] }) {
  const owners = Array.from(new Set(deals.map((d) => d.owner))).sort();
  return (
    <div className="owner-summary">
      {owners.map((owner) => {
        const mine = deals.filter((d) => d.owner === owner);
        return (
          <section key={owner} aria-label={`Deals owned by ${owner}`} className="owner-card">
            <h3>{owner}</h3>
            <strong>{`Total: ${formatMoney(mine.reduce((s, d) => s + d.amount, 0))}`}</strong>
            <span>{`${mine.length} deal${mine.length === 1 ? "" : "s"}`}</span>
          </section>
        );
      })}
    </div>
  );
}
