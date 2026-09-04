/**
 * READ-ONLY (books sweep L7, accountant-scrutiny follow-up). sweep-L7-health-rollforward.ts shows
 * ZERO 'Health' credit_bucket lines from our own posted payroll JEs for MedRock FL in Jan/Feb 2026,
 * then real amounts from March on. Before treating that as a finding, check: (a) do FL Jan/Feb
 * payroll-JE headers exist and are they status='posted' at all, (b) what account_name/credit_bucket
 * combination actually carries the medical/dental/vision EE withholding in payroll_account_map for
 * FL, and whether it changed over time (Jan/Feb vs March+), (c) do the same TN/TX Jan/Feb headers
 * look the same way.
 *
 *   npx tsx scripts/payroll/sweep-L7-health-bucket-diagnostic.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

interface HeaderRow { entity: string; pay_date: string; txn_date: string; status: string; kind: string | null }
interface MapRow { entity: string; adp_column: string; account_name: string; posting_type: string; credit_bucket: string | null; active: boolean }
interface BucketRow { credit_bucket: string | null; account_name: string; n: string; total: string }

async function main(): Promise<void> {
  const pool = getRdsPool();

  console.log('=== A. payroll_journal_headers, MedRock FL, Dec 2025 - Feb 2026, all statuses ===');
  const { rows: headers } = await pool.query<HeaderRow>(
    `SELECT entity, pay_date::text AS pay_date, txn_date::text AS txn_date, status, kind
     FROM accounting.payroll_journal_headers
     WHERE entity = 'MedRock FL' AND txn_date >= '2025-12-01' AND txn_date <= '2026-02-28'
     ORDER BY txn_date`,
  );
  for (const h of headers) console.log(`  ${h.txn_date}  pay_date=${h.pay_date}  status=${h.status}  kind=${h.kind ?? '(pay_date)'}`);
  if (headers.length === 0) console.log('  (no headers at all — Jan/Feb FL payroll was never run through this pipeline)');

  console.log('\n=== B. payroll_account_map rules for FL matching MEDICAL/DENTAL/VISION (active + inactive) ===');
  const { rows: mapRows } = await pool.query<MapRow>(
    `SELECT entity, adp_column, account_name, posting_type, credit_bucket, active
     FROM accounting.payroll_account_map
     WHERE entity = 'MedRock FL' AND (adp_column ILIKE '%MEDICAL%' OR adp_column ILIKE '%DENTAL%' OR adp_column ILIKE '%VISION%')
     ORDER BY active DESC, adp_column`,
  );
  for (const m of mapRows) console.log(`  active=${m.active}  ${m.adp_column.padEnd(40)} -> ${m.account_name.padEnd(30)} ${m.posting_type}  bucket=${m.credit_bucket ?? '(null)'}`);
  if (mapRows.length === 0) console.log('  (no rules found at all for medical/dental/vision — FL)');

  console.log('\n=== C. ALL credit_bucket values seen on FL posted lines, Dec 2025-Feb 2026, grouped ===');
  const { rows: buckets } = await pool.query<BucketRow>(
    `SELECT l.credit_bucket, l.account_name, count(*)::text AS n, sum(l.amount)::text AS total
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     WHERE h.entity = 'MedRock FL' AND h.status = 'posted'
       AND h.txn_date >= '2025-12-01' AND h.txn_date <= '2026-02-28'
     GROUP BY l.credit_bucket, l.account_name
     ORDER BY l.credit_bucket, l.account_name`,
  );
  for (const b of buckets) console.log(`  bucket=${(b.credit_bucket ?? '(null)').padEnd(12)} account=${b.account_name.padEnd(30)} n=${b.n.padStart(4)}  total=${Number(b.total).toFixed(2)}`);
  if (buckets.length === 0) console.log('  (no posted lines at all in this window for FL)');

  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
