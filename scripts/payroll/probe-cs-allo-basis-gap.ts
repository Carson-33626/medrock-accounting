/**
 * READ-ONLY: which allocation JEs can produce a basis sheet, and which cannot?
 *
 * The basis sheet is rebuilt from `accounting.payroll_eom_runs.pool` — the snapshot the
 * drafts were generated from. A month with no snapshot row cannot produce one, and the
 * entry downloads with the `Journal Entry` sheet alone.
 *
 * Run from web/:  npx tsx scripts/payroll/probe-cs-allo-basis-gap.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

interface HeaderRow {
  id: number;
  entity: string;
  pay_group: string;
  pay_date: string;
  status: string;
  qb_doc_number: string | null;
  qb_entry_id: string | null;
  month: string | null;
  line_count: number;
  total_debits: string;
}

interface RunRow {
  month: string;
  pool_lines: number;
  generated_at: string | null;
}

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: runs } = await pool.query<RunRow>(
    `SELECT month,
            COALESCE(jsonb_array_length(pool), 0) AS pool_lines,
            to_char(generated_at, 'YYYY-MM-DD HH24:MI') AS generated_at
     FROM accounting.payroll_eom_runs ORDER BY month`,
  );
  const snapshots = new Map(runs.map((r) => [r.month, r]));
  console.log(`payroll_eom_runs snapshots: ${runs.length}`);
  for (const r of runs) {
    console.log(`  ${r.month}  ${String(r.pool_lines).padStart(5)} pool lines  generated ${r.generated_at ?? '—'}`);
  }

  const { rows: headers } = await pool.query<HeaderRow>(
    `SELECT h.id, h.entity, h.pay_group, h.pay_date::text AS pay_date, h.status,
            h.qb_doc_number, h.qb_entry_id,
            substr(h.period_end::text, 7, 4) || '-' || substr(h.period_end::text, 1, 2) AS month,
            (SELECT count(*)::int FROM accounting.payroll_journal_lines l WHERE l.header_id = h.id) AS line_count,
            h.total_debits::text
     FROM accounting.payroll_journal_headers h
     WHERE h.kind = 'allocation'
     ORDER BY h.period_end, h.entity`,
  );

  console.log(`\nallocation headers: ${headers.length}\n`);
  let withBasis = 0;
  let without = 0;
  for (const h of headers) {
    const snap = h.month ? snapshots.get(h.month) : undefined;
    const ok = snap !== undefined && snap.pool_lines > 0;
    if (ok) withBasis += 1;
    else without += 1;
    console.log(
      [
        `#${String(h.id).padEnd(5)}`,
        h.entity.padEnd(12),
        (h.pay_group ?? '').padEnd(10),
        (h.month ?? '—').padEnd(8),
        h.status.padEnd(12),
        (h.qb_doc_number ?? '—').padEnd(22),
        h.qb_entry_id ? 'in QB  ' : 'not posted',
        `Dr ${Number(h.total_debits).toFixed(2).padStart(12)}`,
        ok ? `basis OK (${snap.pool_lines} lines)` : 'NO BASIS SHEET',
      ].join('  '),
    );
  }

  console.log(`\n${withBasis} allocation entries can produce a basis sheet; ${without} cannot.`);
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
