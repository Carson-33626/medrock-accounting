import '../receipt-enrichment/engines/ramp-split-push/load-env';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const cols = await pool.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema='accounting' AND table_name='payroll_journal_headers'
       AND column_name IN ('kind','period_segment','txn_date')
     ORDER BY column_name`,
  );
  console.log('columns:', JSON.stringify(cols.rows, null, 2));
  const nulls = await pool.query(
    `SELECT count(*)::text AS n FROM accounting.payroll_journal_headers WHERE txn_date IS NULL`,
  );
  console.log('txn_date NULL rows:', nulls.rows[0].n);
  const cons = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'accounting.payroll_journal_headers'::regclass AND contype = 'u'`,
  );
  console.log('unique constraints:', JSON.stringify(cons.rows, null, 2));
  process.exit(0);
}

void main();
