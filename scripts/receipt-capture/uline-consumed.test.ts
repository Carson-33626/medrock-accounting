import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsumedStore } from './uline-consumed';

describe('loadConsumedStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('missing file -> empty store, not flagged corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-consumed-'));
    const store = loadConsumedStore(join(dir, 'uline-consumed.json'));
    expect(store.has('12345')).toBe(false);
    expect(store.all()).toEqual({});
    expect(store.corrupt).toBe(false);
  });

  it('has/record round-trip, persisted to disk for the next load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-consumed-'));
    const path = join(dir, 'uline-consumed.json');
    const store = loadConsumedStore(path);
    expect(store.has('12345')).toBe(false);

    store.record('12345', 'txn-abc', 'FL');
    expect(store.has('12345')).toBe(true);
    expect(store.all()['12345']).toMatchObject({ txnId: 'txn-abc', entity: 'FL' });

    // A fresh load from the same path picks up what was just written (append-only file rewritten
    // atomically on each record, per spec — not merely an in-memory cache).
    const reloaded = loadConsumedStore(path);
    expect(reloaded.has('12345')).toBe(true);
    expect(reloaded.all()['12345']).toMatchObject({ txnId: 'txn-abc', entity: 'FL' });
    expect(reloaded.corrupt).toBe(false);
  });

  it('corrupt file -> empty store + console warn, never throws, flagged corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-consumed-'));
    const path = join(dir, 'uline-consumed.json');
    writeFileSync(path, '{not valid json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let store: ReturnType<typeof loadConsumedStore> | undefined;
    expect(() => { store = loadConsumedStore(path); }).not.toThrow();
    expect(store!.all()).toEqual({});
    expect(store!.has('anything')).toBe(false);
    expect(store!.corrupt).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('record() flushes atomically: no .tmp artifact left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-consumed-'));
    const path = join(dir, 'uline-consumed.json');
    const store = loadConsumedStore(path);
    store.record('12345', 'txn-abc', 'FL');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // Multiple writes in a row never leave a stray .tmp either.
    store.record('67890', 'txn-def', 'TN');
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const reloaded = loadConsumedStore(path);
    expect(reloaded.corrupt).toBe(false);
    expect(Object.keys(reloaded.all()).sort()).toEqual(['12345', '67890']);
  });

  it('does not double-count: recording the same invoice twice overwrites, not appends duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-consumed-'));
    const path = join(dir, 'uline-consumed.json');
    const store = loadConsumedStore(path);
    store.record('12345', 'txn-1', 'FL');
    store.record('12345', 'txn-2', 'TN');
    expect(Object.keys(store.all())).toEqual(['12345']);
    expect(store.all()['12345']).toMatchObject({ txnId: 'txn-2', entity: 'TN' });
  });
});
