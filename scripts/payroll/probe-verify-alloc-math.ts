/**
 * READ-ONLY part 2: does the Allocate family actually produce correct JE output?
 *
 *  (a) Dumps every saved 'attention' (passthrough / unknown) line by class + holder +
 *      counterparty + account with dollar totals — this is the "Allocate to TX/TN/FL"
 *      coding Barbara asked about.
 *  (b) Re-runs buildMonthEndAllocation() over each month's SAVED pool + SAVED shares and
 *      diffs the result line-for-line against what is actually stored in
 *      accounting.payroll_journal_lines — proving the persisted JE matches the generator.
 *  (c) Traces the 'Payroll Processing Fees' allocation dollars back to their pool source, to
 *      confirm the child-support fee is NOT what is being split.
 *
 * No writes. No PII printed.
 *   npx tsx scripts/payroll/probe-verify-alloc-math.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';
import type { PoolLine } from '../../src/lib/payroll/qb-pool';
import type { EomEntity } from '../../src/lib/payroll/revenue-rule';
import type { Entity, JournalLine } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const hdr = (s: string): void => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

interface RevenueSnapshot { test: { month: string; income: Record<EomEntity, number> }; shares: Record<EomEntity, number> }
interface RunRow { month: string; pool: PoolLine[]; revenue: RevenueSnapshot; attention: PoolLine[] }
interface DbLineRow {
  entity: Entity; posting_type: 'Debit' | 'Credit'; amount: string; account_name: string;
  memo: string | null; origin: string;
}

/** Canonical key for comparing a generated line to a stored one (order-independent). */
const lineKey = (entity: string, posting: string, amount: number, account: string, memo: string): string =>
  [entity, posting, amount.toFixed(2), account, memo].join('¦');

async function attention(pool: Pool): Promise<void> {
  hdr('(a) "Allocate to FL/TN/TX" — the passthrough / unknown attention bucket');

  const { rows } = await pool.query<RunRow>(
    `SELECT month, pool, revenue, attention FROM accounting.payroll_eom_runs ORDER BY month`,
  );
  for (const run of rows) {
    console.log(`\n--- ${run.month} — ${run.attention.length} attention line(s) ---`);
    const byRule = new Map<string, { n: number; amt: number }>();
    const byClass = new Map<string, { n: number; amt: number }>();
    const byAccount = new Map<string, { n: number; amt: number }>();
    for (const l of run.attention) {
      const rk = `rule=${l.rule}`;
      const rg = byRule.get(rk) ?? { n: 0, amt: 0 }; rg.n++; rg.amt += l.amount; byRule.set(rk, rg);
      const ck = `${l.entity.padEnd(14)} class=${String(l.className).padEnd(22)} dept=${String(l.departmentName).padEnd(16)} rule=${l.rule.padEnd(12)} -> ${l.counterparty ?? '(none)'}`;
      const cg = byClass.get(ck) ?? { n: 0, amt: 0 }; cg.n++; cg.amt += l.amount; byClass.set(ck, cg);
      const ak = `${l.entity} | ${l.accountName}`;
      const ag = byAccount.get(ak) ?? { n: 0, amt: 0 }; ag.n++; ag.amt += l.amount; byAccount.set(ak, ag);
    }
    for (const [k, g] of [...byRule].sort()) console.log(`  ${k.padEnd(20)} lines=${String(g.n).padStart(4)} ${money(g.amt).padStart(15)}`);
    console.log('  by holder x class x target:');
    for (const [k, g] of [...byClass].sort()) console.log(`    ${k}  lines=${String(g.n).padStart(4)} ${money(g.amt).padStart(15)}`);
    console.log('  top accounts stuck in attention:');
    for (const [k, g] of [...byAccount].sort((a, b) => Math.abs(b[1].amt) - Math.abs(a[1].amt)).slice(0, 12)) {
      console.log(`    ${k.padEnd(62)} lines=${String(g.n).padStart(4)} ${money(g.amt).padStart(15)}`);
    }
  }
}

async function mathCheck(pool: Pool): Promise<void> {
  hdr('(b) Re-derive the allocation JE from the saved pool and diff vs. the stored JE');

  const { rows: runs } = await pool.query<RunRow>(
    `SELECT month, pool, revenue, attention FROM accounting.payroll_eom_runs ORDER BY month`,
  );
  for (const run of runs) {
    const [y, mo] = run.month.split('-').map(Number);
    const drafts = buildMonthEndAllocation(run.pool, run.revenue.shares, { year: y, month: mo });
    console.log(`\n--- ${run.month} ---`);
    console.log(`  shares: ${JSON.stringify(run.revenue.shares)}`);
    console.log(`  pool lines in: ${run.pool.length}, drafts out: ${drafts.length} (${drafts.map((d) => d.entity).join(', ')})`);

    const payDate = `${String(mo).padStart(2, '0')}/${new Date(y, mo, 0).getDate()}/${y}`;
    const { rows: db } = await pool.query<DbLineRow>(
      `SELECT h.entity, l.posting_type, l.amount::text AS amount, l.account_name, l.memo, l.origin
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE h.kind = 'allocation' AND h.pay_date = $1`,
      [payDate],
    );
    console.log(`  stored lines for pay_date ${payDate}: ${db.length}`);

    const bag = new Map<string, number>();
    for (const d of drafts) {
      for (const l of d.lines) {
        const k = lineKey(d.entity, l.postingType, l.amount, l.accountName, l.memo);
        bag.set(k, (bag.get(k) ?? 0) + 1);
      }
    }
    let matched = 0;
    const extraInDb: string[] = [];
    for (const r of db) {
      const k = lineKey(r.entity, r.posting_type, Number(r.amount), r.account_name, r.memo ?? '');
      const c = bag.get(k) ?? 0;
      if (c > 0) { bag.set(k, c - 1); matched++; } else extraInDb.push(k);
    }
    const missingInDb = [...bag.entries()].filter(([, c]) => c > 0);
    console.log(`  regenerated == stored: matched=${matched}, only-in-DB=${extraInDb.length}, only-in-regen=${missingInDb.reduce((s, [, c]) => s + c, 0)}`);
    for (const k of extraInDb.slice(0, 10)) console.log(`    only in DB : ${k}`);
    for (const [k, c] of missingInDb.slice(0, 10)) console.log(`    only regen : ${k} x${c}`);

    // Per-draft balance + the 1/3 invariant on each revenue group.
    for (const d of drafts) {
      // docNumber is optional on JournalDraft — it is assigned by the split/QB-journal layer, so a
      // draft read straight out of buildJournal may not carry one yet.
      console.log(`  ${d.entity.padEnd(14)} doc=${(d.docNumber ?? '(none)').padEnd(20)} DR=${money(d.totalDebits).padStart(14)} CR=${money(d.totalCredits).padStart(14)} var=${d.variance}`);
    }

    // Net expense movement per entity should equal (its share of the whole pool) - (what it held).
    const poolTotal = run.pool.reduce((s, l) => s + l.amount, 0);
    const heldBy = new Map<string, number>();
    for (const l of run.pool) heldBy.set(l.entity, (heldBy.get(l.entity) ?? 0) + l.amount);
    console.log(`  pool total ${money(poolTotal)}; expected end-state per entity (all rules revenue/thirds -> equal shares):`);
    for (const d of drafts) {
      const expense = d.lines.filter((l) => !/^Due (from|From|to|To) /i.test(l.accountName));
      const net = expense.reduce((s, l) => s + (l.postingType === 'Debit' ? l.amount : -l.amount), 0);
      const held = heldBy.get(d.entity) ?? 0;
      const share = (run.revenue.shares[d.entity as EomEntity] / 100) * poolTotal;
      console.log(`    ${d.entity.padEnd(14)} held=${money(held).padStart(14)} net move=${money(Math.round(net * 100) / 100).padStart(14)} -> ends at ${money(Math.round((held + net) * 100) / 100).padStart(14)} (target ${money(Math.round(share * 100) / 100)})`);
    }
  }
}

async function feeTrace(pool: Pool): Promise<void> {
  hdr("(c) Where do the 'Payroll Processing Fees' allocation dollars come from?");

  const { rows: runs } = await pool.query<RunRow>(
    `SELECT month, pool, revenue, attention FROM accounting.payroll_eom_runs ORDER BY month`,
  );
  for (const run of runs) {
    const hits = [...run.pool, ...run.attention].filter((l) => /Processing Fees/i.test(l.accountName));
    if (hits.length === 0) continue;
    console.log(`\n--- ${run.month}: ${hits.length} pool/attention line(s) on a Processing Fees account ---`);
    for (const l of hits) {
      console.log(`  ${l.entity.padEnd(14)} ${l.txnType.padEnd(13)} txn=${String(l.txnId).padStart(6)} ${l.txnDate} ${money(l.amount).padStart(12)} rule=${l.rule.padEnd(12)} class=${l.className} dept=${l.departmentName}`);
      console.log(`      account=${l.accountName}  memo=${JSON.stringify(l.memo)}`);
    }
  }

  const { rows } = await pool.query<DbLineRow & { pay_date: string; kind: string; department_name: string | null; class_name: string | null }>(
    `SELECT h.entity, h.pay_date, h.kind, l.posting_type, l.amount::text AS amount, l.account_name,
            l.department_name, l.class_name, l.memo, l.origin
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE l.account_name ILIKE '%Processing Fees%'
     ORDER BY h.entity, h.pay_date`,
  );
  console.log(`\n-- every stored JE line on a Processing Fees account: ${rows.length} --`);
  for (const r of rows) {
    console.log(`  ${r.entity.padEnd(14)} ${r.pay_date} kind=${r.kind.padEnd(10)} ${r.posting_type.padEnd(6)} ${money(Number(r.amount)).padStart(10)} dept=${String(r.department_name).padEnd(6)} class=${String(r.class_name).padEnd(6)} origin=${r.origin.padEnd(13)} memo=${JSON.stringify(r.memo)}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    await attention(pool);
    await mathCheck(pool);
    await feeTrace(pool);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
