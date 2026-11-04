import { Deal, formatMoney } from './api';

export function DealsTable({ deals }: { deals: Deal[] }) {
  return (
    <table className="deals">
      <thead>
        <tr>
          <th>Name</th>
          <th>Company</th>
          <th>Stage</th>
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
            <td>{formatMoney(d.amount)}</td>
            <td>{d.owner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
