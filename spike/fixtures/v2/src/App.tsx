import { useEffect, useMemo, useState } from 'react';
import { Deal, getDeals } from './api';
import { Dashboard } from './Dashboard';
import { DealTable } from './components/deals/DealTable';

export function App() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    getDeals().then(setDeals, (e: Error) => setError(e.message));
  }, []);

  const visible = useMemo(() => {
    if (!deals) return [];
    const q = query.trim().toLowerCase();
    if (!q) return deals;
    return deals.filter((d) => d.name.toLowerCase().includes(q) || d.company.toLowerCase().includes(q));
  }, [deals, query]);

  if (error) return <p role="alert">{error}</p>;
  if (!deals) return <p>Loading…</p>;

  return (
    <main className="app">
      <header className="app-header">
        <h1>Acme CRM</h1>
      </header>
      <Dashboard deals={deals} />
      <section>
        <div className="section-head">
          <h2>Deals</h2>
          <input
            className="search"
            type="search"
            placeholder="Search deals"
            aria-label="Search deals"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DealTable deals={visible} />
      </section>
    </main>
  );
}
