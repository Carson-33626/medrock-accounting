/**
 * READ-ONLY: verify item-1 (Barbara) memo-split state.
 *   1. Are ACCOUN / ADMIN regular-pay rules seeded with memos (Accounting/Admin Wages)?
 *   2. Do persisted draft lines on 'Administrative Wages' actually carry those memos, or is the
 *      account lumped into one memo-less line (= stale draft built before the 07-14 memo seed)?
 * Names + counts + totals only. No PII, no writes.
 *   npx tsx scripts/payroll/probe-item1-memo-split.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const f of ['.env.local', '.env.vercel']) {
  try {
    const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // optional env file
  }
}

async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();

  const rules = await pool.query(
    `SELECT entity, cost_center, adp_column, account_name, memo, active
     FROM accounting.payroll_account_map
     WHERE cost_center IN ('ACCOUN','ADMIN') AND adp_column ILIKE 'REGULAR PAY%'
     ORDER BY entity, cost_center`,
  );
  console.log('\n=== ACCOUN / ADMIN regular-pay account-map rules (memo column) ===');
  for (const r of rules.rows) console.log(r);

  const lines = await pool.query(
    `SELECT h.entity, h.pay_date, h.status, l.memo, count(*) AS n, round(sum(l.amount)::numeric,2) AS amount
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE l.account_name ILIKE '%Administrative Wages%'
     GROUP BY h.entity, h.pay_date, h.status, l.memo
     ORDER BY to_date(h.pay_date,'MM/DD/YYYY') DESC, h.entity
     LIMIT 40`,
  );
  console.log('\n=== Draft lines on *Administrative Wages* grouped by memo (recent) ===');
  console.log('(one row per (entity,pay_date,memo) — split drafts show BOTH Admin Wages + Accounting Wages;');
  console.log(' stale drafts show a single blank/na memo lumping the account)');
  for (const r of lines.rows) console.log(r);

  const memoNull = await pool.query(
    `SELECT count(*) FILTER (WHERE l.memo IS NULL OR l.memo = '') AS blank_memo,
            count(*) FILTER (WHERE l.memo = 'Accounting Wages') AS accounting,
            count(*) FILTER (WHERE l.memo = 'Admin Wages') AS admin,
            count(DISTINCT l.header_id) AS drafts_with_this_account
     FROM accounting.payroll_journal_lines l
     WHERE l.account_name ILIKE '%Administrative Wages%'`,
  );
  console.log('\n=== Administrative Wages line memo distribution (all drafts) ===');
  console.log(memoNull.rows[0]);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
