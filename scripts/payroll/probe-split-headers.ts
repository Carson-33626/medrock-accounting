/**
 * READ-ONLY: ground truth for meeting items #6 and #9 (the split payroll display bugs).
 *
 * Prints the period_segment vocabulary (to confirm what an UNSPLIT draft stores) and every
 * multi-piece run with its pieces' txn_dates — the pieces land in different calendar months,
 * which is precisely why a month filter returns only one of them and the landing page's
 * `split = pieces.length > 1` inference collapses.
 *
 * Also lists straddling periods that did NOT split, to explain the missing Split badges in
 * Screenshot 2026-08-06 155520.
 *   npx tsx scripts/payroll/probe-split-headers.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
  });

  try {
    const seg = await pool.query<{ period_segment: string; kind: string; n: string }>(
      `SELECT period_segment, kind, count(*)::text AS n
         FROM accounting.payroll_journal_headers
        GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 25`,
    );
    console.log('\n== period_segment vocabulary ==');
    for (const r of seg.rows) {
      console.log(`  ${JSON.stringify(r.period_segment).padEnd(12)} kind=${r.kind.padEnd(12)} ${r.n}`);
    }

    const multi = await pool.query<{
      entity: string; pay_date: string; pay_group: string; pieces: string;
      segs: string[]; txn_dates: string[]; variances: string[];
    }>(
      `SELECT entity, pay_date, pay_group, count(*)::text AS pieces,
              array_agg(period_segment ORDER BY period_segment) AS segs,
              array_agg(COALESCE(to_char(txn_date,'YYYY-MM-DD'),'(null)') ORDER BY period_segment) AS txn_dates,
              array_agg(variance::text ORDER BY period_segment) AS variances
         FROM accounting.payroll_journal_headers
        WHERE kind <> 'allocation'
        GROUP BY 1,2,3 HAVING count(*) > 1
        ORDER BY to_date(pay_date,'MM/DD/YYYY') DESC LIMIT 20`,
    );
    console.log(`\n== multi-piece (split) runs — ${multi.rows.length} ==`);
    for (const r of multi.rows) {
      const months = new Set(r.txn_dates.map((d) => d.slice(0, 7)));
      console.log(
        `  ${r.pay_date} ${r.entity.padEnd(12)} ${r.pay_group.padEnd(6)} pieces=${r.pieces} segs=[${r.segs.join(',')}] txn=[${r.txn_dates.join(',')}]${months.size > 1 ? '  <-- pieces span DIFFERENT months' : ''}`,
      );
    }

    // Straddlers that never split: splitStraddle bails when the draft is unbalanced.
    const straddle = await pool.query<{
      entity: string; pay_date: string; pay_group: string; period_start: string; period_end: string;
      variance: string; period_segment: string; siblings: string;
    }>(
      `SELECT h.entity, h.pay_date, h.pay_group, h.period_start, h.period_end,
              h.variance::text, h.period_segment,
              (SELECT count(*)::text FROM accounting.payroll_journal_headers s
                WHERE s.entity=h.entity AND s.pay_date=h.pay_date AND s.pay_group=h.pay_group) AS siblings
         FROM accounting.payroll_journal_headers h
        WHERE h.kind <> 'allocation'
          AND h.period_start IS NOT NULL AND h.period_end IS NOT NULL
          AND substr(h.period_start,1,2) <> substr(h.period_end,1,2)
        ORDER BY to_date(h.pay_date,'MM/DD/YYYY') DESC LIMIT 25`,
    );
    console.log(`\n== month-straddling periods (period_start month <> period_end month) ==`);
    for (const r of straddle.rows) {
      const unsplit = r.siblings === '1';
      console.log(
        `  ${r.pay_date} ${r.entity.padEnd(12)} ${r.pay_group.padEnd(6)} ${r.period_start}-${r.period_end} variance=${r.variance.padStart(9)} seg=${JSON.stringify(r.period_segment).padEnd(10)} siblings=${r.siblings}${unsplit ? '  <-- NOT SPLIT' : ''}`,
      );
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
