/**
 * READ-ONLY (Carson, 2026-08-25, part 5 of the Oanh Nguyen review): Barbara says 2110
 * (Payroll Withholdings) isn't credited properly for her and 1215 (Employee Advances) is
 * mis-mapped. Dump every nonzero ADP column on her rows, per pay date, with the account-map
 * rule(s) that fire for it (entity + cost center MARKET/'*') — so we can see exactly which
 * column books where, and which ones Barbara disputes.
 *
 *   npx tsx scripts/payroll/probe-oanh-columns.ts [name-substring]   (default 'oanh')
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { Entity, SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface RawRow extends Record<string, string> { sensitive_encrypted: string }
interface RuleRow {
  id: string; entity: Entity; adp_column: string; cost_center: string; account_name: string;
  posting_type: 'Debit' | 'Credit'; credit_bucket: string | null; active: boolean;
}

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();

  const namePattern = `%${process.argv[2] ?? 'oanh'}%`;
  const { rows: raw } = await pool.query<RawRow>(
    `SELECT position_id, name, home_department, pay_group, pay_date, row_key, sensitive_encrypted
     FROM source.payroll_history
     WHERE name ILIKE $1
     ORDER BY to_date(pay_date, 'MM/DD/YYYY')`,
    [namePattern],
  );
  console.log(`name filter: ${namePattern} — ${raw.length} rows, people: ${[...new Set(raw.map((r) => `${r.name} (${r.position_id}, ${r.pay_group})`))].join(' | ')}`);

  const { rows: rules } = await pool.query<RuleRow>(
    `SELECT id::text, entity, adp_column, cost_center, account_name, posting_type, credit_bucket, active
     FROM accounting.payroll_account_map WHERE active`,
  );

  const colTotals = new Map<string, number>();
  for (const r of raw) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const ent = entityForPayGroup(r.pay_group);
    const cc = costCenterFor(r.home_department);
    console.log(`\n=== ${r.pay_date}  ${r.pay_group} (${ent ?? '?'})  cc=${cc} ===`);
    for (const [col, val] of Object.entries(s).sort()) {
      if (typeof val !== 'number' || val === 0) continue;
      colTotals.set(col, (colTotals.get(col) ?? 0) + val);
      const matches = rules.filter((x) => x.entity === ent && x.adp_column === col && (x.cost_center === cc || x.cost_center === '*'));
      const ruleTxt = matches.length === 0
        ? '→ UNMAPPED'
        : matches.map((x) => `→ ${x.posting_type} ${x.account_name}${x.credit_bucket ? ` (${x.credit_bucket})` : ''} [cc=${x.cost_center}]`).join('  ');
      console.log(`  ${money(val).padStart(12)}  ${col}  ${ruleTxt}`);
    }
  }

  console.log('\n=== her lifetime totals per column ===');
  for (const [col, v] of [...colTotals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${money(v).padStart(12)}  ${col}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
