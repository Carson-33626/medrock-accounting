/**
 * READ-ONLY — Books Sweep lane L1, Q6. For every employee attributed a non-zero 1215 balance
 * (from sweep-L1-1215-running-balance.ts), pull their most recent `status` row in
 * source.payroll_history to flag terminated employees with an open balance.
 *
 *   npx tsx scripts/payroll/sweep-L1-termination-check.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

const NAMES = [
  'Webb', 'Pinchin', 'Denha', 'Pericot', 'Mitchell', 'Newton', 'Dickie', 'Rogelstad',
  'Anguiano', 'Dean', 'Hart', 'Ivey', 'Linares', 'Lowe', 'Mathis', 'Poland', 'Powell', 'Ruiz',
  'Barnes', 'Freebeck', 'Browne',
];

interface Row { name: string; position_id: string; pay_date: string; status: string | null }

async function main(): Promise<void> {
  const pool = getRdsPool();
  for (const n of NAMES) {
    const { rows } = await pool.query<Row>(
      `SELECT name, position_id, pay_date, status FROM source.payroll_history
       WHERE name ILIKE $1 ORDER BY pay_date DESC LIMIT 1`,
      [`%${n}%`],
    );
    if (rows.length === 0) { console.log(`${n.padEnd(12)} (no payroll_history row found)`); continue; }
    const r = rows[0];
    console.log(`${n.padEnd(12)} ${r.name.padEnd(28)} (${r.position_id})  most recent pay_date=${r.pay_date}  status=${r.status ?? '(null)'}`);
  }
  await pool.end();
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
