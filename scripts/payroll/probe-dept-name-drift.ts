/**
 * READ-ONLY: cross-check every department (and class) name used by UNPOSTED draft
 * lines against the live QB dimensions for that entity. Anything printed here will
 * fail the post with "no department named X" / "no class named X" — the same trap
 * as TN's 'Ohio Region' vs 'OH Region'.
 *   npx tsx scripts/payroll/probe-dept-name-drift.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { qbQueryAll, getConnectionStatus, type Location } from '../../src/lib/quickbooks-multi';

interface NameId { Id: string; Name?: string; FullyQualifiedName?: string }
interface UsedRow { entity: string; department_name: string | null; class_name: string | null; n: string; headers: string }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: used } = await pool.query<UsedRow>(
      `SELECT h.entity, l.department_name, l.class_name, COUNT(*)::text AS n,
              string_agg(DISTINCT l.header_id::text, ',' ORDER BY l.header_id::text) AS headers
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE h.status <> 'posted'
          AND (l.department_name IS NOT NULL OR l.class_name IS NOT NULL)
        GROUP BY h.entity, l.department_name, l.class_name
        ORDER BY h.entity, l.department_name, l.class_name`,
    );

    const status = await getConnectionStatus();
    const entities = [...new Set(used.map((r) => r.entity))].filter((e): e is Location => Boolean(status[e as Location]));

    const dims = new Map<string, { depts: Set<string>; classes: Set<string> }>();
    for (const entity of entities) {
      const [depts, classes] = await Promise.all([
        qbQueryAll<NameId>(entity, 'Department', ''), qbQueryAll<NameId>(entity, 'Class', ''),
      ]);
      dims.set(entity, {
        depts: new Set(depts.map((d) => d.FullyQualifiedName ?? d.Name ?? '')),
        classes: new Set(classes.map((c) => c.FullyQualifiedName ?? c.Name ?? '')),
      });
    }

    let bad = 0;
    for (const r of used) {
      const d = dims.get(r.entity);
      if (!d) continue;
      const deptBad = r.department_name !== null && !d.depts.has(r.department_name);
      const classBad = r.class_name !== null && !d.classes.has(r.class_name);
      if (!deptBad && !classBad) continue;
      bad += 1;
      const what = [deptBad ? `DEPT '${r.department_name}'` : '', classBad ? `CLASS '${r.class_name}'` : ''].filter(Boolean).join(' + ');
      console.log(`  ${r.entity}: ${what} — ${r.n} lines on headers ${r.headers}`);
    }
    console.log(bad === 0 ? '\nNo dimension drift: every unposted draft line resolves against its QB book.' : `\n${bad} drifted name group(s) — each blocks its post.`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
