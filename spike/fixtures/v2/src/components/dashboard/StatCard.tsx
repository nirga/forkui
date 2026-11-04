export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <strong className="card-value">{value}</strong>
    </div>
  );
}
