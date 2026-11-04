import { Deal, Stage, formatMoney } from './api';

const columns: Stage[] = ['lead', 'qualified', 'proposal', 'won'];

export function Pipeline({ deals }: { deals: Deal[] }) {
  return (
    <div className="pipeline">
      {columns.map((stage) => {
        const inStage = deals.filter((d) => d.stage === stage);
        return (
          <section key={stage} className="pipeline-col" aria-label={stage}>
            <h3>
              {stage} ({inStage.length})
            </h3>
            {inStage.map((d) => (
              <article key={d.id} className="pipeline-card">
                <strong>{d.name}</strong>
                <span>{formatMoney(d.amount)}</span>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
