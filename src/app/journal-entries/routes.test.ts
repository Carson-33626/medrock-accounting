import { describe, it, expect } from 'vitest';
import { journalEntryHrefForTab, JOURNAL_ENTRY_ROUTES } from './routes';

describe('journalEntryHrefForTab', () => {
  it('maps every old ?tab= key to its page', () => {
    for (const r of JOURNAL_ENTRY_ROUTES) expect(journalEntryHrefForTab(r.key)).toBe(r.href);
  });
  it('falls back to Payrolls for a missing or unknown tab', () => {
    expect(journalEntryHrefForTab(null)).toBe('/journal-entries/payroll');
    expect(journalEntryHrefForTab(undefined)).toBe('/journal-entries/payroll');
    expect(journalEntryHrefForTab('nonsense')).toBe('/journal-entries/payroll');
  });
});
