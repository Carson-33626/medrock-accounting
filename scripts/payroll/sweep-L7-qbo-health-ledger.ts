/**
 * READ-ONLY (books sweep L7, accountant-scrutiny pass). sweep-L7-health-bucket-diagnostic.ts found
 * that MedRock FL's own automated payroll-JE pipeline has ZERO 'posted' headers for Dec 2025-Feb
 * 2026 (every header sits at status='needs_review') — so accounting.payroll_journal_lines cannot
 * see what actually posted to QuickBooks for those two months; Jan/Feb payroll must have reached
 * QBO through a separate manual JE. This probe goes straight to the authoritative source: every
 * JournalEntry line in FL/TN/TX, Dec 2025-Jul 2026, whose Description or account name is
 * health-related, regardless of DocNumber or whether it came from our pipeline or a manual entry.
 * That is the actual GL activity in "Payroll Withholdings" (2110) and "Accrued Payroll Liability"
 * (2115) attributable to health benefits, month by month — the object being tested. It is compared,
 * finding-by-finding, against the independent ADP register (sweep-L7-deductions-by-entity-month.ts)
 * and the Aetna carrier cash draw (sweep-L7-carrier-and-fringe.ts), not against itself.
 *
 * Also pulls header-level status counts (posted vs needs_review) for all three entities, all
 * months, so "did our pipeline even post this month" is answered before any roll-forward claim.
 *
 *   npx tsx scripts/payroll/sweep-L7-qbo-health-ledger.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const HEALTH_RE = /health|medical|dental|vision|aetna/i;
const LIABILITY_ACCT_RE = /^payroll withholdings$|^accrued payroll liability$/i;

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }
interface HeaderStatusRow { entity: string; status: string; n: string }

async function main(): Promise<void> {
  const pool = getRdsPool();
  console.log('===== Payroll-JE-pipeline header status, all entities, Dec 2025-Jul 2026 =====');
  const { rows: statusRows } = await pool.query<HeaderStatusRow>(
    `SELECT entity, status, count(*)::text AS n
     FROM accounting.payroll_journal_headers
     WHERE txn_date >= '2025-12-01' AND txn_date <= '2026-07-31'
     GROUP BY entity, status ORDER BY entity, status`,
  );
  for (const r of statusRows) console.log(`  ${r.entity.padEnd(12)} ${r.status.padEnd(14)} ${r.n}`);
  await pool.end();

  for (const entity of ENTITIES) {
    console.log(`\n\n========================= ${entity}: QBO JournalEntry lines, health-related, Dec 2025-Jul 2026 =========================`);
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2025-12-01' AND TxnDate <= '2026-07-31' ORDER BY TxnDate ASC`);
    const byMonth = new Map<string, { cr2110: number; dr2110: number; cr2115: number; dr2115: number; other: number }>();
    let totalLinesMatched = 0;
    for (const je of jes) {
      const mm = (je.TxnDate ?? '').slice(0, 7);
      for (const l of je.Line ?? []) {
        const desc = l.Description ?? '';
        const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? '';
        if (!HEALTH_RE.test(desc) && !HEALTH_RE.test(je.DocNumber ?? '')) continue;
        if (!LIABILITY_ACCT_RE.test(acct)) continue;
        totalLinesMatched++;
        const amt = l.Amount ?? 0;
        const isDebit = l.JournalEntryLineDetail?.PostingType === 'Debit';
        const bucket = byMonth.get(mm) ?? { cr2110: 0, dr2110: 0, cr2115: 0, dr2115: 0, other: 0 };
        if (/^payroll withholdings$/i.test(acct)) { if (isDebit) bucket.dr2110 += amt; else bucket.cr2110 += amt; }
        else if (/^accrued payroll liability$/i.test(acct)) { if (isDebit) bucket.dr2115 += amt; else bucket.cr2115 += amt; }
        byMonth.set(mm, bucket);
      }
    }
    console.log(`  (matched ${totalLinesMatched} health-related lines touching Payroll Withholdings / Accrued Payroll Liability)`);
    console.log('  month     Cr-2110      Dr-2110      net-2110       Cr-2115      Dr-2115      net-2115');
    const months = [...byMonth.keys()].sort();
    for (const mm of months) {
      const b = byMonth.get(mm)!;
      const net2110 = b.cr2110 - b.dr2110;
      const net2115 = b.cr2115 - b.dr2115;
      console.log(`  ${mm}   ${money(b.cr2110).padStart(11)}  ${money(b.dr2110).padStart(11)}  ${money(net2110).padStart(12)}   ${money(b.cr2115).padStart(11)}  ${money(b.dr2115).padStart(11)}  ${money(net2115).padStart(12)}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
