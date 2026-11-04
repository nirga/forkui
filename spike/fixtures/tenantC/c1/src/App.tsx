import { useEffect, useState } from 'react';
import { Deal, getDeals } from './api';
import { Dashboard } from './Dashboard';
import { DealsTable } from './DealsTable';
import { OwnerSummary } from './OwnerSummary';

export function App() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDeals().then(setDeals, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!deals) return <p>Loading…</p>;

  return (
    <main className="app">
      <header className="app-header">
        <h1>Acme CRM</h1>
      </header>
      <Dashboard deals={deals} />
      <OwnerSummary deals={deals} />
      <section>
        <h2>Deals</h2>
        <DealsTable deals={deals} />
      </section>
    </main>
  );
}
