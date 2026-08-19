/**
 * READ-ONLY: recompute the post route's drift hash for every unposted header in a pay-date
 * range and compare it to the hash stored on the header. Anything reported here will fail a
 * live post with "source changed since draft was built — rebuild the run".
 *
 * Mirrors POST /api/payroll/post exactly: fetchRange(day, day) -> filter to the header's
 * pay_group -> sourceSnapshotHash. A builder that stamps a hash computed over any other row
 * set (e.g. a whole multi-run range) makes every draft it saves permanently unpostable.
 *   npx tsx scripts/payroll/probe-drift-gate.ts 2026-05-01 2026-08-31
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { selectSource } from '../../src/lib/payroll/source-select';
import { sourceSnapshotHash } from '../../src/lib/payroll/store';
import { adpDateToIso } from '../../src/lib/payroll/dates';

interface HeaderRow { id: string; entity: string; pay_date: string; pay_group: string; period_segment: string; status: string; source_snapshot_hash: string | null }

async function main(): Promise<void> {
  const [start, end] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) {
    console.error('usage: tsx scripts/payroll/probe-drift-gate.ts <start YYYY-MM-DD> <end YYYY-MM-DD>');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: headers } = await pool.query<HeaderRow>(
      `SELECT id::text, entity, pay_date, pay_group, period_segment, status, source_snapshot_hash
         FROM accounting.payroll_journal_headers
        WHERE status <> 'posted' AND kind = 'pay_date'
          AND to_date(pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date
        ORDER BY to_date(pay_date, 'MM/DD/YYYY'), entity, id`,
      [start, end],
    );

    // One fetch per distinct pay date, reused across that date's headers.
    const cache = new Map<string, Awaited<ReturnType<ReturnType<typeof selectSource>['fetchRange']>>>();
    let drifted = 0;
    let unkeyed = 0;
    for (const h of headers) {
      const dayIso = adpDateToIso(h.pay_date);
      let dayRows = cache.get(dayIso);
      if (!dayRows) { dayRows = await selectSource().fetchRange(dayIso, dayIso); cache.set(dayIso, dayRows); }
      const runRows = dayRows.filter((r) => r.pay_group === h.pay_group);
      const current = sourceSnapshotHash(runRows);
      if (!h.source_snapshot_hash) { unkeyed += 1; console.log(`  #${h.id} ${h.entity} ${h.pay_date} ${h.pay_group} — NO stored hash (drift gate inert)`); continue; }
      if (current !== h.source_snapshot_hash) {
        drifted += 1;
        console.log(`  #${h.id} ${h.entity} ${h.pay_date} ${h.pay_group} seg='${h.period_segment}' DRIFT stored=${h.source_snapshot_hash.slice(0, 12)} current=${current.slice(0, 12)}`);
      }
    }
    console.log(`\nheaders checked: ${headers.length} | DRIFTED (would fail post): ${drifted} | no stored hash: ${unkeyed}`);
    if (drifted === 0) console.log('Every unposted draft in range passes the drift gate.');
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
