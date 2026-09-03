import type { PayrollRow, AccountMapRule, EmployeeMapRule, JournalDraft, JournalLine, Entity, UnmappedColumnDetail, ResolvedTarget } from './types';
import { resolveLine } from './mapping';
import { entityForPayGroup } from './entity';
import { compareJournalLines } from './line-order';
import { deptLabelFor } from './cost-center';

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

/**
 * Round each bucket to cents, then reconcile pooled split groups: within each
 * (account, postingType, creditBucket) set of pooled buckets, force the rounded amounts to sum to
 * round2(exact group total) by adding the leftover cents to the largest slice (largest-remainder).
 * Non-pooled buckets are rounded independently (unchanged behavior). Guarantees the split is
 * dollar-neutral versus a single pooled line, so totalDebits/totalCredits/variance don't move.
 */
function roundBucketAmounts(buckets: Bucket[]): Map<Bucket, number> {
  const amounts = new Map<Bucket, number>(buckets.map((b) => [b, round2(b.amount)]));
  const groups = new Map<string, Bucket[]>();
  for (const b of buckets) {
    if (!b.pooled) continue;
    const key = [b.accountName, b.postingType, b.creditBucket ?? ''].join('¦');
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  for (const members of groups.values()) {
    const target = round2(members.reduce((s, b) => s + b.amount, 0));
    const roundedSum = round2(members.reduce((s, b) => s + (amounts.get(b) ?? 0), 0));
    const residual = round2(target - roundedSum);
    if (residual !== 0) {
      const largest = members.reduce((a, b) => (b.amount > a.amount ? b : a));
      amounts.set(largest, round2((amounts.get(largest) ?? 0) + residual));
    }
  }
  return amounts;
}

/**
 * Final JE line memo for a resolved target. Cost-center-specific rules (pooled === false) already
 * carry a dept-labelled memo from the seed — used verbatim. Pooled '*' rules (all credits, UI-mapped
 * columns) are split by the row's cost center: base (rule memo, else credit bucket, else account
 * name) + ` - <Dept>`, or bare base for DFLT/unknown cost centers.
 */
function deriveMemo(t: ResolvedTarget): string {
  if (!t.pooled) return t.memo ?? t.creditBucket ?? '';
  const base = t.memo ?? t.creditBucket ?? t.accountName;
  const dept = deptLabelFor(t.costCenter);
  return dept ? `${base} - ${dept}` : base;
}

interface Bucket { postingType: 'Debit' | 'Credit'; amount: number; accountName: string; departmentName: string | null; className: string | null; memo: string; creditBucket: JournalLine['creditBucket']; pooled: boolean; rowKeys: Set<string>; columns: Map<string, ColumnAccum>; }
interface ColumnAccum { amount: number; positions: Set<string> }

/**
 * What ONE JE line was built from, at ADP-column grain.
 *
 * `employees` is a HEADCOUNT, never a roster. Payroll detail is employee-level and
 * QuickBooks attachments are visible to everyone with company access, so the count is
 * the most granular thing that can safely leave this system (DS §8 q3). The names stay
 * behind the existing decrypt gate on the drill-down.
 */
export interface LineSourceDetail {
  /** The ADP report column, e.g. 'REGULAR EARNINGS' or 'FICA - EE'. */
  column: string;
  /** Dollars this column contributed to the line, 2dp, summing exactly to the line amount. */
  amount: number;
  /** Distinct people who carried it. */
  employees: number;
}

/**
 * Distribute a line's cents across its columns so the parts sum EXACTLY to the line.
 *
 * The parts start as the unrounded per-column dollars; the line amount has already been
 * through `roundBucketAmounts`' largest-remainder settle, so up to a couple of cents can
 * separate the two. The residual lands on the largest part — the same convention the
 * bucket rounding uses, and the only one that keeps a detail sheet footing to the entry
 * it substantiates.
 */
function settleColumnCents(targetCents: number, parts: { column: string; amount: number; employees: number }[]): LineSourceDetail[] {
  if (parts.length === 0) return [];
  const cents = parts.map((p) => Math.round(p.amount * 100));
  const residual = targetCents - cents.reduce((s, c) => s + c, 0);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < cents.length; i++) if (Math.abs(cents[i]) > Math.abs(cents[largest])) largest = i;
    cents[largest] += residual;
  }
  return parts.map((p, i) => ({ column: p.column, amount: cents[i] / 100, employees: p.employees }));
}

export interface ExcludedGroup { payGroup: string; reason: string; count: number; }

/** Human-readable reason a row's pay_group is non-postable, given the raw (untrimmed) value. */
export function exclusionReason(payGroup: string): string {
  const g = payGroup.trim().toUpperCase();
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
): {
  drafts: JournalDraft[];
  /** Per-ADP-column composition of every line, index-aligned with `drafts` then `drafts[i].lines`. */
  draftSources: LineSourceDetail[][][];
  unmappedColumns: string[]; unmappedColumnDetails: UnmappedColumnDetail[]; unmappedPositions: string[]; excluded: ExcludedGroup[];
} {
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
    if (ent === null) {
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
        const lineMemo = deriveMemo(t);
        // costCenter + pooled + memo are all in the key so pooled lines split per cost center while
        // cost-center-specific lines (whose rows all share one cc) are unaffected.
        const bkey = [t.accountName, t.departmentName ?? '', t.className ?? '', t.postingType, t.creditBucket ?? '', lineMemo, t.costCenter, t.pooled ? 'P' : 'S'].join('¦');
        let b = g.buckets.get(bkey);
        if (!b) { b = { postingType: t.postingType, amount: 0, accountName: t.accountName, departmentName: t.departmentName, className: t.className, memo: lineMemo, creditBucket: t.creditBucket, pooled: t.pooled, rowKeys: new Set(), columns: new Map() }; g.buckets.set(bkey, b); }
        b.amount += val; b.rowKeys.add(row.row_key);
        // Per-ADP-column composition of the bucket, for the JE's source-detail sheet.
        // Positions (not names) so the sheet can state a headcount without carrying PHI.
        let ca = b.columns.get(col);
        if (!ca) { ca = { amount: 0, positions: new Set() }; b.columns.set(col, ca); }
        ca.amount += val; ca.positions.add(row.position_id);
      }
    }
  }

  const drafts: JournalDraft[] = [];
  const draftSources: LineSourceDetail[][][] = [];
  for (const g of groups.values()) {
    const bucketList = [...g.buckets.values()];
    const amounts = roundBucketAmounts(bucketList);
    const sourcesByLine = new Map<JournalLine, LineSourceDetail[]>();
    const lines: JournalLine[] = bucketList.map((b) => {
      const amount = amounts.get(b) ?? round2(b.amount);
      // A bucket that nets NEGATIVE flips sides instead of carrying a negative amount:
      // a -49.55 "Debit" is a 49.55 Credit. QuickBooks rejects negative JE line amounts,
      // the grid can't render them honestly, and accountants can't edit generated lines
      // to fix it themselves (Barbara, TN 04/24/2026: WC - Admin netted -49.55).
      const flip = amount < 0;
      const line: JournalLine = {
        postingType: flip ? (b.postingType === 'Debit' ? 'Credit' as const : 'Debit' as const) : b.postingType,
        amount: flip ? round2(-amount) : amount, accountName: b.accountName,
        departmentName: b.departmentName, className: b.className,
        memo: b.memo, creditBucket: b.creditBucket, origin: 'generated', sourceRowKeys: [...b.rowKeys],
      };
      // A flipped bucket posts the other side for its ABSOLUTE amount, so its column
      // contributions flip with it — otherwise the detail would sum to the negative of
      // the line it explains.
      const sign = flip ? -1 : 1;
      const parts = [...b.columns.entries()]
        .map(([column, c]) => ({ column, amount: sign * c.amount, employees: c.positions.size }))
        .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount) || x.column.localeCompare(y.column));
      sourcesByLine.set(line, settleColumnCents(Math.round(line.amount * 100), parts));
      return line;
    });
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
    draftSources.push(lines.map((l) => sourcesByLine.get(l) ?? []));
  }
  return {
    drafts,
    draftSources,
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
