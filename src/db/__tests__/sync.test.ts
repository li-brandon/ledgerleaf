import { describe, expect, it, vi } from 'vitest';
import { readLedger, saveLedger } from '../ledger';
import { createPersister } from '../persister';
import { emptyLedger } from '../../lib/migrate';
import { MockProvider, applySync, fetchSync, type SyncProvider } from '../../lib/sync';
import type { LedgerState } from '../../lib/types';
import { ADAPTERS } from './helpers';

const now = new Date(2026, 9, 20);

/** What the store does: fetch and validate, merge, then commit before anything else changes. */
async function sync(state: LedgerState, p: SyncProvider, commit: (s: LedgerState) => Promise<void>) {
  const outcome = applySync(state, p.id, await fetchSync(p, state), now);
  await commit(outcome.state);
  return outcome;
}

describe.each(ADAPTERS)('syncing into %s', (_, open) => {
  async function setup() {
    const repo = await open();
    const initial = emptyLedger('2026-10');
    await saveLedger(repo, initial);
    return { repo, initial, persister: createPersister(repo, initial, 1000, () => {}) };
  }

  it('persists per-provider sync times and adds 0 rows on re-sync', async () => {
    const { repo, initial, persister } = await setup();
    const first = await sync(initial, new MockProvider(now), persister.commit);
    const stored = await readLedger(repo);
    expect(stored?.syncs).toEqual({ mock: { lastSync: now.toISOString() } });
    expect(stored?.transactions).toHaveLength(first.added);

    const again = await sync(stored!, new MockProvider(now), persister.commit);
    expect(again.added).toBe(0);
    expect((await readLedger(repo))?.transactions).toHaveLength(first.added);
  });

  it('writes nothing when the provider fails part-way', async () => {
    const { repo, initial, persister } = await setup();
    const first = await sync(initial, new MockProvider(now), persister.commit);
    const before = await repo.readAll();
    const apply = vi.spyOn(repo, 'apply');

    const broken = Object.assign(new MockProvider(now), { fetchBalances: async () => { throw new Error('timeout'); } });
    await expect(sync(first.state, broken, persister.commit)).rejects.toThrow('timeout');
    expect(apply).not.toHaveBeenCalled();
    expect(await repo.readAll()).toEqual(before);
  });

  it('leaves stored data intact when the write itself fails', async () => {
    const { repo, initial, persister } = await setup();
    const before = await repo.readAll();
    vi.spyOn(repo, 'apply').mockRejectedValueOnce(new Error('quota'));

    await expect(sync(initial, new MockProvider(now), persister.commit)).rejects.toThrow('quota');
    expect(await repo.readAll()).toEqual(before);

    // The persister recovers: the next commit writes the whole sync.
    const retry = await sync(initial, new MockProvider(now), persister.commit);
    expect((await readLedger(repo))?.transactions).toHaveLength(retry.added);
  });
});
