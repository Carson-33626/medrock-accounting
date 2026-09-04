import { describe, it, expect } from 'vitest';
import { residualWarning } from './close-server';

/**
 * The residual warning is the only instruction an accountant gets about a line
 * posted to the parent accounts, so what it tells them to DO has to be possible.
 * The original text said "assign drug codes to clear" for whatever landed there —
 * correct for `Uncoded`, impossible for `Opening Balance`.
 */
describe('residualWarning', () => {
  it('tells the accountant to code Uncoded, because that works', () => {
    const w = residualWarning('MedRock Tennessee', ['Uncoded']);
    expect(w).toContain('MedRock Tennessee');
    expect(w).toContain('assigning drug codes');
  });

  it('does NOT tell them to code Opening Balance, because it cannot be coded', () => {
    // OB rows are pre-history pseudo-receipts with no purchase_lots row at all —
    // there is no product to attach a code to. Measured 2026-03: Florida's entire
    // residual was Opening Balance while Uncoded sat at $0.00.
    const w = residualWarning('MedRock Florida', ['Opening Balance']);
    expect(w).toContain('cannot be coded');
    expect(w).not.toContain('assigning drug codes');
  });

  it('gives each bucket its own advice when both are present', () => {
    const w = residualWarning('MedRock Florida', ['Opening Balance', 'Uncoded']);
    expect(w).toContain('assigning drug codes');
    expect(w).toContain('cannot be coded');
  });

  it('agrees with itself on singular and plural', () => {
    expect(residualWarning('MedRock FL', ['Uncoded'])).toContain('has no QuickBooks category');
    expect(residualWarning('MedRock FL', ['Uncoded', 'Opening Balance'])).toContain(
      'have no QuickBooks category',
    );
  });

  it('still reads as a sentence when no category name came through', () => {
    const w = residualWarning('MedRock Texas', []);
    expect(w).toContain('one or more categories');
    expect(w).toContain('residual line');
  });
});
