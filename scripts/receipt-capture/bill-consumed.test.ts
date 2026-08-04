import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsumedBillStore } from './bill-consumed';

describe('loadConsumedBillStore', () => {
  it('missing file -> empty store, not flagged corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bills-'));
    const store = loadConsumedBillStore(join(dir, 'bills.json'));
    expect(store.has('C335-1')).toBe(false);
    expect(store.corrupt).toBe(false);
  });

  it('records and persists for the next load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bills-'));
    const path = join(dir, 'bills.json');
    loadConsumedBillStore(path).record('C335-1', 'draft-9', 'FL');
    const reloaded = loadConsumedBillStore(path);
    expect(reloaded.has('C335-1')).toBe(true);
    expect(reloaded.all()['C335-1'].draftId).toBe('draft-9');
    expect(reloaded.all()['C335-1'].entity).toBe('FL');
  });

  it('matches case-insensitively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bills-'));
    const path = join(dir, 'bills.json');
    loadConsumedBillStore(path).record('C335-1', 'draft-9', 'FL');
    expect(loadConsumedBillStore(path).has('c335-1')).toBe(true);
  });

  it('flags a corrupt file instead of silently starting empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bills-'));
    const path = join(dir, 'bills.json');
    writeFileSync(path, '{not json');
    expect(loadConsumedBillStore(path).corrupt).toBe(true);
  });
});
