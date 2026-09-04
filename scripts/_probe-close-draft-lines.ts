/**
 * READ-ONLY: the actual LINES on the stored inventory-close drafts.
 *
 * Before regenerating anything, know what the regeneration is going to change —
 * in particular whether `Lab Compound Packaging Inventory` (1220.15) is on these
 * entries, because its FIFO target is the one figure Carson says cannot be
 * settled without a physical count.
 *
 * Run from web/:  npx tsx scripts/_probe-close-draft-lines.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface LineRow {
  header_id: number;
  entity: string;
  period_end: string;
  account_name: string;
  posting_type: string;
  amount: string;
  memo: string | null;
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<LineRow>(
    `SELECT h.id AS header_id, h.entity, h.period_end::text AS period_end,
            l.account_name, l.posting_type, l.amount::text, l.memo
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     WHERE h.kind = 'inventory'
     ORDER BY h.period_end, h.entity, l.sort_order`,
  );

  let current = '';
  for (const r of rows) {
    const key = `${r.period_end}  ${r.entity}  (#${r.header_id})`;
    if (key !== current) {
      console.log(`\n${key}`);
      current = key;
    }
    const side = r.posting_type.toLowerCase().startsWith('d') ? 'Dr' : 'Cr';
    console.log(
      `   ${r.account_name.padEnd(50)} ${`${side} ${Number(r.amount).toFixed(2)}`.padStart(18)}   ${r.memo ?? ''}`,
    );
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
