import type { PayrollRow, AccountMapRule, EmployeeMapRule, JournalDraft, JournalLine, Entity, UnmappedColumnDetail } from './types';
import { resolveLine } from './mapping';
import { entityForPayGroup } from './entity';
import { compareJournalLines } from './line-order';

const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());

/**
 * ADP report aggregate / reference columns that are never posted to the general ledger:
 * hours, subtotals ("… - TOTAL"), grand totals ("TOTAL …"), and the GROSS PAY / RATE AMOUNT
 * reference figures. They carry no account-map rule by design — mapping them would
 * double-count the real earning/tax/deduction columns they summarize. Suppressing them keeps
 * the "new columns detected" worklist to genuinely unmapped columns AND lets a run be postable
 * (reconcile requires zero unmapped columns). Applied only to columns that DON'T resolve to a
 * rule, so an explicit account-map rule always still wins.
 */
const isReportAggregateColumn = (col: string): boolean =>
  /\bHOURS\b|-\s*TOTAL\s*$|^TOTAL\b|^GROSS PAY$|^RATE AMOUNT$/.test(col.trim());

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Bucket { postingType: 'Debit' | 'Credit'; amount: number; accountName: string; departmentName: string | null; className: string | null; memo: string | null; creditBucket: JournalLine['creditBucket']; rowKeys: Set<string>; }

export interface ExcludedGroup { payGroup: string; reason: string; count: number; }

/** Human-readable reason a row's pay_group is non-postable, given the raw (untrimmed) value. */
export function exclusionReason(payGroup: string): string {
  const g = payGroup.trim().toUpperCase();
  if (g === 'FOCS') return 'FOCS (FOCAS Institute) — no QuickBooks company connected';
  if (g === '1099') return '1099 contractor — separate handling, not a W-2 payroll JE';
  if (g === '') return 'blank pay group';
  return `unknown pay group: ${payGroup}`;
}

/**
 * Merge a freshly-rebuilt generated line set into an existing draft's lines when a mapping
 * changes (rebuild-on-map). Every `generated` line is replaced by the rebuild — so a column
 * that was just mapped now flows its dollars into the JE and the balance reflects it — while
 * lines the accountant authored by hand (`manual`) or inter-entity companions (`inter_entity`)
 * are preserved untouched. Rebuilt generated lines come first, hand-authored lines after.
 */
export function mergeRebuiltLines(existing: JournalLine[], rebuiltGenerated: JournalLine[]): JournalLine[] {
  const preserved = existing.filter((l) => l.origin !== 'generated');
  return [...rebuiltGenerated, ...preserved];
}

export function buildJournal(
  rows: PayrollRow[], accountMap: AccountMapRule[], employeeMap: EmployeeMapRule[],
): { drafts: JournalDraft[]; unmappedColumns: string[]; unmappedColumnDetails: UnmappedColumnDetail[]; unmappedPositions: string[]; excluded: ExcludedGroup[] } {
  const unmappedColumns = new Set<string>();
  // Per unmapped column: running dollar total + the distinct people (rowKey -> name) who carried
  // it, so the "new columns detected" panel can show the amount and let an accountant jump to the
  // source. Accumulated in lockstep with `unmappedColumns` below.
  const unmappedDetails = new Map<string, { amount: number; sources: Map<string, string> }>();
  const unmappedPositions = new Set<string>();
  const excluded = new Map<string, ExcludedGroup>();
  const groups = new Map<string, { entity: Entity; row0: PayrollRow; buckets: Map<string, Bucket> }>();

  const acctCache = new Map<Entity, AccountMapRule[]>();
  const empCache = new Map<Entity, EmployeeMapRule[]>();
  const acctFor = (e: Entity): AccountMapRule[] => {
    let v = acctCache.get(e);
    if (!v) { v = accountMap.filter((a) => a.entity === e); acctCache.set(e, v); }
    return v;
  };
  const empFor = (e: Entity): EmployeeMapRule[] => {
    let v = empCache.get(e);
    if (!v) { v = employeeMap.filter((x) => x.entity === e); empCache.set(e, v); }
    return v;
  };

  for (const row of rows) {
    const ent = entityForPayGroup(row.pay_group);
    if (ent === 'FOCS_EXCLUDED' || ent === null) {
      const key = row.pay_group;
      const existing = excluded.get(key);
      if (existing) { existing.count++; } else { excluded.set(key, { payGroup: key, reason: exclusionReason(key), count: 1 }); }
      continue;
    }
    const gkey = `${ent}|${row.pay_date}|${row.pay_group}`;
    let g = groups.get(gkey);
    if (!g) { g = { entity: ent, row0: row, buckets: new Map() }; groups.set(gkey, g); }

    for (const [col, val] of Object.entries(row.sensitive)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (isTaxableBase(col)) continue;
      const res = resolveLine(row, col, acctFor(ent), empFor(ent));
      if ('unmapped' in res) {
        // Only flag genuinely-unmapped columns; ADP report aggregates/hours/reference
        // figures aren't postable and must not pollute the worklist or block posting.
        if (!isReportAggregateColumn(col)) {
          unmappedColumns.add(col);
          let d = unmappedDetails.get(col);
          if (!d) { d = { amount: 0, sources: new Map() }; unmappedDetails.set(col, d); }
          d.amount += val; // val is a nonzero number here (non-number/zero already skipped above)
          d.sources.set(row.row_key, row.name);
        }
        continue;
      }
      for (const t of res.targets) {
        // Memo is part of the bucket key so department-labelled lines that share an account
        // (e.g. Admin vs Accounting wages both on 'Administrative Wages') stay as distinct lines.
        const bkey = [t.accountName, t.departmentName ?? '', t.className ?? '', t.postingType, t.creditBucket ?? '', t.memo ?? ''].join('¦');
        let b = g.buckets.get(bkey);
        if (!b) { b = { postingType: t.postingType, amount: 0, accountName: t.accountName, departmentName: t.departmentName, className: t.className, memo: t.memo ?? null, creditBucket: t.creditBucket, rowKeys: new Set() }; g.buckets.set(bkey, b); }
        b.amount += val; b.rowKeys.add(row.row_key);
      }
    }
  }

  const drafts: JournalDraft[] = [];
  for (const g of groups.values()) {
    const lines: JournalLine[] = [...g.buckets.values()].map((b) => ({
      postingType: b.postingType, amount: round2(b.amount), accountName: b.accountName,
      departmentName: b.departmentName, className: b.className,
      // Department memo wins; pooled '*' lines (no memo) fall back to the creditBucket label.
      memo: b.memo ?? (b.creditBucket ?? ''), creditBucket: b.creditBucket, origin: 'generated', sourceRowKeys: [...b.rowKeys],
    }));
    // Group lines by account then memo so same-account department lines (e.g. Admin/Accounting
    // Wages) sit adjacent instead of in arbitrary bucket-first-appearance order.
    lines.sort(compareJournalLines);
    const totalDebits = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const totalCredits = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    drafts.push({
      kind: 'pay_date',
      entity: g.entity, payDate: g.row0.pay_date, payGroup: g.row0.pay_group,
      periodStart: g.row0.period_start_date, periodEnd: g.row0.period_end_date,
      lines, totalDebits, totalCredits, variance: round2(totalDebits - totalCredits),
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    });
  }
  return {
    drafts,
    unmappedColumns: [...unmappedColumns],
    unmappedColumnDetails: [...unmappedDetails.entries()].map(([column, d]) => ({
      column,
      amount: round2(d.amount),
      sources: [...d.sources.entries()].map(([rowKey, name]) => ({ rowKey, name })),
    })),
    unmappedPositions: [...unmappedPositions],
    excluded: [...excluded.values()].sort((a, b) => b.count - a.count),
  };
}
