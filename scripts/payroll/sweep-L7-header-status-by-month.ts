/**
 * READ-ONLY (books sweep L7). Pins the exact pay-date transition where each entity's payroll-JE
 * pipeline started actually posting (status='posted') vs sitting in needs_review, so the 2110-vs-
 * 2115 crediting mechanism found in sweep-L7-qbo-health-ledger.ts can be dated to a real event
 * (pipeline went live / drafts started being approved) rather than to accounting.payroll_account_map's
 * updated_at, which only reflects when the RULES TABLE was last (re)seeded by our own tooling —
 * not a real-world policy change.
 *
 *   npx tsx scripts/payroll/sweep-L7-header-status-by-month.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

interface Row { entity: string; mm: string; status: string; n: string }

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(
    `SELECT entity, to_char(txn_date, 'YYYY-MM') AS mm, status, count(*)::text AS n
     FROM accounting.payroll_journal_headers
     WHERE txn_date >= '2025-12-01' AND txn_date <= '2026-07-31' AND kind = 'pay_date'
     GROUP BY entity, mm, status
     ORDER BY entity, mm, status`,
  );
  let cur = '';
  for (const r of rows) {
    if (r.entity !== cur) { cur = r.entity; console.log(`\n=== ${r.entity} ===`); }
    console.log(`  ${r.mm}  ${r.status.padEnd(14)} ${r.n}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
