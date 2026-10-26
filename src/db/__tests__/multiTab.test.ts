import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, DB_VERSION, openIdbRepository } from '../indexeddb';
import { readLedger, saveLedger } from '../ledger';
import { createMemoryRepository } from '../memory';
import { createPersister } from '../persister';
import type { Repository } from '../repository';
import { emptyLedger } from '../../lib/migrate';
import type { LedgerState } from '../../lib/types';
import './helpers';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

/** Two tabs on the same storage. */
const TABS: [string, () => Promise<[Repository, Repository]>][] = [
  ['memory', async () => {
    const repo = createMemoryRepository();
    return [repo, repo];
  }],
  ['indexeddb', async () => [await openIdbRepository(), await openIdbRepository()]],
];

describe.each(TABS)('two tabs on %s', (_, open) => {
  it('keep both values when they save different meta keys from the same base', async () => {
    const [a, b] = await open();
    const base: LedgerState = { ...emptyLedger('2026-10'), lastSync: '2026-10-01T00:00:00.000Z' };
    await saveLedger(a, base);

    const settings = { currency: 'EUR', monthStartDay: 15, theme: 'dark' } as const;
    await saveLedger(a, { ...base, settings }, base);
    // Tab B has not seen tab A's save.
    const recurring = { decisions: { 'netflix|monthly': 'confirmed' as const }, manual: [] };
    await saveLedger(b, { ...base, recurring, lastSync: undefined }, base);

    const stored = await readLedger(a);
    expect(stored?.settings).toEqual(settings);
    expect(stored?.recurring).toEqual(recurring);
    expect(stored?.lastSync).toBeUndefined();
  });
});

describe('persister', () => {
  it('announces each successful write, and adopts a state read back without writing it', async () => {
    const repo = createMemoryRepository();
    const initial = emptyLedger('2026-10');
    await saveLedger(repo, initial);
    const onSaved = vi.fn();
    const p = createPersister(repo, initial, 0, () => {}, undefined, onSaved);

    await p.commit({ ...initial, lastSync: 'now' });
    expect(onSaved).toHaveBeenCalledTimes(1);
    const apply = vi.spyOn(repo, 'apply').mockRejectedValueOnce(new Error('quota'));
    await expect(p.commit({ ...initial, lastSync: 'later' })).rejects.toThrow('quota');
    expect(onSaved).toHaveBeenCalledTimes(1);

    const fromOtherTab = (await readLedger(repo))!;
    apply.mockClear();
    p.reset(fromOtherTab);
    p.schedule(fromOtherTab);
    await p.flush();
    expect(apply).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('schema upgrades in another tab', () => {
  it('blocking: saves through the callback, closes, and lets the upgrade finish', async () => {
    let repo: Repository | undefined;
    const onBlocking = vi.fn(() => repo!.apply({ meta: { lastSync: 'before closing' } }));
    repo = await openIdbRepository(DB_NAME, { onBlocking });
    await saveLedger(repo, emptyLedger('2026-10'));

    const upgraded = await openDB(DB_NAME, DB_VERSION + 1);
    expect(onBlocking).toHaveBeenCalledTimes(1);
    expect(await upgraded.get('meta', 'lastSync')).toBe('before closing');
    await expect(repo.apply({ meta: { lastSync: 'after closing' } })).rejects.toThrow();
    upgraded.close();
  });

  it('blocked: waits for an older tab that ignores the request, then opens once it closes', async () => {
    (await openIdbRepository()).close();
    const old = await openDB(DB_NAME, DB_VERSION); // no versionchange handling
    const onBlocked = vi.fn();
    let opened = false;
    const opening = openIdbRepository(DB_NAME, { version: DB_VERSION + 1, onBlocked }).then((r) => {
      opened = true;
      return r;
    });

    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toBe(false);

    old.close();
    const repo = await opening;
    expect(await repo.meta.get()).toEqual({});
    repo.close();
  });
});
