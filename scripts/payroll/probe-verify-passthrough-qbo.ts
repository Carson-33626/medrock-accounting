/**
 * READ-ONLY QuickBooks check of the passthrough premise. The End of Month tab now tells Barbara
 * that 'Allocate - FL/TN/TX' lines need "nothing to do" because QuickBooks' Intercompany
 * allocation already booked the move on the transaction itself. This pulls the ACTUAL July 2026
 * MedRock FL transactions behind those lines and prints EVERY line on them, plus every FL
 * JournalEntry that touches a Due From/To account that month — so we can see whether the
 * offsetting inter-entity leg really exists.
 *
 * Uses .env.vercel (production QB creds — see probe-ie-usage.ts). Read-only queries only.
 *   npx tsx scripts/payroll/probe-verify-passthrough-qbo.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

/* eslint-disable @typescript-eslint/no-var-requires */
import type { PoolLine } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbRef { value?: string; name?: string }
interface QbExpenseLine {
  Amount?: number; Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QbRef; ClassRef?: QbRef };
  ItemBasedExpenseLineDetail?: { ItemRef?: QbRef; ClassRef?: QbRef };
}
interface QbExpenseTxn { Id: string; DocNumber?: string; TxnDate?: string; DepartmentRef?: QbRef; TotalAmt?: number; Line?: QbExpenseLine[]; EntityRef?: QbRef }
interface QbJeLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: QbRef; DepartmentRef?: QbRef; ClassRef?: QbRef };
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbJeLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = (await import('../../src/lib/quickbooks-multi')) as {
    qbQueryAll: <T>(location: string, entity: string, where: string) => Promise<T[]>;
  };

  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  let pass: PoolLine[] = [];
  try {
    const { rows } = await pool.query<{ attention: PoolLine[] }>(
      `SELECT attention FROM accounting.payroll_eom_runs WHERE month = '2026-07'`,
    );
    pass = (rows[0]?.attention ?? []).filter((l) => l.rule === 'passthrough' && l.entity === 'MedRock FL');
  } finally {
    await pool.end();
  }
  console.log(`2026-07 MedRock FL passthrough lines: ${pass.length} (${money(pass.reduce((s, l) => s + l.amount, 0))})`);

  // Sample the largest few transactions and print every line QuickBooks holds for them.
  const byTxn = new Map<string, { type: string; amt: number }>();
  for (const l of pass) {
    const k = `${l.txnType}¦${l.txnId}`;
    const g = byTxn.get(k) ?? { type: l.txnType, amt: 0 };
    g.amt += l.amount; byTxn.set(k, g);
  }
  const sample = [...byTxn].sort((a, b) => Math.abs(b[1].amt) - Math.abs(a[1].amt)).slice(0, 6);
  console.log(`\nsampling the ${sample.length} largest of ${byTxn.size} passthrough transactions:\n`);

  for (const [k, g] of sample) {
    const id = k.split('¦')[1];
    const rows = await qbQueryAll<QbExpenseTxn>('MedRock FL', g.type, `WHERE Id = '${id}'`);
    const txn = rows[0];
    if (!txn) { console.log(`  ${g.type} ${id}: NOT FOUND`); continue; }
    console.log(`  ${g.type} ${id}  ${txn.TxnDate}  doc=${txn.DocNumber ?? '(none)'}  vendor=${txn.EntityRef?.name ?? '(none)'}  total=${money(txn.TotalAmt ?? 0)}  headerDept=${txn.DepartmentRef?.name ?? '(none)'}`);
    console.log(`    allocate-flagged portion in our pool: ${money(g.amt)}`);
    for (const l of txn.Line ?? []) {
      const acct = l.AccountBasedExpenseLineDetail;
      const item = l.ItemBasedExpenseLineDetail;
      const name = acct?.AccountRef?.name ?? `(item: ${item?.ItemRef?.name ?? '?'})`;
      const cls = acct?.ClassRef?.name ?? item?.ClassRef?.name ?? '(no class)';
      console.log(`      ${money(l.Amount ?? 0).padStart(12)}  ${name.padEnd(52)} class=${cls}`);
    }
    console.log('');
  }

  // Does ANY July FL JournalEntry book an inter-entity move? (QBO Intercompany allocation would.)
  const jes = await qbQueryAll<QbJe>('MedRock FL', 'JournalEntry', `WHERE TxnDate >= '2026-07-01' AND TxnDate <= '2026-07-31'`);
  console.log(`\n2026-07 MedRock FL JournalEntry count: ${jes.length}`);
  let ieJes = 0;
  for (const je of jes) {
    const ieLines = (je.Line ?? []).filter((l) => /^Due (from|From|to|To) |^IE - Due/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
    if (ieLines.length === 0) continue;
    ieJes++;
    console.log(`\n  JE ${je.Id} ${je.TxnDate} doc=${je.DocNumber ?? '(none)'} note=${JSON.stringify(je.PrivateNote ?? '')}`);
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      console.log(`      ${String(d?.PostingType).padEnd(6)} ${money(l.Amount ?? 0).padStart(12)}  ${(d?.AccountRef?.name ?? '?').padEnd(48)} class=${d?.ClassRef?.name ?? '(none)'} dept=${d?.DepartmentRef?.name ?? '(none)'}`);
    }
  }
  console.log(`\nJuly FL JEs touching an inter-entity account: ${ieJes}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
