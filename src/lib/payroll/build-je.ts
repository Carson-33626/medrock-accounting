import type { PayrollRow, AccountMapRule, EmployeeMapRule, JournalDraft, JournalLine, Entity } from './types';
import { resolveLine } from './mapping';
import { entityForPayGroup } from './entity';

const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Bucket { postingType: 'Debit' | 'Credit'; amount: number; accountName: string; departmentName: string | null; className: string | null; creditBucket: JournalLine['creditBucket']; rowKeys: Set<string>; }

export function buildJournal(
  rows: PayrollRow[], accountMap: AccountMapRule[], employeeMap: EmployeeMapRule[],
): { drafts: JournalDraft[]; unmappedColumns: string[]; unmappedPositions: string[]; excludedFocsRows: number } {
  const unmappedColumns = new Set<string>();
  const unmappedPositions = new Set<string>();
  let excludedFocsRows = 0;
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
    if (ent === 'FOCS_EXCLUDED') { excludedFocsRows++; continue; }
    if (ent === null) continue; // unknown group — surfaced elsewhere
    const gkey = `${ent}|${row.pay_date}|${row.pay_group}`;
    let g = groups.get(gkey);
    if (!g) { g = { entity: ent, row0: row, buckets: new Map() }; groups.set(gkey, g); }

    for (const [col, val] of Object.entries(row.sensitive)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (isTaxableBase(col)) continue;
      const r = resolveLine(row, col, acctFor(ent), empFor(ent));
      if ('unmapped' in r) { if (r.unmapped === 'column') unmappedColumns.add(col); else unmappedPositions.add(row.position_id); continue; }
      const bkey = [r.accountName, r.departmentName ?? '', r.className ?? '', r.postingType, r.creditBucket ?? ''].join('¦');
      let b = g.buckets.get(bkey);
      if (!b) { b = { postingType: r.postingType, amount: 0, accountName: r.accountName, departmentName: r.departmentName, className: r.className, creditBucket: r.creditBucket, rowKeys: new Set() }; g.buckets.set(bkey, b); }
      b.amount += val; b.rowKeys.add(row.row_key);
    }
  }

  const drafts: JournalDraft[] = [];
  for (const g of groups.values()) {
    const lines: JournalLine[] = [...g.buckets.values()].map((b) => ({
      postingType: b.postingType, amount: round2(b.amount), accountName: b.accountName,
      departmentName: b.departmentName, className: b.className,
      memo: b.creditBucket ?? '', creditBucket: b.creditBucket, origin: 'generated', sourceRowKeys: [...b.rowKeys],
    }));
    const totalDebits = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const totalCredits = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    drafts.push({
      entity: g.entity, payDate: g.row0.pay_date, payGroup: g.row0.pay_group,
      periodStart: g.row0.period_start_date, periodEnd: g.row0.period_end_date,
      lines, totalDebits, totalCredits, variance: round2(totalDebits - totalCredits),
      rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    });
  }
  return { drafts, unmappedColumns: [...unmappedColumns], unmappedPositions: [...unmappedPositions], excludedFocsRows };
}
