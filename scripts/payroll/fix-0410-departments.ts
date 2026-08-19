/**
 * ONE-OFF prep for the 04/10/2026 TN/TX live post (Barbara via Carson, 2026-08-19):
 *
 * 1. TN naming mismatch: our employee map + draft lines say 'Ohio Region' but the TN
 *    QB book's department is 'OH Region'. Repoint BOTH the map (future drafts) and the
 *    existing #1450/#1451 draft lines (this post) — same class of naming trap as the
 *    FIFO close's F50.
 * 2. TX gap: 'Puerto Rico Region' does not exist in the TX book — create the Department
 *    (name-only dimension record, matching the draft's spelling).
 *
 *   npx tsx scripts/payroll/fix-0410-departments.ts --apply
 *   (without --apply: prints what would change, writes nothing)
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { qbQueryAll, qbPost } from '../../src/lib/quickbooks-multi';

const apply = process.argv.includes('--apply');

interface DeptRow { Id: string; Name?: string; FullyQualifiedName?: string }

async function main(): Promise<void> {
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW'}`);
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    // 1a. Employee map: MedRock TN rows pointing at 'Ohio Region'.
    const { rows: mapRows } = await pool.query<{ id: string; position_id: string }>(
      `SELECT id::text, position_id FROM accounting.payroll_employee_map
       WHERE entity = 'MedRock TN' AND department_name = 'Ohio Region'`,
    );
    console.log(`employee map rows 'Ohio Region' (MedRock TN): ${mapRows.length} — ${mapRows.map((r) => r.position_id).join(', ')}`);

    // 1b. Draft lines on the 4/10 TN headers.
    const { rows: lineRows } = await pool.query<{ header_id: string; n: string }>(
      `SELECT header_id::text, COUNT(*)::text AS n FROM accounting.payroll_journal_lines
       WHERE header_id IN (1450, 1451) AND department_name = 'Ohio Region' GROUP BY header_id`,
    );
    console.log(`draft lines 'Ohio Region' on #1450/#1451: ${lineRows.map((r) => `#${r.header_id}×${r.n}`).join(', ') || 'none'}`);

    // 2. TX department check.
    const txDepts = await qbQueryAll<DeptRow>('MedRock TX', 'Department', '');
    const hasPr = txDepts.some((d) => (d.FullyQualifiedName ?? d.Name) === 'Puerto Rico Region');
    console.log(`TX 'Puerto Rico Region' department exists: ${hasPr}`);

    if (!apply) {
      console.log('\nPREVIEW ONLY — nothing written.');
      return;
    }

    if (mapRows.length > 0) {
      const res = await pool.query(
        `UPDATE accounting.payroll_employee_map SET department_name = 'OH Region', updated_at = now()
         WHERE entity = 'MedRock TN' AND department_name = 'Ohio Region'`,
      );
      console.log(`updated employee map rows: ${res.rowCount}`);
    }
    const res2 = await pool.query(
      `UPDATE accounting.payroll_journal_lines SET department_name = 'OH Region'
       WHERE header_id IN (1450, 1451) AND department_name = 'Ohio Region'`,
    );
    console.log(`updated draft lines: ${res2.rowCount}`);

    if (!hasPr) {
      const created = await qbPost<{ Department: DeptRow }>('MedRock TX', 'department', { Name: 'Puerto Rico Region' });
      console.log(`created TX department: Id ${created.Department.Id} '${created.Department.Name}'`);
    }
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
