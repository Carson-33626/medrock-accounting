/**
 * READ-ONLY: establish the REAL cost center behind the FMLA - EARNING column before repairing
 * the two dead rules (ids 5031/5032) that were saved with cost_center = 'MedRock FL'.
 *
 * The screenshot of Barbara's 2026-08-06 attempt shows she picked
 * 'COGS - Payroll Expense:COGS - Pharmacists Wages', which implies PHARM — but that is an
 * inference from a picture, and writing a GL mapping off an inference is how the original bug
 * happened. This reads the actual payroll rows.
 *   npx tsx scripts/payroll/probe-fmla.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface SrcRow { home_department: string | null; pay_group: string; pay_date: string; sensitive_encrypted: string }
interface RuleRow { id: number; entity: string; adp_column: string; cost_center: string; posting_type: string; account_name: string; is_cogs: boolean; credit_bucket: string | null; memo: string | null; active: boolean }

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });

  try {
    const { rows } = await pool.query<SrcRow>(
      `SELECT home_department, pay_group, pay_date, sensitive_encrypted
         FROM source.payroll_history
        WHERE to_date(pay_date,'MM/DD/YYYY') BETWEEN '2025-01-01' AND '2026-12-31'`,
    );

    // entity|cc -> {total, hits, payDates}
    const agg = new Map<string, { total: number; hits: number; dates: Set<string> }>();
    for (const r of rows) {
      const entity = entityForPayGroup(r.pay_group);
      if (!entity) continue;
      const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      const v = s['FMLA - EARNING'];
      if (typeof v !== 'number' || v === 0) continue;
      const k = `${entity}|${costCenterFor(r.home_department ?? '')}`;
      const cur = agg.get(k) ?? { total: 0, hits: 0, dates: new Set<string>() };
      cur.total += v; cur.hits += 1; cur.dates.add(r.pay_date);
      agg.set(k, cur);
    }

    console.log('\n=== FMLA - EARNING actual rows (2025-2026) ===');
    if (agg.size === 0) console.log('  none');
    for (const [k, v] of [...agg].sort()) {
      const [entity, cc] = k.split('|');
      console.log(`  ${entity.padEnd(12)} cc=${cc.padEnd(7)} ${money(v.total).padStart(12)}  ${v.hits} hits  dates: ${[...v.dates].sort().join(', ')}`);
    }

    const { rows: rules } = await pool.query<RuleRow>(
      `SELECT id, entity, adp_column, cost_center, posting_type, account_name, is_cogs, credit_bucket, memo, active
         FROM accounting.payroll_account_map
        WHERE adp_column ILIKE '%FMLA%' ORDER BY id`,
    );
    console.log('\n=== existing FMLA rules ===');
    for (const r of rules) {
      console.log(`  id=${r.id} ${r.active ? 'active  ' : 'inactive'} ${r.entity} cc=${JSON.stringify(r.cost_center)} ${r.posting_type} cogs=${r.is_cogs ? 'Y' : 'N'} bucket=${r.credit_bucket ?? '-'} -> ${r.account_name}`);
    }

    // What the other * - EARNING wage columns do for the SAME cost center, as the precedent.
    const { rows: peers } = await pool.query<RuleRow>(
      `SELECT id, entity, adp_column, cost_center, posting_type, account_name, is_cogs, credit_bucket, memo, active
         FROM accounting.payroll_account_map
        WHERE entity = 'MedRock FL' AND adp_column IN ('REGULAR PAY - EARNING','PTO - EARNING','HOLIDAY PAY - EARNING')
          AND active ORDER BY adp_column, cost_center`,
    );
    console.log('\n=== precedent: how FL maps other wage-earning columns ===');
    for (const r of peers) {
      console.log(`  ${r.adp_column.padEnd(24)} cc=${r.cost_center.padEnd(7)} ${r.posting_type} cogs=${r.is_cogs ? 'Y' : 'N'} -> ${r.account_name}  memo=${JSON.stringify(r.memo)}`);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
