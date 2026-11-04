import type { ReactNode } from 'react';
import type { Deal } from '../../api';
import { formatMoney } from '../../lib/format';

export type DealColumn = {
  key: string;
  header: string;
  render: (deal: Deal) => ReactNode;
};

export const defaultColumns: DealColumn[] = [
  { key: 'name', header: 'Name', render: (d) => d.name },
  { key: 'company', header: 'Company', render: (d) => d.company },
  { key: 'status', header: 'Status', render: (d) => <span className={`status status-${d.status}`}>{d.status}</span> },
  { key: 'amount', header: 'Amount', render: (d) => formatMoney(d.amount) },
];

export function DealTable({ deals, columns = defaultColumns }: { deals: Deal[]; columns?: DealColumn[] }) {
  return (
    <table className="deals">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{c.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {deals.map((d) => (
          <tr key={d.id}>
            {columns.map((c) => (
              <td key={c.key}>{c.render(d)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
