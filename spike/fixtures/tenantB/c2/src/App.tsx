import { useEffect, useState } from 'react';
import { Deal, getDeals } from './api';
import { Dashboard } from './Dashboard';
import { DealsTable } from './DealsTable';
import { Pipeline } from './Pipeline';

type Tab = 'overview' | 'pipeline';

export function App() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    getDeals().then(setDeals, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!deals) return <p>Loading…</p>;

  return (
    <main className="app">
      <header className="app-header">
        <h1>Acme CRM</h1>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </button>
          <button role="tab" aria-selected={tab === 'pipeline'} onClick={() => setTab('pipeline')}>
            Pipeline
          </button>
        </nav>
      </header>
      {tab === 'overview' ? (
        <>
          <Dashboard deals={deals} />
          <section>
            <h2>Deals</h2>
            <DealsTable deals={deals} />
          </section>
        </>
      ) : (
        <Pipeline deals={deals} />
      )}
    </main>
  );
}
