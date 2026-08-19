/**
 * TN naming trap, repointed EVERYWHERE (2026-08-19).
 *
 * MedRock TN's QB book calls the Ohio department 'OH Region'. Our data said
 * 'Ohio Region'. The employee map was already repointed, and fix-0410-departments.ts
 * repointed the draft lines on headers #1450/#1451 — but ONLY those two, so every
 * other TN draft built before the map fix still carries 'Ohio Region' and fails the
 * post with "no department named Ohio Region".
 *
 * This is a rename of a dimension REFERENCE on unposted draft lines. It does not
 * touch QuickBooks, and it must NOT create an 'Ohio Region' department there —
 * that would duplicate 'OH Region' and split Ohio reporting in two.
 *
 *   npx tsx scripts/payroll/fix-ohio-region-all.ts            (preview, writes nothing)
 *   npx tsx scripts/payroll/fix-ohio-region-all.ts --apply
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const apply = process.argv.includes('--apply');

interface HeaderRow { header_id: string; entity: string; pay_date: string; status: string; n: string }

async function main(): Promise<void> {
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW'}`);
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    // Guard: only ever touch lines on headers that are not already posted.
    const { rows: before } = await pool.query<HeaderRow>(
      `SELECT l.header_id::text, h.entity, h.pay_date::text, h.status, COUNT(*)::text AS n
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = 'Ohio Region' AND h.entity = 'MedRock TN' AND h.status <> 'posted'
        GROUP BY l.header_id, h.entity, h.pay_date, h.status
        ORDER BY h.pay_date, l.header_id`,
    );
    const totalLines = before.reduce((s, r) => s + Number(r.n), 0);
    console.log(`headers to repoint: ${before.length} (${totalLines} lines)`);
    for (const r of before) console.log(`  #${r.header_id} ${r.entity} ${r.pay_date} status=${r.status} lines=${r.n}`);

    const { rows: posted } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = 'Ohio Region' AND h.status = 'posted'`,
    );
    console.log(`POSTED lines left untouched: ${posted[0]?.n ?? '0'}`);

    if (!apply) { console.log('\nPREVIEW ONLY — nothing written.'); return; }

    const res = await pool.query(
      `UPDATE accounting.payroll_journal_lines l
          SET department_name = 'OH Region'
         FROM accounting.payroll_journal_headers h
        WHERE h.id = l.header_id
          AND l.department_name = 'Ohio Region'
          AND h.entity = 'MedRock TN'
          AND h.status <> 'posted'`,
    );
    console.log(`updated draft lines: ${res.rowCount}`);

    const { rows: after } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = 'Ohio Region' AND h.entity = 'MedRock TN' AND h.status <> 'posted'`,
    );
    console.log(`remaining unposted 'Ohio Region' lines: ${after[0]?.n ?? '?'} (expect 0)`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
