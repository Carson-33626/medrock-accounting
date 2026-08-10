/**
 * READ-ONLY: tests the PREMISE behind skipping passthrough ('Allocate - FL/TN/TX') lines at
 * month-end — namely that QuickBooks' Intercompany allocation has already booked the move on
 * the transaction itself. If true, a passthrough transaction should carry BOTH an expense leg
 * and a Due From/To leg under the same Allocate class. Groups the saved attention set by
 * txnType and reports, per transaction, whether an inter-entity leg is present.
 *   npx tsx scripts/payroll/probe-verify-passthrough-legs.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import type { PoolLine } from '../../src/lib/payroll/qb-pool';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const IE_RE = /^Due (from|From|to|To) /i;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<{ month: string; attention: PoolLine[] }>(
      `SELECT month, attention FROM accounting.payroll_eom_runs ORDER BY month`,
    );
    for (const run of rows) {
      const pass = run.attention.filter((l) => l.rule === 'passthrough');
      console.log(`\n===== ${run.month}: ${pass.length} passthrough line(s), ${money(pass.reduce((s, l) => s + l.amount, 0))} =====`);

      const byType = new Map<string, { n: number; amt: number }>();
      for (const l of pass) {
        const g = byType.get(l.txnType) ?? { n: 0, amt: 0 };
        g.n++; g.amt += l.amount; byType.set(l.txnType, g);
      }
      console.log('  by transaction type:');
      for (const [t, g] of [...byType].sort()) console.log(`    ${t.padEnd(14)} lines=${String(g.n).padStart(4)} ${money(g.amt).padStart(14)}`);

      // Per transaction: does an Allocate-classed inter-entity leg accompany the expense leg?
      const txns = new Map<string, { type: string; entity: string; expense: number; ie: number }>();
      for (const l of pass) {
        const k = `${l.entity}¦${l.txnType}¦${l.txnId}`;
        const g = txns.get(k) ?? { type: l.txnType, entity: l.entity, expense: 0, ie: 0 };
        if (IE_RE.test(l.accountName)) g.ie += l.amount; else g.expense += l.amount;
        txns.set(k, g);
      }
      const withIe = [...txns.values()].filter((t) => t.ie !== 0);
      console.log(`  distinct passthrough transactions: ${txns.size}; carrying an Allocate-classed Due From/To leg: ${withIe.length}`);
      for (const [k, t] of [...txns].filter(([, t]) => t.ie !== 0)) {
        console.log(`    ${k}  expense=${money(t.expense)}  interEntity=${money(t.ie)}`);
      }
    }
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
