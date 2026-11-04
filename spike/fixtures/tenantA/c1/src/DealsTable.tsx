import { Deal, formatMoney } from './api';

const priorityColors: Record<Deal['priority'], string> = {
  high: '#d92d20',
  medium: '#dc6803',
  low: '#667085',
};

export function DealsTable({ deals }: { deals: Deal[] }) {
  return (
    <table className="deals">
      <thead>
        <tr>
          <th>Name</th>
          <th>Company</th>
          <th>Stage</th>
          <th>Priority</th>
          <th>Amount</th>
          <th>Owner</th>
        </tr>
      </thead>
      <tbody>
        {deals.map((d) => (
          <tr key={d.id}>
            <td>{d.name}</td>
            <td>{d.company}</td>
            <td>{d.stage}</td>
            <td>
              <span className="priority-badge" style={{ color: priorityColors[d.priority] }}>
                {d.priority}
              </span>
            </td>
            <td>{formatMoney(d.amount)}</td>
            <td>{d.owner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
