/**
 * READ-ONLY: cross-check every department (and class) name used by draft lines against the
 * live QB dimensions for that entity. A name that does not resolve fails the post with
 * "no department named X" — the trap that cost TN a post twice ('Ohio Region' vs 'OH Region').
 *
 * SPLIT BY PERIOD LOCK, and that split is the whole point. A closed pay date
 * (pre-04/10/2026, per period-locks.ts) can NEVER post, so unresolved names there block
 * nothing and must never justify a QuickBooks change. The first version of this probe
 * reported both buckets together and made two closed-period-only regions look like real
 * gaps in FL and TN — they were historical rows for reps whose PAY ENTITY changed, not
 * missing departments. Only the BLOCKING section is actionable.
 *   npx tsx scripts/payroll/probe-dept-name-drift.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { qbQueryAll, getConnectionStatus, type Location } from '../../src/lib/quickbooks-multi';
import { isPayrollPeriodComplete } from '../../src/lib/payroll/period-locks';

interface NameId { Id: string; Name?: string; FullyQualifiedName?: string }
interface UsedRow { entity: string; pay_date: string; department_name: string | null; class_name: string | null; n: string; headers: string }
interface Finding { entity: string; what: string; lines: number; dates: Set<string>; headers: Set<string> }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: used } = await pool.query<UsedRow>(
      `SELECT h.entity, h.pay_date, l.department_name, l.class_name, COUNT(*)::text AS n,
              string_agg(DISTINCT l.header_id::text, ',') AS headers
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE h.status <> 'posted'
          AND (l.department_name IS NOT NULL OR l.class_name IS NOT NULL)
        GROUP BY h.entity, h.pay_date, l.department_name, l.class_name
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

    const blocking = new Map<string, Finding>();
    const closed = new Map<string, Finding>();
    for (const r of used) {
      const d = dims.get(r.entity);
      if (!d) continue;
      const deptBad = r.department_name !== null && !d.depts.has(r.department_name);
      const classBad = r.class_name !== null && !d.classes.has(r.class_name);
      if (!deptBad && !classBad) continue;
      const what = [deptBad ? `DEPT '${r.department_name}'` : '', classBad ? `CLASS '${r.class_name}'` : ''].filter(Boolean).join(' + ');
      const bucket = isPayrollPeriodComplete(r.pay_date) ? closed : blocking;
      const key = `${r.entity}¦${what}`;
      let f = bucket.get(key);
      if (!f) { f = { entity: r.entity, what, lines: 0, dates: new Set(), headers: new Set() }; bucket.set(key, f); }
      f.lines += Number(r.n);
      f.dates.add(r.pay_date);
      for (const h of r.headers.split(',')) f.headers.add(h);
    }

    const show = (f: Finding): void => {
      const dates = [...f.dates].sort((a, b) => a.slice(6) + a.slice(0, 5) < b.slice(6) + b.slice(0, 5) ? -1 : 1);
      console.log(`  ${f.entity}: ${f.what} — ${f.lines} lines, ${f.headers.size} headers, ${dates[0]}..${dates[dates.length - 1]}`);
    };

    console.log(`\n=== BLOCKING (open pay dates — these fail a post) : ${blocking.size} ===`);
    for (const f of blocking.values()) show(f);
    if (blocking.size === 0) console.log('  none — every postable draft line resolves against its QB book.');

    console.log(`\n=== CLOSED PERIOD (pre-${'04/10/2026'} — never postable, NOT actionable) : ${closed.size} ===`);
    for (const f of closed.values()) show(f);
    if (closed.size === 0) console.log('  none.');
    if (closed.size > 0) console.log('  Do NOT create these in QuickBooks. They are historical rows, usually a rep whose pay entity changed.');
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
