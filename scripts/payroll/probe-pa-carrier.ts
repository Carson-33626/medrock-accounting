/** READ-ONLY: who carries the unmapped PA / SEVERANCE columns in 2026? Decrypts in memory,
 *  prints names + column totals only (same exposure as the panel's unmapped worklist). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { selectSource } from '../../src/lib/payroll/source-select';

async function main(): Promise<void> {
  const rows = await selectSource().fetchRange('2026-01-01', '2026-08-31');
  const hits = new Map<string, Map<string, { dept: string; group: string; dates: Set<string>; total: number }>>();
  for (const row of rows) {
    for (const [col, val] of Object.entries(row.sensitive)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (!/^PA |PA STATE|SEVERANCE/i.test(col)) continue;
      const byPerson = hits.get(col) ?? new Map();
      const p = byPerson.get(row.name) ?? { dept: row.home_department, group: row.pay_group, dates: new Set<string>(), total: 0 };
      p.dates.add(row.pay_date); p.total += val;
      byPerson.set(row.name, p);
      hits.set(col, byPerson);
    }
  }
  for (const [col, people] of hits) {
    console.log(`\ncolumn "${col}":`);
    for (const [name, p] of people) {
      console.log(`  ${name} | ${p.dept} | ${p.group} | ${p.dates.size} pay dates (${[...p.dates].sort().join(', ')}) | total $${p.total.toFixed(2)}`);
    }
  }
  if (hits.size === 0) console.log('no PA/SEVERANCE columns found in 2026 rows');
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
