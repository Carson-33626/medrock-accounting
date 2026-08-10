import { describe, it, expect } from 'vitest';
import { parseTxnReport, loadTxnReportCharges, type TxnReportDeps } from './txn-report';
import { txnReportPath } from '../../paths';

const HEADER = 'Transaction Date,Payment Reference ID,Transaction Type,Currency,Payment Amount,Account Group,Payment Instrument Type,Payment Identifier,Account User,Order Date,Order ID,PO Number,Order Status,Approver,GL Code,Department,Cost Center,Project Code,Location,Custom Field 1';
function row(over: Partial<Record<string, string>> = {}): string {
  const f: Record<string, string> = {
    date: '07/29/2026', ref: 'REF1', type: 'Charge', amount: '"155.11"', group: 'MedRock Florida',
    last4: '="9985"', orderId: '113-3659874-3461066', ...over,
  };
  return `${f.date},${f.ref},${f.type},USD,${f.amount},${f.group},Visa,${f.last4},MedRock Florida,07/28/2026,${f.orderId},,Closed,,Suspense,,,,,`;
}
const report = (...rows: string[]): string => [HEADER, ...rows].join('\n') + '\n';

function deps(files: Record<string, string>): TxnReportDeps {
  return {
    exists: (p) => p in files,
    read: (p) => {
      const t = files[p];
      if (t === undefined) throw new Error(`unexpected read ${p}`);
      return t;
    },
  };
}

describe('parseTxnReport', () => {
  it('groups one charge per Payment Reference ID with unwrapped fields', () => {
    const [c] = parseTxnReport(report(row({})));
    expect(c.paymentRef).toBe('REF1');
    expect(c.chargeCents).toBe(15511);
    expect(c.payDate).toBe('2026-07-29');
    expect(c.cardLast4).toBe('9985');
    expect(c.primaryOrderId).toBe('113-3659874-3461066');
    expect(c.orderIds).toEqual(['113-3659874-3461066']);
  });

  it('collects every order id contributing rows to one charge, without duplicates', () => {
    const charges = parseTxnReport(report(
      row({ ref: 'REF1', orderId: 'O-1' }),
      row({ ref: 'REF1', orderId: 'O-2' }),
      row({ ref: 'REF1', orderId: 'O-1' }),
    ));
    expect(charges).toHaveLength(1);
    expect(charges[0].orderIds).toEqual(['O-1', 'O-2']);
    expect(charges[0].primaryOrderId).toBe('O-1');
  });

  it('keeps two charges that share one order id separate (split shipments bill separately)', () => {
    const charges = parseTxnReport(report(
      row({ ref: 'REF1', orderId: 'O-1', amount: '"10.00"' }),
      row({ ref: 'REF2', orderId: 'O-1', amount: '"25.00"' }),
    ));
    expect(charges.map((c) => c.paymentRef)).toEqual(['REF1', 'REF2']);
    expect(charges.every((c) => c.primaryOrderId === 'O-1')).toBe(true);
    expect(charges.map((c) => c.chargeCents)).toEqual([1000, 2500]);
  });

  it('ignores non-Charge rows (refunds/adjustments) and rows with no payment ref', () => {
    const charges = parseTxnReport(report(
      row({ type: 'Refund' }),
      row({ ref: '', orderId: 'O-9' }),
      row({ ref: 'REF2' }),
    ));
    expect(charges.map((c) => c.paymentRef)).toEqual(['REF2']);
  });

  it('treats an N/A payment identifier as no last-4 rather than the literal string', () => {
    const [c] = parseTxnReport(report(row({ last4: 'N/A' })));
    expect(c.cardLast4).toBeNull();
  });
});

describe('loadTxnReportCharges', () => {
  it('pools accounts and records which account each order id is visible under', () => {
    const r = loadTxnReportCharges(['FL', 'TN'], deps({
      [txnReportPath('FL')]: report(row({ ref: 'F1', orderId: 'O-FL' })),
      [txnReportPath('TN')]: report(row({ ref: 'T1', orderId: 'O-TN' })),
    }));
    expect(r.charges.map((c) => c.paymentRef)).toEqual(['F1', 'T1']);
    expect(r.accountOfOrder.get('O-FL')).toBe('FL');
    expect(r.accountOfOrder.get('O-TN')).toBe('TN');
    expect(r.missing).toEqual([]);
  });

  it('de-dupes a payment ref appearing in two exports, first account wins', () => {
    const r = loadTxnReportCharges(['FL', 'TN'], deps({
      [txnReportPath('FL')]: report(row({ ref: 'DUP', amount: '"1.00"' })),
      [txnReportPath('TN')]: report(row({ ref: 'DUP', amount: '"2.00"' })),
    }));
    expect(r.charges).toHaveLength(1);
    expect(r.charges[0].chargeCents).toBe(100);
  });

  it('reports a missing report as missing instead of throwing, and still pools the rest', () => {
    const r = loadTxnReportCharges(['FL', 'TX'], deps({
      [txnReportPath('FL')]: report(row({ ref: 'F1' })),
    }));
    expect(r.charges).toHaveLength(1);
    expect(r.missing).toEqual([{ account: 'TX', path: txnReportPath('TX') }]);
  });
});
