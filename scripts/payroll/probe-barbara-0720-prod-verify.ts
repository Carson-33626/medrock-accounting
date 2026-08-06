/**
 * READ-ONLY: verify Barbara's 2026-07-20 email items (b)(c)(d) against prod RDS.
 *   (c) COMPANY LOAN - EE - PRINCIPAL POST-TAX -> Employee Advances rule seeded?
 *   (b) per-dept debit specials (MEDICAL - ER etc.) seeded? dept memos in drafts?
 *   (d) draft pay-date coverage (pre-April reachable data)
 * No writes.
 *   npx tsx scripts/payroll/probe-barbara-0720-prod-verify.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const connectionString = process.env.RDS_DATABASE_URL;
if (!connectionString) throw new Error('RDS_DATABASE_URL not set');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  // (c) Employee Advances / COMPANY LOAN rule live?
  const loan = await pool.query<{ entity: string; adp_column: string; account_name: string; posting_type: string; active: boolean }>(
    `SELECT entity, adp_column, account_name, posting_type, active
     FROM accounting.payroll_account_map
     WHERE adp_column ILIKE '%COMPANY LOAN%' OR account_name = 'Employee Advances'
     ORDER BY entity, adp_column`,
  );
  console.log(`\n=== (c) COMPANY LOAN / Employee Advances rules: ${loan.rowCount} ===`);
  for (const r of loan.rows) console.log(`  ${r.entity}  ${r.adp_column}  -> ${r.account_name} (${r.posting_type}) active=${r.active}`);

  // (c) do live drafts actually carry an Employee Advances line?
  const loanLines = await pool.query<{ entity: string; n: string; total: string }>(
    `SELECT h.entity, count(*)::text AS n, sum(l.amount)::text AS total
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE l.account_name = 'Employee Advances'
     GROUP BY 1 ORDER BY 1`,
  );
  console.log(`\n=== (c) Employee Advances lines in drafts ===`);
  for (const r of loanLines.rows) console.log(`  ${r.entity}  ${r.n} lines  ${r.total} cents`);

  // (b) per-dept pooled debit specials seeded? (MEDICAL - ER / CAR ALLOWANCE / REIMBURSEMENT / BONUS)
  const pooled = await pool.query<{ adp_column: string; entity: string; ccs: string }>(
    `SELECT adp_column, entity, string_agg(DISTINCT cost_center, ',' ORDER BY cost_center) AS ccs
     FROM accounting.payroll_account_map
     WHERE adp_column IN ('MEDICAL - ER', 'CAR ALLOWANCE', 'REIMBURSEMENT', 'BONUS')
       AND posting_type = 'Debit' AND active
     GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  console.log(`\n=== (b) pooled debit specials — cost centers per rule ===`);
  for (const r of pooled.rows) console.log(`  ${r.adp_column}  ${r.entity}  [${r.ccs}]`);

  // (b) memo coverage on Accrued Payroll Liability lines in drafts (was the blank-memo pooled line)
  const accrued = await pool.query<{ memo: string | null; n: string }>(
    `SELECT l.memo, count(*)::text AS n
     FROM accounting.payroll_journal_lines l
     WHERE l.account_name = 'Accrued Payroll Liability' AND l.posting_type = 'Debit'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
  );
  console.log(`\n=== (b) Accrued Payroll Liability debit-line memos in drafts ===`);
  for (const r of accrued.rows) console.log(`  ${String(r.memo ?? '(blank)').padEnd(30)} ${r.n}`);

  // (b) dept memo distribution across all generated wage lines (spot check)
  const memos = await pool.query<{ memo: string | null; n: string }>(
    `SELECT l.memo, count(*)::text AS n
     FROM accounting.payroll_journal_lines l
     WHERE l.origin = 'generated' AND l.memo ILIKE '%Wages%'
     GROUP BY 1 ORDER BY 1 LIMIT 25`,
  );
  console.log(`\n=== (b) wage-line memos present ===`);
  for (const r of memos.rows) console.log(`  ${String(r.memo ?? '(blank)').padEnd(30)} ${r.n}`);

  // (d) draft coverage — how far back do built drafts go now?
  const dates = await pool.query<{ ym: string; dates: string; entities: string }>(
    `SELECT to_char(to_date(pay_date, 'MM/DD/YYYY'), 'YYYY-MM') AS ym,
            count(DISTINCT pay_date)::text AS dates,
            string_agg(DISTINCT entity, ',') AS entities
     FROM accounting.payroll_journal_headers
     GROUP BY 1 ORDER BY 1`,
  );
  console.log(`\n=== (d) built drafts by month ===`);
  for (const r of dates.rows) console.log(`  ${r.ym}  ${r.dates} pay dates  [${r.entities}]`);

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
