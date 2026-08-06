/**
 * Read-only probe: which draft headers carry non-generated lines (origin
 * 'manual' / 'inter_entity')? A build-range rerun deletes+reinserts a header's
 * lines with generated-only output, so any header listed here would lose them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();

  const byOrigin = await pool.query(
    `SELECT origin, count(*) AS lines, count(DISTINCT header_id) AS headers
       FROM accounting.payroll_journal_lines GROUP BY origin ORDER BY origin`,
  );
  console.log('lines by origin:');
  for (const r of byOrigin.rows) console.log(JSON.stringify(r));

  const headers = await pool.query(
    `SELECT h.id, h.entity, h.pay_date, h.pay_group, h.period_segment, h.status,
            count(*) FILTER (WHERE l.origin <> 'generated') AS non_generated_lines
       FROM accounting.payroll_journal_headers h
       JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
      GROUP BY h.id, h.entity, h.pay_date, h.pay_group, h.period_segment, h.status
     HAVING count(*) FILTER (WHERE l.origin <> 'generated') > 0
      ORDER BY h.entity, h.pay_date`,
  );
  console.log(`\nheaders with non-generated lines: ${headers.rowCount}`);
  for (const r of headers.rows) console.log(JSON.stringify(r));

  const posted = await pool.query(
    `SELECT status, count(*) AS n FROM accounting.payroll_journal_headers GROUP BY status ORDER BY status`,
  );
  console.log('\nheaders by status:');
  for (const r of posted.rows) console.log(JSON.stringify(r));

  await pool.end();
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
