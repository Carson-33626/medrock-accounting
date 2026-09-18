/**
 * The shipping-packaging basis behind the monthly close entry, as an extra sheet of the
 * entry's own workbook.
 *
 * Reads the basis RETAINED at generate time, never a re-pull: 5000.20 moves whenever a bill
 * is keyed, so a later read would describe a different entry than the one that posted. Same
 * footing contract as the lab sheet: the stored shipping lines must reproduce the retained
 * relief to the cent, or nothing is emitted.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { DetailSheet } from './je-detail';
import type { JsonValue } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';
import type { ShippingReliefSnapshot } from './shipping-relief';

/** Its own audit outcome, so it never overwrites the lab basis on the same header. */
export const SHIPPING_SNAPSHOT_OUTCOME = 'snapshot:shipping-packaging';

const COLUMNS: ExportColumn[] = [
  { header: 'Step', key: 'step' },
  { header: 'Basis', key: 'basis' },
  { header: 'Amount', key: 'amount', currency: true },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
];

const num = (v: JsonValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);

/** Narrow a stored jsonb snapshot back to `ShippingReliefSnapshot`, or null on ANY mismatch. */
export function parseShippingReliefSnapshot(value: JsonValue | null): ShippingReliefSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (value.kind !== 'shipping-relief') return null;
  const location = str(value.location);
  const month = str(value.month);
  const asOf = str(value.asOf);
  const ratioBasis = str(value.ratioBasis);
  const postage = num(value.postage);
  const ratioPackaging = num(value.ratioPackaging);
  const ratioPostage = num(value.ratioPostage);
  const target = num(value.target);
  const packagingCarried = num(value.packagingCarried);
  const rawRelief = num(value.rawRelief);
  const relief = num(value.relief);
  if (location === null || month === null || asOf === null || ratioBasis === null) return null;
  if (
    postage === null || ratioPackaging === null || ratioPostage === null || target === null ||
    packagingCarried === null || rawRelief === null || relief === null
  ) {
    return null;
  }
  if (!Array.isArray(value.manualDocNumbers)) return null;
  const manualDocNumbers: string[] = [];
  for (const d of value.manualDocNumbers) {
    if (typeof d !== 'string') return null;
    manualDocNumbers.push(d);
  }
  return {
    kind: 'shipping-relief', location, month, asOf, postage, ratioPackaging, ratioPostage, ratioBasis,
    target, packagingCarried, rawRelief, relief, manualDocNumbers,
  };
}

const cents = (n: number): number => Math.round(n * 100);

/**
 * @param shipLines the entry's shipping lines ONLY (tagged `src:shipping-packaging`).
 * @returns the single `Shipping packaging basis` sheet, or `[]` when the lines do not
 *   reproduce the snapshot's relief.
 */
export function buildShippingReliefDetailSheet(
  shipLines: readonly JournalLine[],
  snapshot: ShippingReliefSnapshot,
): DetailSheet[] {
  const reliefCents = cents(snapshot.relief);
  if (reliefCents === 0) {
    if (shipLines.length !== 0) return [];
  } else {
    if (shipLines.length !== 2) return [];
    const debits = shipLines.filter((l) => l.postingType === 'Debit');
    const credits = shipLines.filter((l) => l.postingType === 'Credit');
    if (debits.length !== 1 || credits.length !== 1) return [];
    if (cents(debits[0].amount) !== reliefCents || cents(credits[0].amount) !== reliefCents) return [];
  }

  const pct = ((snapshot.ratioPackaging / snapshot.ratioPostage) * 100).toFixed(4);
  const row = (step: string, basis: string, amount: number | null): Record<string, CellValue> => ({
    step, basis, amount, debit: null, credit: null,
  });
  const rows: Record<string, CellValue>[] = [
    row('Postage', `5000.40 Postage/Shipping Cost, accrual P&L ${snapshot.month}, read from QuickBooks ${snapshot.asOf}`, snapshot.postage),
    row('Ratio', `${pct}% = 5000.20 ${snapshot.ratioPackaging.toFixed(2)} ÷ 5000.40 ${snapshot.ratioPostage.toFixed(2)} (${snapshot.ratioBasis})`, null),
    row('Target usage', 'Postage × ratio', snapshot.target),
    row('Already in 5000.20', 'Packaging expensed direct to 5000.20 this month (bills, cards, allocations, manual entries)', snapshot.packagingCarried),
    row('Target − already carried', 'Before the floor at zero', snapshot.rawRelief),
  ];
  if (snapshot.manualDocNumbers.length > 0) {
    rows.push(row('Relieved by hand', `${snapshot.manualDocNumbers.join(', ')} already relieved this month — nothing booked`, null));
  }
  rows.push(row('This entry books', 'Dr 5000.20 Final Packaging Materials / Cr 1220.30 Shipping Packaging Material Inventory', snapshot.relief));
  for (const line of shipLines) {
    rows.push({
      step: line.postingType === 'Debit' ? 'Dr' : 'Cr',
      basis: line.accountName,
      amount: null,
      debit: line.postingType === 'Debit' ? line.amount : null,
      credit: line.postingType === 'Credit' ? line.amount : null,
    });
  }
  const total = reliefCents / 100;
  rows.push({ step: 'TOTAL', basis: '', amount: null, debit: total, credit: total });

  return [
    {
      name: 'Shipping packaging basis',
      columns: COLUMNS,
      rows,
      note:
        'Shipping packaging never enters LifeFile, so FIFO cannot see it. Usage is estimated as a ' +
        'fixed share of postage (Barbara’s method, set from Sep 2025–Feb 2026 actuals) and relieved from ' +
        '1220.30 to 5000.20, net of anything already expensed direct to 5000.20 this month.',
    },
  ];
}
