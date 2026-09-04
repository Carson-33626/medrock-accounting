/** READ-ONLY: R-FL2 phase-2 follow-up. Recompose FL 2020 (Employee Garnishment Liability, using
 * the correct ADP columns found by sweep-R-FL2-key-discovery.ts — CHILD PAYMENTS / CHILD
 * PAYMENTS - ER / SUPPORT ORDER - TOTAL, not "GARNISH"/"CREDITOR GARNISHMENT" which R-FL's prior
 * pass searched and found nothing) and FL 2117 (Puerto Rico Payroll Liabilities, adding the six
 * employer-side PR STATE ER columns R-FL's prior pass deliberately excluded). Full population,
 * all source.payroll_history rows, not a sample.
 *    npx tsx scripts/payroll/sweep-R-FL2-liability-recompose.ts */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface RawRow { position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const toISO = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '9999-99-99';
};

const CHILD_SUPPORT_COLS = ['CHILD PAYMENTS', 'CHILD PAYMENTS - ER', 'SUPPORT ORDER - TOTAL'];
const PR_EE_COLS = ['PR STATE - EE INCOME TAX', 'PR STATE - DISABILITY INSURANCE  EE', 'PR STATE - MEDICARE  EE', 'PR STATE - SOCIAL SECURITY  EE'];
const PR_ER_COLS = ['PR STATE - DISABILITY INSURANCE  ER', 'PR STATE - MEDICARE  ER', 'PR STATE - MEDICARE  ER__123', 'PR STATE - SOCIAL SECURITY  ER', 'PR STATE - UNEMPLOYMENT INSURANCE ER'];
const PTO_USAGE_COLS = ['PTO - EARNING', 'PTO CASHOUT - EARNING'];

interface Bucket { cum: number; july: number; hits: number; byMonth: Record<string, number> }
const mk = (): Bucket => ({ cum: 0, july: 0, hits: 0, byMonth: {} });

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();
  const { rows } = await pool.query<RawRow>(
    `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history`,
  );
  console.log(`Total rows pulled: ${rows.length}`);

  const child = mk();
  const prEe = mk();
  const prEr = mk();
  const ptoUsage = mk();
  const childHitsByDate = new Map<string, { name: string; col: string; val: number }[]>();

  for (const r of rows) {
    if (entityForPayGroup(r.pay_group ?? '') !== 'MedRock FL') continue;
    const iso = toISO(r.pay_date ?? '');
    if (iso > '2026-07-31') continue;
    const isJuly = iso >= '2026-07-01' && iso <= '2026-07-31';
    const month = iso.slice(0, 7);
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const [col, val] of Object.entries(s)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (CHILD_SUPPORT_COLS.includes(col)) {
        child.cum += val; child.hits++; child.byMonth[month] = (child.byMonth[month] ?? 0) + val;
        if (isJuly) child.july += val;
        if (!childHitsByDate.has(iso)) childHitsByDate.set(iso, []);
        childHitsByDate.get(iso)!.push({ name: r.name, col, val });
      }
      if (PR_EE_COLS.includes(col)) {
        prEe.cum += val; prEe.hits++; prEe.byMonth[month] = (prEe.byMonth[month] ?? 0) + val;
        if (isJuly) prEe.july += val;
      }
      if (PR_ER_COLS.includes(col)) {
        prEr.cum += val; prEr.hits++; prEr.byMonth[month] = (prEr.byMonth[month] ?? 0) + val;
        if (isJuly) prEr.july += val;
      }
      if (PTO_USAGE_COLS.includes(col)) {
        ptoUsage.cum += val; ptoUsage.hits++; ptoUsage.byMonth[month] = (ptoUsage.byMonth[month] ?? 0) + val;
        if (isJuly) ptoUsage.july += val;
      }
    }
  }

  console.log('\n=== FL 2020 Employee Garnishment Liability — Child Support columns, cumulative through 07/31/2026 ===');
  console.log(`cum=${money(child.cum)} july=${money(child.july)} hits=${child.hits}`);
  console.log('By month:', Object.entries(child.byMonth).sort().map(([m, v]) => `${m}=${money(v)}`).join(', '));

  console.log('\n=== FL 2117 Puerto Rico Payroll Liabilities — EE-side PR STATE columns, cumulative through 07/31/2026 ===');
  console.log(`cum=${money(prEe.cum)} july=${money(prEe.july)} hits=${prEe.hits}`);
  console.log('By month:', Object.entries(prEe.byMonth).sort().map(([m, v]) => `${m}=${money(v)}`).join(', '));

  console.log('\n=== FL 2117 Puerto Rico Payroll Liabilities — ER-side PR STATE columns, cumulative through 07/31/2026 ===');
  console.log(`cum=${money(prEr.cum)} july=${money(prEr.july)} hits=${prEr.hits}`);
  console.log('By month:', Object.entries(prEr.byMonth).sort().map(([m, v]) => `${m}=${money(v)}`).join(', '));

  console.log('\n=== FL 2135 Accrued PTO Liability — usage-side (PTO - EARNING + PTO CASHOUT - EARNING), by month, April-July gap sizing ===');
  console.log(`cum=${money(ptoUsage.cum)} july=${money(ptoUsage.july)} hits=${ptoUsage.hits}`);
  console.log('By month:', Object.entries(ptoUsage.byMonth).sort().map(([m, v]) => `${m}=${money(v)}`).join(', '));
  const aprJul = ['2026-04', '2026-05', '2026-06', '2026-07'].reduce((s, m) => s + (ptoUsage.byMonth[m] ?? 0), 0);
  console.log(`April-July 2026 usage-side total (post-process-lapse window): ${money(aprJul)}`);

  console.log('\n=== FL Child Support hits by pay date (name + column + amount) ===');
  for (const [d, hits] of [...childHitsByDate.entries()].sort()) {
    for (const h of hits) console.log(`  ${d} | ${h.name} | ${h.col} | ${money(h.val)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
