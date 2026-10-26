import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistenceStatus, requestPersistence } from '../browser';

/** A mocked `navigator.storage`; `persisted` and `persist` resolve (or reject) as given. */
function storage(persisted: boolean | Error, persist: boolean | Error = false) {
  const result = (v: boolean | Error) => () => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return { persisted: vi.fn(result(persisted)), persist: vi.fn(result(persist)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persistenceStatus', () => {
  it('reports persistent, best effort or unsupported', async () => {
    expect(await persistenceStatus(storage(true))).toBe('persistent');
    expect(await persistenceStatus(storage(false))).toBe('best-effort');
    expect(await persistenceStatus(undefined)).toBe('unsupported');
    expect(await persistenceStatus({ persisted: storage(false).persisted })).toBe('unsupported');
    expect(await persistenceStatus({ persist: storage(false).persist })).toBe('unsupported');
  });

  it('treats a failing check as unsupported', async () => {
    expect(await persistenceStatus(storage(new Error('SecurityError')))).toBe('unsupported');
    const throwing = { ...storage(false), persisted: () => { throw new Error('nope'); } };
    expect(await persistenceStatus(throwing)).toBe('unsupported');
  });

  it('reads navigator.storage, and copes without it', async () => {
    vi.stubGlobal('navigator', { storage: storage(true) });
    expect(await persistenceStatus()).toBe('persistent');
    vi.stubGlobal('navigator', {});
    expect(await persistenceStatus()).toBe('unsupported');
    vi.stubGlobal('navigator', undefined);
    expect(await persistenceStatus()).toBe('unsupported');
  });
});

describe('requestPersistence', () => {
  it('asks the browser when storage is best effort and reports a grant', async () => {
    const s = storage(false, true);
    expect(await requestPersistence(s)).toBe('persistent');
    expect(s.persisted).toHaveBeenCalledBefore(s.persist);
    expect(s.persist).toHaveBeenCalledOnce();
  });

  it('reports a refusal as best effort', async () => {
    const s = storage(false, false);
    expect(await requestPersistence(s)).toBe('best-effort');
    expect(s.persist).toHaveBeenCalledOnce();
  });

  it('does not ask again when storage is already persistent', async () => {
    const s = storage(true, true);
    expect(await requestPersistence(s)).toBe('persistent');
    expect(s.persist).not.toHaveBeenCalled();
  });

  it('degrades without errors when unsupported or failing', async () => {
    expect(await requestPersistence(undefined)).toBe('unsupported');
    expect(await requestPersistence({ persist: storage(false, true).persist })).toBe('unsupported');
    const failingCheck = storage(new Error('SecurityError'), true);
    expect(await requestPersistence(failingCheck)).toBe('unsupported');
    expect(failingCheck.persist).not.toHaveBeenCalled();
    expect(await requestPersistence(storage(false, new Error('AbortError')))).toBe('best-effort');
    vi.stubGlobal('navigator', undefined);
    expect(await requestPersistence()).toBe('unsupported');
  });
});
