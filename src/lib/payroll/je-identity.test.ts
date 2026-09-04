import { describe, it, expect } from 'vitest';
import { deriveJeIdentity, type JeIdentityHeader } from './je-identity';
import { labAccrualIdentity, LAB_ACCRUAL_PAY_GROUP } from '@/lib/inventory/lab-supplies-je';
import {
  shippingAccrualIdentity,
  SHIPPING_ACCRUAL_PAY_GROUP,
} from '@/lib/inventory/shipping-packaging-je';
import {
  invCloseDocNumber,
  openingCorrectionDocNumber,
  INV_OPEN_PAY_GROUP,
  OPENING_CORRECTION_NOTE,
} from '@/lib/inventory/monthly-close';

function header(overrides: Partial<JeIdentityHeader>): JeIdentityHeader {
  return {
    entity: 'MedRock TN',
    kind: 'pay_date',
    pay_date: '08/31/2026',
    pay_group: 'BIWEEKLY',
    period_segment: '',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    txn_date: '2026-08-31',
    qb_doc_number: null,
    ...overrides,
  };
}

/**
 * These four cases are the contract between the Post button and the two artefacts that must
 * agree with it: the source workbook an accountant downloads, and the CSV Barbara imports by
 * hand through QuickBooks' own wizard. A header whose identity is derived differently here
 * than in its post route produces a file naming an entry that will never exist.
 */
describe('deriveJeIdentity', () => {
  it('names the lab-supplies accrual by its period, not its pay date', () => {
    const id = deriveJeIdentity(
      header({ kind: 'accrual', pay_group: LAB_ACCRUAL_PAY_GROUP, period_end: '2026-08-31' }),
      0,
      1,
    );
    expect(id).toEqual(labAccrualIdentity('2026-08', 'accrual'));
    expect(id.docNumber).toBe('LS Accru 2026.08');
  });

  it('keeps the reversal on the accrued month even though it posts in the next one', () => {
    const id = deriveJeIdentity(
      header({
        kind: 'reversal',
        pay_group: LAB_ACCRUAL_PAY_GROUP,
        pay_date: '09/01/2026',
        period_end: '2026-08-31',
        txn_date: '2026-09-01',
      }),
      0,
      1,
    );
    // The tag is the ACCRUED month; only the posting date moves to the 1st.
    expect(id.docNumber).toBe('LS Accru 2026.08R');
    expect(id.txnDateIso).toBe('2026-09-01');
    expect(id.privateNote).toBe('Reverse of JE LS Accru 2026.08');
  });

  it('tells the one-time opening correction apart from a monthly close', () => {
    const inv = header({ kind: 'inventory', pay_group: 'INV CLOSE', txn_date: '2026-03-31' });
    const open = header({ kind: 'inventory', pay_group: INV_OPEN_PAY_GROUP, pay_date: '03/01/2026', txn_date: '2026-03-01' });

    expect(deriveJeIdentity(inv, 0, 1).docNumber).toBe(invCloseDocNumber('MedRock TN', '2026-03'));
    expect(deriveJeIdentity(open, 0, 1).docNumber).toBe(openingCorrectionDocNumber('MedRock TN', '2026-03'));
    expect(deriveJeIdentity(open, 0, 1).docNumber).not.toBe(deriveJeIdentity(inv, 0, 1).docNumber);
    expect(deriveJeIdentity(open, 0, 1).privateNote).toBe(OPENING_CORRECTION_NOTE);
  });

  it('still derives an ordinary payroll run, and a pinned DocNumber always wins', () => {
    expect(deriveJeIdentity(header({}), 0, 1).docNumber).toBe('PR 2026.08.31');
    expect(
      deriveJeIdentity(
        header({ kind: 'accrual', pay_group: LAB_ACCRUAL_PAY_GROUP, qb_doc_number: 'LS Accru 2026.08-2' }),
        0,
        1,
      ).docNumber,
    ).toBe('LS Accru 2026.08-2');
  });

  // The lab accrual was named `PR 2026.08.31` for exactly as long as it had no branch here.
  // The shipping pair is a clone of it and would have inherited the same defect, so it gets
  // the same coverage BEFORE it is wired into the pool rather than after someone notices.
  it('names the shipping accrual by its period too', () => {
    const id = deriveJeIdentity(
      header({ kind: 'accrual', pay_group: SHIPPING_ACCRUAL_PAY_GROUP, period_end: '2026-08-31' }),
      0,
      1,
    );
    expect(id).toEqual(shippingAccrualIdentity('2026-08', 'accrual'));
    expect(id.docNumber).toBe('SP Accru 2026.08');
  });

  it('keeps the shipping reversal on the accrued month', () => {
    const id = deriveJeIdentity(
      header({
        kind: 'reversal',
        pay_group: SHIPPING_ACCRUAL_PAY_GROUP,
        period_end: '2026-08-31',
        txn_date: '2026-09-01',
      }),
      0,
      1,
    );
    expect(id.docNumber).toBe('SP Accru 2026.08R');
    expect(id.txnDateIso).toBe('2026-09-01');
  });

  it('never gives two different accrual pairs the same DocNumber', () => {
    const lab = deriveJeIdentity(
      header({ kind: 'accrual', pay_group: LAB_ACCRUAL_PAY_GROUP, period_end: '2026-08-31' }),
      0,
      1,
    );
    const ship = deriveJeIdentity(
      header({ kind: 'accrual', pay_group: SHIPPING_ACCRUAL_PAY_GROUP, period_end: '2026-08-31' }),
      0,
      1,
    );
    expect(lab.docNumber).not.toBe(ship.docNumber);
  });

  it('does NOT name an unknown accrual pair after payroll — it falls through, and that is the trap', () => {
    // Documenting the failure mode rather than pretending it cannot happen: a pair with no
    // branch above lands in the pay_date arm and is named `PR <date>`. If this test ever
    // starts failing because someone added a default, good — but they must then decide what
    // an unrecognised pair should be called, which is the point.
    const id = deriveJeIdentity(
      header({ kind: 'accrual', pay_group: 'SOME FUTURE ACCRUAL', period_end: '2026-08-31' }),
      0,
      1,
    );
    expect(id.docNumber).toBe('PR 2026.08.31');
  });
});
