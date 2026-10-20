import { MockProvider } from '../lib/sync';
import type { Ledger } from '../store';

export default function EmptyState({ ledger }: { ledger: Ledger }) {
  return (
    <div className="card empty">
      <h2>Your ledger is blank</h2>
      <p>Load the demo bank to explore, or import a CSV from Connections.</p>
      <div className="row">
        <button onClick={() => ledger.runSync(new MockProvider())}>Load demo data</button>
        <a className="btn ghost" href="#/connections">Import CSV</a>
      </div>
    </div>
  );
}
