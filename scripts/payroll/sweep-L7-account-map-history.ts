/**
 * READ-ONLY (books sweep L7, accountant-scrutiny pass). sweep-L7-qbo-health-ledger.ts shows FL's
 * "Payroll Withholdings" (2110) getting zero health-related credits in Dec 2025/Jan 2026 while
 * "Accrued Payroll Liability" (2115) gets large ones, then the pattern flips (2110 starts getting
 * credited, 2115's credits taper off) — and sweep-L7-health-bucket-diagnostic.ts found BOTH an
 * active rule (credit Payroll Withholdings) and an inactive rule (credit Accrued Payroll
 * Liability) for the same MEDICAL/DENTAL/VISION-EE adp_columns in FL's payroll_account_map. This
 * pulls updated_at on every medical/dental/vision rule, all three entities, to date exactly when
 * the credit target was changed — turning "there's a crossover" into "the mapping rule changed on
 * this date, from this account to this account."
 *
 *   npx tsx scripts/payroll/sweep-L7-account-map-history.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

interface Row {
  entity: string; adp_column: string; account_name: string; posting_type: string;
  credit_bucket: string | null; active: boolean; updated_at: string;
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<Row>(
    `SELECT entity, adp_column, account_name, posting_type, credit_bucket, active, updated_at::text AS updated_at
     FROM accounting.payroll_account_map
     WHERE adp_column ILIKE '%MEDICAL%' OR adp_column ILIKE '%DENTAL%' OR adp_column ILIKE '%VISION%'
     ORDER BY entity, adp_column, updated_at`,
  );
  let cur = '';
  for (const r of rows) {
    const key = `${r.entity} / ${r.adp_column}`;
    if (key !== cur) { cur = key; console.log(`\n=== ${key} ===`); }
    console.log(`  active=${String(r.active).padEnd(5)} updated_at=${r.updated_at}  -> ${r.account_name.padEnd(28)} ${r.posting_type.padEnd(7)} bucket=${r.credit_bucket ?? '(null)'}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
