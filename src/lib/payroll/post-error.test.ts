import { describe, it, expect } from 'vitest';
import { explainPostError } from './post-error';

/**
 * These cover the messages accounting has actually been shown. The bar for each is not "did we
 * pretty it up" but "does it say what went wrong AND what to do" — Barbara's 2026-08-06 note was
 * that the errors were unreadable and she had no way to clear them herself.
 */
describe('explainPostError', () => {
  it('explains an unresolved account as a missing QuickBooks account, naming the entity', () => {
    const e = explainPostError('unresolved account: COGS - Payroll Expense:COGS - Lab Wages', 'MedRock TN');
    expect(e.summary).toContain('MedRock TN');
    expect(e.summary).toContain('COGS - Payroll Expense:COGS - Lab Wages');
    expect(e.action).toMatch(/create|mapping/i);
    expect(e.canSelfClear).toBe(true);
  });

  it('explains an unresolved department', () => {
    const e = explainPostError('unresolved department: Tampa Region', 'MedRock FL');
    expect(e.summary).toContain('department');
    expect(e.summary).toContain('Tampa Region');
    expect(e.canSelfClear).toBe(true);
  });

  it('offers a rebuild — never a retry — when the source drifted under the draft', () => {
    // post-guard I3's exact wording. Retrying this posts the stale draft, so `retryable` must
    // stay false or the panel would show a "Try again" button that books the wrong numbers.
    const e = explainPostError('source changed since draft was built — rebuild the run', 'MedRock TX');
    expect(e.canRebuild).toBe(true);
    expect(e.retryable).toBe(false);
    expect(e.canSelfClear).toBe(true);
    expect(e.summary).toMatch(/changed/i);
    expect(e.action).toMatch(/rebuild/i);
    // The reset of Reconcile/Approve is the surprising part — it has to be stated up front.
    expect(e.action).toMatch(/reconcile/i);
    expect(e.action).toMatch(/approve/i);
  });

  it('leaves canRebuild false for failures a rebuild would not fix', () => {
    expect(explainPostError('unresolved department: Tampa Region', 'MedRock FL').canRebuild).toBe(false);
    expect(explainPostError('could not reach QuickBooks', 'MedRock FL').canRebuild).toBe(false);
  });

  it('parses a raw QuickBooks fault blob rather than showing it', () => {
    const raw =
      'QB API error for MedRock FL: 400 {"Fault":{"Error":[{"Message":"A business validation error has occurred",' +
      '"Detail":"Business Validation Error: You must specify a different account","code":"6000"}],"type":"ValidationFault"}}';
    const e = explainPostError(raw, 'MedRock FL');
    expect(e.summary).toContain('You must specify a different account');
    expect(e.summary).not.toContain('{');
    expect(e.raw).toBe(raw);
  });

  it('recognises a closed accounting period, which is a date problem not a mapping problem', () => {
    const raw =
      'QB API error for MedRock FL: 400 {"Fault":{"Error":[{"Message":"A business validation error has occurred",' +
      '"Detail":"Business Validation Error: The transaction date is prior to the closing date","code":"6000"}]}}';
    const e = explainPostError(raw, 'MedRock FL');
    expect(e.summary).toMatch(/closed period/i);
    expect(e.action).toMatch(/closing date|posting date/i);
    expect(e.canSelfClear).toBe(true);
  });

  it('offers a Doc No rename for a duplicate rather than suggesting a retry', () => {
    const raw =
      'QB API error for MedRock TX: 400 {"Fault":{"Error":[{"Message":"Duplicate Name Exists Error",' +
      '"Detail":"The name supplied already exists","code":"6240"}]}}';
    const e = explainPostError(raw, 'MedRock TX');
    expect(e.action).toMatch(/rename/i);
    expect(e.canRenameDocNumber).toBe(true);
    // Retrying a duplicate is exactly the wrong move — it posts the same DocNumber and fails
    // identically. The action is to rename THIS entry, never to touch the one already there.
    expect(e.retryable).toBe(false);
    expect(e.action).not.toMatch(/mark this run posted/i);
  });

  it('does not offer a Doc No rename for any other failure', () => {
    expect(explainPostError('unresolved account: Bonus Wages', 'MedRock FL').canRenameDocNumber).toBe(false);
    expect(explainPostError('source changed since draft was built').canRenameDocNumber).toBe(false);
    expect(explainPostError('Could not reach QuickBooks').canRenameDocNumber).toBe(false);
    expect(explainPostError('something nobody has seen before').canRenameDocNumber).toBe(false);
  });

  it('treats a network failure as transient and explicitly NOT a reconnection', () => {
    const e = explainPostError('Could not reach QuickBooks to refresh the MedRock FL token — network problem');
    expect(e.retryable).toBe(true);
    expect(e.action).toMatch(/no reconnection|wait/i);
  });

  it('never returns an empty action, even for an unrecognised error', () => {
    const e = explainPostError('something nobody has seen before');
    expect(e.summary).toBe('something nobody has seen before');
    expect(e.action.length).toBeGreaterThan(0);
    expect(e.canSelfClear).toBe(false);
  });
});
