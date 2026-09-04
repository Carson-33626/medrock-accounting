/**
 * L8 rework (read-only), per V5's direction on L8-02: the April-July 2026 revenue
 * passthrough isn't a "TrueUp"-named JE (which is why the original L8 JE-name search found
 * nothing) — it's the 'passthrough' rule inside the EOM month-end allocation engine, sitting
 * as UNPOSTED headers in accounting.payroll_journal_headers (pay_group='EOM', kind='allocation')
 * awaiting Barbara's Approve -> Post. List every such header April-July 2026, per entity, with
 * amounts, so L8-02 can quantify the residual instead of asserting the gap is a lost cause.
 *   npx tsx scripts/payroll/_sweep-L8-rework-eom-drafts.ts
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

interface HeaderRow {
  id: string; entity: string; kind: string; pay_date: string; pay_group: string;
  period_segment: string | null; status: string; qb_doc_number: string | null;
  total_debits: string; total_credits: string; variance: string; row_count: string;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<HeaderRow>(
      `SELECT id::text, entity, kind, pay_date, pay_group, period_segment, status, qb_doc_number,
              total_debits::text, total_credits::text, variance::text, row_count::text
       FROM accounting.payroll_journal_headers
       WHERE pay_group = 'EOM' AND kind = 'allocation'
         AND pay_date IN ('04/30/2026','05/31/2026','06/30/2026','07/31/2026')
       ORDER BY pay_date, entity`,
    );
    console.log(`EOM allocation headers, April-July 2026 pay_dates: ${rows.length}`);
    let unpostedTotal = 0;
    const byEntityUnposted = new Map<string, number>();
    for (const h of rows) {
      const dr = Number(h.total_debits);
      console.log(
        `  ${h.pay_date}  ${h.entity.padEnd(4)}  status=${h.status.padEnd(10)} doc=${(h.qb_doc_number ?? '-').padEnd(20)} ` +
        `Dr=$${dr.toFixed(2).padStart(12)}  var=${h.variance}  rows=${h.row_count}`,
      );
      if (h.status !== 'posted') {
        unpostedTotal += dr;
        byEntityUnposted.set(h.entity, (byEntityUnposted.get(h.entity) ?? 0) + dr);
      }
    }
    console.log(`\nUnposted (status != 'posted') EOM allocation headers, April-July 2026, by entity:`);
    for (const [e, amt] of [...byEntityUnposted.entries()].sort()) console.log(`  ${e}: $${amt.toFixed(2)}`);
    console.log(`  TOTAL unposted: $${unpostedTotal.toFixed(2)}`);

    // Line-level detail: which lines use the 'passthrough' (100%) allocation rule specifically
    // (vs revenue %/thirds/fifty). There's no persisted `rule` column on payroll_journal_lines —
    // month-end.ts (line ~129) writes the rule label straight into the memo text instead:
    // `Allocation of <account> — ${RULE_LABEL[rule]} split`, and RULE_LABEL.passthrough = '100%'.
    const { rows: lineRows } = await pool.query<{ header_id: string; entity: string; pay_date: string; posting_type: string; amount: string; memo: string | null }>(
      `SELECT l.header_id::text, h.entity, h.pay_date, l.posting_type, l.amount::text, l.memo
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE h.pay_group = 'EOM' AND h.kind = 'allocation' AND h.status <> 'posted'
         AND h.pay_date IN ('04/30/2026','05/31/2026','06/30/2026','07/31/2026')
         AND l.memo ILIKE '%100% split%'
       ORDER BY h.pay_date, h.entity`,
    );
    console.log(`\n'100% split' (passthrough-rule) lines inside those unposted headers: ${lineRows.length}`);
    let passthroughTotal = 0;
    for (const l of lineRows) {
      const amt = Number(l.amount);
      if (l.posting_type === 'Debit') passthroughTotal += amt; // debit/credit pairs net to zero per header; sum one side only
      console.log(`  ${l.pay_date} ${l.entity}  ${l.posting_type.padEnd(6)} $${amt.toFixed(2).padStart(10)}  ${(l.memo ?? '').slice(0, 70)}`);
    }
    console.log(`  TOTAL passthrough-rule Debit $ inside unposted April-July headers: $${passthroughTotal.toFixed(2)}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
