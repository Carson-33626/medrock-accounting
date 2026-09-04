/**
 * READ-ONLY: what accounts hold shipping/packaging spend, and what does the
 * shipment feed actually look like?
 *
 * Proves, before any modelling:
 *   1. the QuickBooks account ids for 1220.30 (and any COGS counterpart) in each
 *      realm — ids differ per company, so they must be resolved, never hardcoded;
 *   2. the 2026 month-end balance on 1220.30 per entity (BalanceSheet, with the
 *      mandatory `start_date` — QuickBooks silently ignores `end_date` without it);
 *   3. the column shape of `source.lifefile_fulfillment`, the shipment feed.
 *
 * Run from web/:  npx tsx scripts/_probe-shipping-accounts.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import {
  qbQueryAll,
  getBalanceSheetInventory,
  type Location,
} from '../src/lib/quickbooks-multi';

const LOCATIONS: readonly Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

/** Month-ends of 2026 through August — the close window under scope. */
const MONTH_ENDS: readonly string[] = [
  '2026-01-31',
  '2026-02-28',
  '2026-03-31',
  '2026-04-30',
  '2026-05-31',
  '2026-06-30',
  '2026-07-31',
  '2026-08-31',
];

interface AccountRow {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
  CurrentBalance?: number;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
}

function looksLikeShipping(a: AccountRow): boolean {
  const num = a.AcctNum ?? '';
  if (num === '1220.30' || num === '5000.30') return true;
  const name = `${a.Name ?? ''} ${a.FullyQualifiedName ?? ''}`.toLowerCase();
  return (
    name.includes('shipping') ||
    name.includes('packag') ||
    name.includes('mailer') ||
    name.includes('freight')
  );
}

async function probeAccounts(): Promise<void> {
  console.log('=== 1. Shipping / packaging accounts, per realm ===\n');
  for (const location of LOCATIONS) {
    try {
      const accounts = await qbQueryAll<AccountRow>(location, 'Account', '');
      const hits = accounts.filter(looksLikeShipping);
      console.log(`${location} — ${accounts.length} accounts, ${hits.length} shipping-ish:`);
      for (const a of hits) {
        console.log(
          `   ${(a.AcctNum ?? '—').padEnd(9)} id=${a.Id.padEnd(12)} ` +
            `${(a.FullyQualifiedName ?? a.Name ?? '').padEnd(52)} ` +
            `${(a.AccountType ?? '').padEnd(22)} ` +
            `${a.Active === false ? '(INACTIVE) ' : ''}` +
            `bal=${(a.CurrentBalance ?? 0).toFixed(2)}`,
        );
      }
      console.log('');
    } catch (error) {
      console.log(`${location}: UNREACHABLE — ${String(error)}\n`);
    }
  }
}

async function probeBalances(): Promise<void> {
  console.log('=== 2. 1220.30 balance at each 2026 month-end (BalanceSheet, Accrual) ===\n');
  console.log(`${'month-end'.padEnd(12)} ${'FL'.padStart(14)} ${'TN'.padStart(14)} ${'TX'.padStart(14)}`);
  for (const asOf of MONTH_ENDS) {
    const cells: string[] = [];
    for (const location of LOCATIONS) {
      const breakdown = await getBalanceSheetInventory(location, asOf);
      if (breakdown === null) {
        cells.push('unavailable');
        continue;
      }
      const row = breakdown.accounts.find((a) => a.name.startsWith('1220.30'));
      cells.push(row === undefined ? 'absent' : row.value.toFixed(2));
    }
    console.log(
      `${asOf.padEnd(12)} ${cells[0].padStart(14)} ${cells[1].padStart(14)} ${cells[2].padStart(14)}`,
    );
  }
  console.log('');
}

async function probeFulfillmentShape(): Promise<void> {
  console.log('=== 3. source.lifefile_fulfillment shape ===\n');
  const pool = getRdsPool();
  const { rows } = await pool.query<ColumnRow>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'source' AND table_name = 'lifefile_fulfillment'
     ORDER BY ordinal_position`,
  );
  if (rows.length === 0) {
    console.log('   table not found in information_schema — check the name.\n');
    return;
  }
  for (const r of rows) console.log(`   ${r.column_name.padEnd(28)} ${r.data_type}`);
  console.log('');

  const sample = await pool.query<{ keys: string[] }>(
    `SELECT array_agg(DISTINCT k ORDER BY k) AS keys
     FROM (SELECT row_data FROM source."lifefile_fulfillment" LIMIT 200) s,
          LATERAL jsonb_object_keys(s.row_data) AS k`,
  );
  const keys = sample.rows[0]?.keys ?? [];
  if (keys.length > 0) {
    console.log(`   row_data keys (${keys.length}):`);
    for (const k of keys) console.log(`     - ${k}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  await probeAccounts();
  await probeBalances();
  try {
    await probeFulfillmentShape();
  } catch (error) {
    console.log(`RDS unreachable: ${String(error)}\n`);
  }
  await getRdsPool().end().catch(() => undefined);
}

void main();
