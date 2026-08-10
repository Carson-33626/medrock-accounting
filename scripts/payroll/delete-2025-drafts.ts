/**
 * Delete the 2025 payroll DRAFTS.
 *
 * WHY: Carson, 2026-08-10 — "2025 is closed so is a hands off territory, broken or not those books
 * are locked." The 2025 drafts in our system are unposted, were built from ADP exports whose column
 * names and department conventions predate the current account map (hence 42 of 143 not balancing),
 * and Amy keyed the real 2025 entries into QuickBooks by hand. Keeping them invites someone to
 * mistake them for authoritative, or to post into a closed year. Removing them leaves Amy's
 * QuickBooks entries as the single 2025 record.
 *
 * This deletes OUR draft rows only. It does not, and cannot, touch QuickBooks.
 *
 * SAFETY:
 *  - Scoped to pay dates in calendar 2025.
 *  - REFUSES to delete anything carrying a qb_entry_id. A posted draft is the audit trail for a
 *    real QuickBooks entry, so if even one turns up the whole run aborts rather than proceeding
 *    with a partial delete.
 *  - payroll_journal_lines is ON DELETE CASCADE, so lines go with their header automatically.
 *  - Audit rows are intentionally NOT deleted — the record of what was attempted should outlive
 *    the drafts.
 *
 * DEFAULT IS A DRY RUN. Pass --apply.
 *   npx tsx scripts/payroll/delete-2025-drafts.ts
 *   npx tsx scripts/payroll/delete-2025-drafts.ts --apply
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

const APPLY = process.argv.includes('--apply');
const YEAR_START = '2025-01-01';
const YEAR_END = '2025-12-31';

interface HeaderRow {
  id: number;
  entity: string;
  pay_date: string;
  pay_group: string;
  kind: string;
  status: string;
  qb_entry_id: string | null;
  lines: string;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL, max: 1,
    ssl: RDS_SSL, connectionTimeoutMillis: 30_000,
  });

  try {
    const { rows } = await pool.query<HeaderRow>(
      `SELECT h.id, h.entity, h.pay_date, h.pay_group, h.kind, h.status, h.qb_entry_id,
              count(l.id)::text AS lines
         FROM accounting.payroll_journal_headers h
         LEFT JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
        WHERE to_date(h.pay_date,'MM/DD/YYYY') BETWEEN $1::date AND $2::date
        GROUP BY h.id, h.entity, h.pay_date, h.pay_group, h.kind, h.status, h.qb_entry_id
        ORDER BY to_date(h.pay_date,'MM/DD/YYYY'), h.entity`,
      [YEAR_START, YEAR_END],
    );

    const posted = rows.filter((r) => r.qb_entry_id !== null);
    const totalLines = rows.reduce((s, r) => s + Number(r.lines), 0);

    console.log(`\n2025 payroll drafts: ${rows.length} headers, ${totalLines} lines`);
    const byEntity = new Map<string, number>();
    for (const r of rows) byEntity.set(r.entity, (byEntity.get(r.entity) ?? 0) + 1);
    for (const [e, n] of [...byEntity].sort()) console.log(`  ${e.padEnd(12)} ${n} headers`);

    if (posted.length > 0) {
      console.log(`\nABORT: ${posted.length} of these are POSTED to QuickBooks and must not be deleted:`);
      for (const r of posted) console.log(`  #${r.id} ${r.entity} ${r.pay_date} qb_entry_id=${r.qb_entry_id}`);
      process.exitCode = 1;
      return;
    }
    console.log('  none are posted (no qb_entry_id) — safe to remove');

    if (!APPLY) {
      console.log(`\nDry run only. Re-run with --apply to delete ${rows.length} headers and ${totalLines} lines.`);
      return;
    }

    // Re-assert the posted guard inside the DELETE itself, so a row that got posted between the
    // read above and this write still cannot be removed.
    const res = await pool.query(
      `DELETE FROM accounting.payroll_journal_headers
        WHERE to_date(pay_date,'MM/DD/YYYY') BETWEEN $1::date AND $2::date
          AND qb_entry_id IS NULL`,
      [YEAR_START, YEAR_END],
    );
    console.log(`\nDeleted ${res.rowCount} header(s); their lines cascaded.`);

    const { rows: left } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.payroll_journal_headers
        WHERE to_date(pay_date,'MM/DD/YYYY') BETWEEN $1::date AND $2::date`,
      [YEAR_START, YEAR_END],
    );
    console.log(`2025 headers remaining: ${left[0].n}`);
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
