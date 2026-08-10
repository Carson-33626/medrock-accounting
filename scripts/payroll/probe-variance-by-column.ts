/**
 * READ-ONLY: which ADP column is responsible for a run's debit/credit variance?
 *
 * MedRock FL shows a variance of EXACTLY $2.00 on nine separate 2026 pay dates (01/02, 01/16,
 * 01/30, 02/13, 02/27, 03/27, 04/10, 04/24, 05/08). A repeating round number across unrelated
 * pay periods is a systematic mapping fault, not rounding — and it matters beyond the cosmetics:
 * splitStraddle refuses to split an unbalanced draft, so every one of those FL runs posts its
 * whole month-straddling period into a single month.
 *
 * For each column this replays resolveLine exactly as buildJournal does, then reports the net
 * (debit - credit) each column contributes. A balanced column nets zero; the culprit is whatever
 * nets to the run's variance.
 *   npx tsx scripts/payroll/probe-variance-by-column.ts "MedRock FL" 04/10/2026
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { resolveLine } from '../../src/lib/payroll/mapping';
import type { AccountMapRule, EmployeeMapRule, PayrollRow, SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const PLAINTEXT_COLS = [
  'position_id', 'name', 'status', 'worker_classification', 'home_department', 'location', 'pay_date',
  'pay_num', 'pay_frequency', 'pay_group', 'pay_type', 'period_start_date', 'period_end_date',
  'processed_as', 'rate_type', 'sui_sdi_tax_code', 'row_key', 'updated_at',
] as const;

const isTaxableBase = (col: string): boolean => /TAXABLE\s*$/.test(col.trim());
const isReportAggregateColumn = (col: string): boolean =>
  /\bHOURS\b|-\s*TOTAL\s*$|^TOTAL\b|^GROSS PAY$|^RATE AMOUNT$/.test(col.trim());

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const wantEntity = process.argv[2] ?? 'MedRock FL';
  const wantPayDate = process.argv[3] ?? '04/10/2026';

  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
    connectionTimeoutMillis: 30_000,
  });

  try {
    const { rows: raw } = await pool.query<Record<string, string>>(
      `SELECT ${PLAINTEXT_COLS.join(', ')}, sensitive_encrypted
         FROM source.payroll_history WHERE pay_date = $1`,
      [wantPayDate],
    );

    const { rows: acct } = await pool.query<{
      entity: string; adp_column: string; cost_center: string; account_name: string;
      posting_type: string; is_cogs: boolean; credit_bucket: string | null; memo: string | null; active: boolean;
    }>(`SELECT entity, adp_column, cost_center, account_name, posting_type, is_cogs, credit_bucket, memo, active
          FROM accounting.payroll_account_map WHERE entity = $1 AND active`, [wantEntity]);

    const accountMap: AccountMapRule[] = acct.map((a) => ({
      entity: a.entity as AccountMapRule['entity'],
      adpColumn: a.adp_column,
      costCenter: a.cost_center,
      accountName: a.account_name,
      postingType: a.posting_type as AccountMapRule['postingType'],
      isCogs: a.is_cogs,
      creditBucket: a.credit_bucket as AccountMapRule['creditBucket'],
      active: a.active,
      memo: a.memo,
    }));

    const { rows: emp } = await pool.query<{
      entity: string; position_id: string; department_name: string | null; class_name: string | null;
      cogs_override: boolean | null; active: boolean;
    }>(`SELECT entity, position_id, department_name, class_name, cogs_override, active
          FROM accounting.payroll_employee_map WHERE entity = $1 AND active`, [wantEntity]);
    const employeeMap: EmployeeMapRule[] = emp.map((e) => ({
      entity: e.entity as EmployeeMapRule['entity'],
      positionId: e.position_id,
      departmentName: e.department_name,
      className: e.class_name,
      cogsOverride: e.cogs_override,
      active: e.active,
    }));

    // column -> net (debit - credit) contribution, plus how it resolved
    // Per-employee net, to localise the imbalance to a person and then to their columns.
    const perRow = new Map<string, { d: number; c: number; cc: string }>();

    const net = new Map<string, { debit: number; credit: number; value: number; unmapped: boolean; suppressed: boolean }>();

    for (const r of raw) {
      if (entityForPayGroup(r.pay_group) !== wantEntity) continue;
      const base: Record<string, string> = {};
      for (const c of PLAINTEXT_COLS) base[c] = r[c] ?? '';
      const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const row = { ...(base as unknown as Omit<PayrollRow, 'sensitive'>), sensitive } as PayrollRow;

      const rowKey = String(r.position_id);
      const rowAgg = perRow.get(rowKey) ?? { d: 0, c: 0, cc: String(r.home_department ?? '') };
      for (const [col, val] of Object.entries(sensitive)) {
        if (typeof val !== 'number' || val === 0) continue;
        if (isTaxableBase(col)) continue;
        const cur = net.get(col) ?? { debit: 0, credit: 0, value: 0, unmapped: false, suppressed: false };
        cur.value += val;
        const res = resolveLine(row, col, accountMap, employeeMap);
        if ('unmapped' in res) {
          cur.unmapped = true;
          cur.suppressed = isReportAggregateColumn(col);
        } else {
          for (const t of res.targets) {
            if (t.postingType === 'Debit') { cur.debit += val; rowAgg.d += val; }
            else { cur.credit += val; rowAgg.c += val; }
          }
        }
        net.set(col, cur);
      }
      perRow.set(rowKey, rowAgg);
    }

    let totalD = 0;
    let totalC = 0;
    const offenders: Array<[string, number, { debit: number; credit: number; value: number; unmapped: boolean; suppressed: boolean }]> = [];
    const unmappedCols: Array<[string, number, { debit: number; credit: number; value: number; unmapped: boolean; suppressed: boolean }]> = [];
    for (const [col, v] of net) {
      totalD += v.debit;
      totalC += v.credit;
      const delta = round2(v.debit - v.credit);
      // An UNMAPPED column contributes nothing to either side, so its delta is zero and a
      // "non-zero delta" filter hides it — which is precisely where a missing credit hides.
      // A deduction that never got a credit line is the classic cause of a stubborn variance,
      // so these are collected separately and always shown.
      if (v.unmapped && !v.suppressed) unmappedCols.push([col, delta, v]);
      else if (delta !== 0) offenders.push([col, delta, v]);
    }
    offenders.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

    console.log(`\n${wantEntity} ${wantPayDate}`);
    console.log(`  debits ${money(round2(totalD))}  credits ${money(round2(totalC))}  variance ${money(round2(totalD - totalC))}\n`);
    console.log(`  UNMAPPED columns carrying dollars — ${unmappedCols.length} (each one drops a line from the JE):`);
    if (unmappedCols.length === 0) console.log('    (none)');
    for (const [col, , v] of unmappedCols) {
      console.log(`    ${money(round2(v.value)).padStart(14)}  ${col}`);
    }

    // Localise the imbalance to a person. Every employee's own debits should equal their own
    // credits (gross = net + deductions, and each employer cost debits an expense while crediting
    // a liability), so anyone with a non-zero net is carrying the fault.
    const skewed = [...perRow.entries()]
      .map(([pos, v]) => ({ pos, delta: round2(v.d - v.c), cc: v.cc }))
      .filter((x) => x.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    console.log(`\n  Employees whose own debits != credits — ${skewed.length} (position id only, no names):`);
    if (skewed.length === 0) console.log('    (none — the imbalance is not attributable to a single person)');
    for (const x of skewed) {
      console.log(`    ${money(x.delta).padStart(12)}  position ${x.pos}  home_department=${JSON.stringify(x.cc)}`);
    }

    console.log('\n  Mapped columns and their direction:');
    for (const [col, delta, v] of offenders) {
      console.log(`    ${money(delta).padStart(14)}  ${col.padEnd(46)} [D ${money(round2(v.debit))} / C ${money(round2(v.credit))}]`);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
