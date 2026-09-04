/** READ-ONLY: history-proof the account map. Every sensitive column that ever carried a
 *  nonzero value anywhere in source.payroll_history, diffed against the account map.
 *  Excludes the same non-postable aggregates build-je suppresses (hours, totals, gross pay,
 *  rate amount, taxable bases). Decrypts in memory; prints column names, carriers, totals. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';
import { selectSource } from '../../src/lib/payroll/source-select';

const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());
const isAggregate = (col: string): boolean =>
  /\bHOURS\b|-\s*TOTAL\s*$|^TOTAL\b|^GROSS PAY$|^RATE AMOUNT$/.test(col.trim());

interface ColStat { first: string; last: string; people: Set<string>; groups: Set<string>; total: number; n: number }

async function main(): Promise<void> {
  const range = await getRdsPool().query<{ lo: string; hi: string; n: string }>(
    `SELECT MIN(to_date(pay_date, 'MM/DD/YYYY'))::text AS lo, MAX(to_date(pay_date, 'MM/DD/YYYY'))::text AS hi, COUNT(*)::text AS n
       FROM source.payroll_history`,
  );
  console.log(`history: ${range.rows[0].n} rows, ${range.rows[0].lo} .. ${range.rows[0].hi}`);

  const rows = await selectSource().fetchRange(range.rows[0].lo, range.rows[0].hi);
  console.log(`decrypted ${rows.length} rows`);

  const stats = new Map<string, ColStat>();
  for (const row of rows) {
    for (const [col, val] of Object.entries(row.sensitive)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (isTaxableBase(col) || isAggregate(col)) continue;
      const s = stats.get(col) ?? { first: '9999', last: '0000', people: new Set<string>(), groups: new Set<string>(), total: 0, n: 0 };
      const iso = `${row.pay_date.slice(6, 10)}-${row.pay_date.slice(0, 2)}-${row.pay_date.slice(3, 5)}`;
      if (iso < s.first) s.first = iso;
      if (iso > s.last) s.last = iso;
      s.people.add(row.name); s.groups.add(row.pay_group); s.total += val; s.n++;
      stats.set(col, s);
    }
  }

  const mapped = await getRdsPool().query<{ adp_column: string }>(
    `SELECT DISTINCT adp_column FROM accounting.payroll_account_map WHERE active`,
  );
  const mappedSet = new Set(mapped.rows.map((r) => r.adp_column));

  const missing = [...stats.entries()].filter(([col]) => !mappedSet.has(col));
  missing.sort((a, b) => b[1].last.localeCompare(a[1].last));
  console.log(`\ncolumns with money but NO active rule: ${missing.length} (of ${stats.size} postable columns seen)`);
  for (const [col, s] of missing) {
    console.log(`\n  "${col}"`);
    console.log(`    ${s.first} .. ${s.last} | ${s.n} rows | ${s.people.size} people (${[...s.people].slice(0, 4).join('; ')}${s.people.size > 4 ? '; …' : ''}) | groups ${[...s.groups].join(',')} | total $${s.total.toFixed(2)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
