/**
 * READ-ONLY: pins down meeting item #7. Two questions:
 *   1. Exactly how much OT does MedRock FL's ACCOUN (accounting) cost center carry?
 *      (the wider probe printed whole-column totals, which overstate the ACCOUN slice)
 *   2. What account did the accountants already pick for the neighbouring cost centers'
 *      OT — especially ADMIN, which the seed also omits but which resolves OK live?
 *      That hand-made rule is the precedent for what ACCOUN should map to.
 *   npx tsx scripts/payroll/probe-accoun-overtime.ts
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

const OT_COLUMNS = ['OVERTIME STRAIGHT - EARNING', 'OVERTIME PREMIUM - EARNING'] as const;
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface SrcRow {
  home_department: string | null;
  pay_group: string;
  pay_date: string;
  sensitive_encrypted: string;
}
interface RuleRow {
  entity: string;
  adp_column: string;
  cost_center: string;
  posting_type: string;
  account_name: string;
  is_cogs: boolean;
  memo: string | null;
  active: boolean;
}

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');

  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
  });

  try {
    // ── 1. Per-(entity, cost_center) OT dollars, and how many distinct people ──
    const { rows } = await pool.query<SrcRow>(
      `SELECT home_department, pay_group, pay_date, sensitive_encrypted
         FROM source.payroll_history
        WHERE to_date(pay_date, 'MM/DD/YYYY') BETWEEN '2026-01-01' AND '2026-12-31'`,
    );

    // entity|cc|column -> {total, hits}
    const agg = new Map<string, { total: number; hits: number; payDates: Set<string> }>();
    for (const r of rows) {
      const entity = entityForPayGroup(r.pay_group);
      if (!entity) continue;
      const cc = costCenterFor(r.home_department ?? '');
      const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
      for (const col of OT_COLUMNS) {
        const v = sensitive[col];
        if (typeof v !== 'number' || v === 0) continue;
        const k = `${entity}|${cc}|${col}`;
        const cur = agg.get(k) ?? { total: 0, hits: 0, payDates: new Set<string>() };
        cur.total += v;
        cur.hits += 1;
        cur.payDates.add(r.pay_date);
        agg.set(k, cur);
      }
    }

    console.log('\n=== OT dollars by entity / cost center / column (2026) ===');
    for (const [k, v] of [...agg].sort()) {
      const [entity, cc, col] = k.split('|');
      console.log(
        `  ${entity.padEnd(12)} ${cc.padEnd(7)} ${col.padEnd(28)} ${money(v.total).padStart(13)}  ${String(v.hits).padStart(4)} hits  ${v.payDates.size} pay dates`,
      );
    }

    // ── 2. Every live OT rule, to read the accountants' precedent ─────────────
    const { rows: rules } = await pool.query<RuleRow>(
      `SELECT entity, adp_column, cost_center, posting_type, account_name, is_cogs, memo, active
         FROM accounting.payroll_account_map
        WHERE adp_column = ANY($1)
        ORDER BY entity, adp_column, cost_center`,
      [[...OT_COLUMNS]],
    );

    console.log('\n=== Live OT account-map rules ===');
    for (const r of rules) {
      console.log(
        `  ${r.active ? ' ' : 'x'} ${r.entity.padEnd(12)} ${r.cost_center.padEnd(7)} ${r.adp_column.padEnd(28)} ${r.posting_type.padEnd(6)} cogs=${r.is_cogs ? 'Y' : 'N'}  ${r.account_name}  memo=${JSON.stringify(r.memo)}`,
      );
    }

    // ── 3. Where does ACCOUN's REGULAR pay go? The likely home for its OT too ──
    const { rows: reg } = await pool.query<RuleRow>(
      `SELECT entity, adp_column, cost_center, posting_type, account_name, is_cogs, memo, active
         FROM accounting.payroll_account_map
        WHERE cost_center IN ('ACCOUN','ADMIN')
          AND adp_column = 'REGULAR PAY - EARNING'
        ORDER BY entity, cost_center`,
    );
    console.log('\n=== Where ACCOUN / ADMIN regular pay posts (the precedent for OT) ===');
    for (const r of reg) {
      console.log(
        `  ${r.active ? ' ' : 'x'} ${r.entity.padEnd(12)} ${r.cost_center.padEnd(7)} ${r.posting_type.padEnd(6)} cogs=${r.is_cogs ? 'Y' : 'N'}  ${r.account_name}  memo=${JSON.stringify(r.memo)}`,
      );
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
