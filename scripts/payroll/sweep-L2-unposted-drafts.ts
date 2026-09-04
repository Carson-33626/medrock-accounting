/**
 * READ-ONLY (books sweep L2, 2026-09-03), Q5: unposted payroll JE draft census — count and
 * dollar total per entity and per pay date, whether a POSTED header exists for the same
 * entity+pay_date+pay_group (double-post risk if the app tries to post an unposted draft
 * whose pay date was already posted by hand), and the overall status census (K19).
 *
 *   npx tsx scripts/payroll/sweep-L2-unposted-drafts.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const connectionString = process.env.RDS_DATABASE_URL;
if (!connectionString) throw new Error('RDS_DATABASE_URL not set');

interface OutRow {
  id: number; entity: string; payDate: string; payGroup: string; status: string; kind: string;
  totalDebits: number; hasPostedSibling: boolean;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: RDS_SSL });

  console.log('=== HEADER STATUS CENSUS (all entities, all kinds) ===');
  const status = await pool.query<{ entity: string; status: string; n: string }>(
    `SELECT entity, status, count(*)::text AS n
     FROM accounting.payroll_journal_headers GROUP BY 1, 2 ORDER BY 1, 3::int DESC`,
  );
  for (const r of status.rows) console.log(`  ${r.entity.padEnd(11)} ${r.status.padEnd(14)} ${r.n}`);

  console.log('\n=== Q5: unposted (status <> posted) headers, per entity per pay date, kind <> allocation ===');
  const { rows } = await pool.query<{
    id: number; entity: string; pay_date: string; pay_group: string; status: string; kind: string; total_debits: string;
  }>(
    `SELECT id, entity, pay_date, pay_group, status, kind, total_debits::text
     FROM accounting.payroll_journal_headers
     WHERE status <> 'posted' AND kind <> 'allocation'
     ORDER BY entity, to_date(pay_date, 'MM/DD/YYYY')`,
  );

  const out: OutRow[] = [];
  const byEntity = new Map<string, { n: number; total: number }>();
  for (const r of rows) {
    // Double-post risk: is there ALSO a posted header for the same entity+pay_date+pay_group?
    const { rowCount } = await pool.query(
      `SELECT 1 FROM accounting.payroll_journal_headers
       WHERE entity = $1 AND pay_date = $2 AND pay_group = $3 AND status = 'posted' LIMIT 1`,
      [r.entity, r.pay_date, r.pay_group],
    );
    const hasPostedSibling = (rowCount ?? 0) > 0;
    const td = Number(r.total_debits);
    const agg = byEntity.get(r.entity) ?? { n: 0, total: 0 };
    agg.n++; agg.total += td;
    byEntity.set(r.entity, agg);
    out.push({ id: r.id, entity: r.entity, payDate: r.pay_date, payGroup: r.pay_group, status: r.status, kind: r.kind, totalDebits: td, hasPostedSibling });
    console.log(`  id=${String(r.id).padEnd(6)} ${r.entity.padEnd(11)} ${r.pay_date.padEnd(11)} ${r.pay_group.padEnd(6)} ${r.status.padEnd(12)} ${r.kind.padEnd(10)} $${td.toFixed(2).padStart(11)}${hasPostedSibling ? '  *** DOUBLE-POST RISK: a POSTED header already exists for this entity+pay_date+pay_group ***' : ''}`);
  }

  console.log('\n=== Q5 summary: unposted drafts per entity ===');
  for (const [entity, agg] of [...byEntity].sort()) console.log(`  ${entity.padEnd(11)} ${agg.n} drafts  $${agg.total.toFixed(2)}`);
  const doublePost = out.filter((o) => o.hasPostedSibling);
  console.log(`\n  DOUBLE-POST-RISK rows: ${doublePost.length}`);

  const outPath = 'C:/Users/Carson.D/AppData/Local/Temp/claude/C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics/6a486b3c-fdc7-4fb1-b5d1-161814adc246/scratchpad/L2/unposted-drafts.json';
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\ncached ${out.length} rows -> ${outPath}`);

  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
