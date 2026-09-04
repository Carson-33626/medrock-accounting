/**
 * The source-detail sheets for ONE stored journal-entry header, whatever kind it is.
 *
 * One entry point for both surfaces that need them — the browser download
 * (`/api/payroll/export`) and the QuickBooks attachment written right after a live post — so
 * the accountant who opens the file and the auditor who opens the attachment are looking at
 * the same sheets. Per DS §3.2 that shared builder is what makes the attachment cheap.
 *
 * BEST-EFFORT BY DESIGN, and it never throws. An unreachable ledger, a decrypt key that is
 * not configured, an EOM pool snapshot that no longer reproduces the entry, a pre-`sourceRowKeys`
 * draft — each degrades to no extra sheets. A workbook with only its `Journal Entry` sheet is a
 * smaller problem than a failed download, and a much smaller one than a detail sheet that does
 * not foot (DS §7 acceptance 2).
 */
import type { DetailSheet } from '@/lib/inventory/je-detail';
import { buildInventoryJeDetailSheets } from '@/lib/inventory/je-detail';
import { buildLabAccrualJeDetailSheets, parseLabAccrualSnapshot } from '@/lib/inventory/je-detail-accrual';
import { LAB_ACCRUAL_PAY_GROUP } from '@/lib/inventory/lab-supplies-je';
import { fetchJeLotDetail } from '@/lib/inventory/ledger-values';
import { getRdsPool } from '@/lib/rds';
import { buildPayrollJeDetailSheets } from './je-detail-payroll';
import { buildAllocationJeDetailSheets } from './je-detail-allocation';
import { allocationBasis } from './month-end';
import { buildJournal } from './build-je';
import { selectSource } from './source-select';
import { getAccountMap, getEmployeeMap, getSourceSnapshot, type PayrollHeader, type JsonValue } from './store';
import { getEomRun } from './eom-store';
import { adpDateToIso } from './dates';
import { shortMonthName, type Month } from './month';
import { EOM_ENTITIES, type EomEntity } from './revenue-rule';
import type { PoolLine, PoolRule } from './qb-pool';
import type { Entity, JournalLine } from './types';

const POOL_RULES: readonly PoolRule[] = ['revenue', 'thirds', 'fifty', 'passthrough', 'unknown'];
const ENTITIES: readonly Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];

export async function fetchJeDetailSheets(
  header: PayrollHeader,
  lines: readonly JournalLine[],
  label: string,
): Promise<DetailSheet[]> {
  try {
    if (header.kind === 'inventory') return await inventorySheets(header, lines);
    if (header.kind === 'allocation') return await allocationSheets(header, lines, label);
    if (header.kind === 'pay_date') return await payrollSheets(header, lines, label);
    if (header.kind === 'accrual' || header.kind === 'reversal') {
      return await accrualSheets(header, lines, label, header.kind);
    }
    return [];
  } catch (error) {
    console.warn(
      `[je-detail-fetch] ${header.kind} detail sheets skipped for header ${header.id}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Keyed off the receipt ids the draft itself stored on each line, so the file is a view of
 * THIS entry rather than a fresh reading of a ledger that could have moved since.
 */
async function inventorySheets(header: PayrollHeader, lines: readonly JournalLine[]): Promise<DetailSheet[]> {
  const monthEnd = header.period_end ?? header.txn_date;
  if (monthEnd === null) return [];
  const receiptIds = [...new Set(lines.flatMap((l) => l.sourceRowKeys))];
  if (receiptIds.length === 0) return [];

  const lots = await fetchJeLotDetail(getRdsPool(), receiptIds, monthEnd.slice(0, 7));
  if (lots.length === 0) return [];
  return buildInventoryJeDetailSheets(lines, lots, monthEnd);
}

/**
 * The lab-supplies accrual pair. Reads the estimate RETAINED at generate time
 * (`saveSourceSnapshot`) rather than re-pulling QuickBooks: completeness is a function of the
 * day the observation was taken, so a re-pull returns a different accrual than the one that
 * posted and would never foot. See `je-detail-accrual.ts`.
 *
 * Only the lab accrual claims these kinds today. A future accrual on another pay_group gets no
 * sheet rather than the wrong one.
 */
async function accrualSheets(
  header: PayrollHeader,
  lines: readonly JournalLine[],
  label: string,
  kind: 'accrual' | 'reversal',
): Promise<DetailSheet[]> {
  if (header.pay_group !== LAB_ACCRUAL_PAY_GROUP) return [];
  const snapshot = parseLabAccrualSnapshot(await getSourceSnapshot(header.id));
  if (snapshot === null) return [];
  return buildLabAccrualJeDetailSheets({ storedLines: lines, snapshot, kind, label });
}

/**
 * The pool snapshot the drafts were generated from is retained on `payroll_eom_runs`, so this
 * reads the actual source rather than re-pulling QuickBooks — which would answer a different
 * question a month later.
 */
async function allocationSheets(
  header: PayrollHeader, lines: readonly JournalLine[], label: string,
): Promise<DetailSheet[]> {
  const iso = header.txn_date ?? adpDateToIso(header.pay_date);
  const month = iso.slice(0, 7);
  const run = await getEomRun(month);
  if (!run) return [];

  const pool = parsePoolLines(run.pool);
  const shares = readShares(run.revenue);
  if (pool === null || shares === null) return [];

  const m: Month = { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
  return buildAllocationJeDetailSheets({
    entity: header.entity,
    storedLines: lines,
    basis: allocationBasis(pool, shares, m),
    shares,
    label,
  });
}

/**
 * Rebuilds the run from its ADP rows to recover the per-column composition of each line —
 * the mapping, not the dollars, is what has to be re-derived, and the stored entry is the
 * authority the rebuild is checked against (see `buildPayrollJeDetailSheets`).
 *
 * Refuses to run without a decrypt key: `selectSource` silently falls back to fixtures, and a
 * fixture-derived detail sheet attached to a real entry would be fiction.
 */
async function payrollSheets(
  header: PayrollHeader, lines: readonly JournalLine[], label: string,
): Promise<DetailSheet[]> {
  if (!process.env.PAYROLL_ENC_KEY) return [];

  const dayIso = adpDateToIso(header.pay_date);
  const dayRows = await selectSource().fetchRange(dayIso, dayIso);
  const runRows = dayRows.filter((r) => r.pay_group === header.pay_group);
  if (runRows.length === 0) return [];

  const [accountMap, employeeMap] = await Promise.all([
    getAccountMap(header.entity),
    getEmployeeMap(header.entity),
  ]);
  const built = buildJournal(runRows, accountMap, employeeMap);
  const i = built.drafts.findIndex((d) => d.entity === header.entity);
  if (i < 0) return [];

  return buildPayrollJeDetailSheets({
    storedLines: lines,
    rebuiltLines: built.drafts[i].lines,
    rebuiltSources: built.draftSources[i],
    memoSuffix: pieceMemoSuffix(header),
    label,
  });
}

/**
 * The suffix `splitStraddle` appended to this piece's line memos, or '' when the run is
 * unsplit or this piece IS the pay-date month. Derived the same way the splitter derives it,
 * because the rebuild is of the whole run and its memos carry no suffix at all.
 */
function pieceMemoSuffix(header: PayrollHeader): string {
  const segment = header.period_segment;
  if (!/^\d{4}-\d{2}$/.test(segment)) return '';
  const payIso = adpDateToIso(header.pay_date);
  if (segment === payIso.slice(0, 7)) return '';
  return ` - ${shortMonthName({ year: Number(segment.slice(0, 4)), month: Number(segment.slice(5, 7)) })} portion`;
}

/** Narrow the stored `payroll_eom_runs.pool` jsonb back to PoolLine[] — no any/unknown. */
function parsePoolLines(value: JsonValue): PoolLine[] | null {
  if (!Array.isArray(value)) return null;
  const out: PoolLine[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const entity = item.entity;
    const rule = item.rule;
    const amount = item.amount;
    const accountName = item.accountName;
    if (typeof entity !== 'string' || !ENTITIES.includes(entity as Entity)) return null;
    if (typeof rule !== 'string' || !POOL_RULES.includes(rule as PoolRule)) return null;
    if (typeof amount !== 'number' || typeof accountName !== 'string') return null;
    const cp = item.counterparty;
    const counterparty = typeof cp === 'string' && ENTITIES.includes(cp as Entity) ? (cp as Entity) : null;
    out.push({
      entity: entity as Entity,
      txnType: str(item.txnType),
      txnId: str(item.txnId),
      txnDate: str(item.txnDate),
      docNumber: typeof item.docNumber === 'string' ? item.docNumber : null,
      accountName,
      className: typeof item.className === 'string' ? item.className : null,
      departmentName: typeof item.departmentName === 'string' ? item.departmentName : null,
      memo: typeof item.memo === 'string' ? item.memo : null,
      amount,
      rule: rule as PoolRule,
      counterparty,
      ownedPayroll: item.ownedPayroll === true,
    });
  }
  return out;
}

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');

/** `revenue.shares` out of the stored run, or null on any shape mismatch. */
function readShares(revenue: JsonValue): Record<EomEntity, number> | null {
  if (typeof revenue !== 'object' || revenue === null || Array.isArray(revenue)) return null;
  const shares = revenue.shares;
  if (typeof shares !== 'object' || shares === null || Array.isArray(shares)) return null;
  const out = {} as Record<EomEntity, number>;
  for (const e of EOM_ENTITIES) {
    const v = shares[e];
    if (typeof v !== 'number') return null;
    out[e] = v;
  }
  return out;
}
