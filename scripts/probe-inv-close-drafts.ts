/**
 * Read-only: what inventory-close drafts exist, and are they stale?
 *
 * The QBO BalanceSheet `start_date` bug (fixed 2026-09-03) meant every close
 * month was compared against ONE fixed set of book balances. Any draft generated
 * before that fix carries a wrong adjustment and must not post. This lists what
 * is stored, when it was generated, and whether it predates the fix.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

interface DraftRow {
  id: number;
  entity: string;
  pay_group: string;
  pay_date: string;
  period_end: string | null;
  status: string;
  qb_doc_number: string | null;
  qb_entry_id: string | null;
  total_debits: string;
  total_credits: string;
  variance: string;
  line_count: number;
  created_at: string | null;
  updated_at: string | null;
  snapshot: string | null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });

  const { rows } = await pool.query<DraftRow>(
    `SELECT h.id, h.entity, h.pay_group, h.pay_date::text AS pay_date,
            h.period_end::text AS period_end,
            h.status, h.qb_doc_number, h.qb_entry_id,
            h.total_debits::text, h.total_credits::text, h.variance::text,
            (SELECT count(*)::int FROM accounting.payroll_journal_lines l WHERE l.header_id = h.id) AS line_count,
            to_char(h.created_at,'YYYY-MM-DD HH24:MI') AS created_at,
            to_char(h.updated_at,'YYYY-MM-DD HH24:MI') AS updated_at,
            left(h.source_snapshot_hash, 12) AS snapshot
     FROM accounting.payroll_journal_headers h
     WHERE h.kind = 'inventory'
     ORDER BY h.pay_date, h.entity`,
  );

  console.log(`inventory-kind headers: ${rows.length}\n`);
  for (const r of rows) {
    console.log(
      [
        `#${String(r.id).padEnd(5)}`,
        r.entity.padEnd(12),
        `pd ${r.pay_date}`.padEnd(16),
        `pe ${r.period_end ?? '—'}`.padEnd(16),
        (r.pay_group ?? '').padEnd(10),
        (r.qb_doc_number ?? '—').padEnd(22),
        r.status.padEnd(12),
        `Dr ${Number(r.total_debits).toFixed(2).padStart(14)}`,
        `Cr ${Number(r.total_credits).toFixed(2).padStart(14)}`,
        `var ${Number(r.variance).toFixed(2).padStart(8)}`,
        `${String(r.line_count).padStart(3)} lines`,
        `gen ${r.updated_at ?? r.created_at ?? '—'}`,
        `snap ${r.snapshot ?? '—'}`,
        r.qb_entry_id ? `QB ${r.qb_entry_id}` : '',
      ].join('  '),
    );
  }

  // How many stored lines carry the receipt ids the new detail sheets read from.
  const { rows: src } = await pool.query<{ with_sources: number; total: number }>(
    `SELECT count(*) FILTER (WHERE array_length(l.source_row_keys, 1) > 0)::int AS with_sources,
            count(*)::int AS total
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE h.kind = 'inventory'`,
  );
  console.log(
    `\nlines carrying receipt ids: ${src[0]?.with_sources ?? 0} / ${src[0]?.total ?? 0}`,
  );

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
