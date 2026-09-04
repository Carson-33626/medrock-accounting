/**
 * READ-ONLY — Books Sweep lane L1. Cross-checks specific "stranded in 2110" candidates
 * surfaced by probe-1215-sweep.ts against the full 2110 + 1215 ledger for named people,
 * and pulls named TN JournalEntry DocNumbers to settle whether K05 (Poland $2,327.17) and
 * K14 (Powell $748.73, closed-by-JE claim) are fully posted.
 *
 *   npx tsx scripts/payroll/sweep-L1-verify-strands.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string }; Entity?: { EntityRef?: { name?: string } } }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: QbLineDetail;
}
interface QbJE { Id: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

async function dumpDocNumbers(entity: Entity, docNumbers: string[]): Promise<void> {
  const all = await qbQueryAll<QbJE>(entity, 'JournalEntry', `WHERE TxnDate >= '2025-01-01'`);
  for (const dn of docNumbers) {
    const je = all.find((j) => j.DocNumber === dn);
    console.log(`\n  ${entity} JE ${dn}: ${je ? je.TxnDate : 'NOT FOUND'}`);
    if (!je) continue;
    for (const l of je.Line ?? []) {
      const acct = l.JournalEntryLineDetail?.AccountRef?.name;
      const side = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr';
      const who = l.JournalEntryLineDetail?.Entity?.EntityRef?.name;
      console.log(`    ${side} ${money(l.Amount ?? 0).padStart(11)}  ${acct}${who ? `  entity=${who}` : ''}  ${l.Description ?? ''}`);
    }
  }
}

async function dumpAccountLedger(entity: Entity, acctNames: RegExp, since: string, filterText?: RegExp): Promise<void> {
  console.log(`\n=== ${entity}: lines on accounts matching ${acctNames} since ${since}${filterText ? ` (desc matches ${filterText})` : ''} ===`);
  const TYPES: { type: string; label: string }[] = [
    { type: 'JournalEntry', label: 'JE' },
    { type: 'Purchase', label: 'Purchase' },
    { type: 'Bill', label: 'Bill' },
    { type: 'Deposit', label: 'Deposit' },
  ];
  for (const { type, label } of TYPES) {
    const txns = await qbQueryAll<{ Id: string; DocNumber?: string; TxnDate?: string; EntityRef?: { name?: string }; Line?: (QbLine & { AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } }; DepositLineDetail?: { AccountRef?: { name?: string } } })[] }>(
      entity, type, `WHERE TxnDate >= '${since}'`,
    );
    for (const t of txns.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
      for (const l of t.Line ?? []) {
        const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
        const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const depAcct = l.DepositLineDetail?.AccountRef?.name;
        const acct = jeAcct ?? expAcct ?? depAcct;
        if (!acct || !acctNames.test(acct)) continue;
        if (filterText && !filterText.test(l.Description ?? '') && !filterText.test(t.EntityRef?.name ?? '')) continue;
        const side = jeAcct !== undefined ? (l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr') : depAcct !== undefined ? 'Cr' : 'Dr';
        console.log(`  ${t.TxnDate}  ${label.padEnd(8)} ${(t.DocNumber ?? `(id ${t.Id})`).padEnd(22)} ${side} ${money(l.Amount ?? 0).padStart(11)} [${acct}]  payee=${t.EntityRef?.name ?? ''}  ${l.Description ?? ''}`);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('--- TN: named JE DocNumbers from K14 closure claim ---');
  await dumpDocNumbers('MedRock TN', ['20702', '20699', '20698', '20700']);

  console.log('\n--- TN: 2110 lines mentioning Powell (is the remaining $400 stranded?) ---');
  await dumpAccountLedger('MedRock TN', /2110|payroll withholding/i, '2025-01-01', /Powell/i);

  console.log('\n--- TN: 2110 lines mentioning Poland (K05 reclass Dr 2110 / Cr 1215 $2,327.17 posted?) ---');
  await dumpAccountLedger('MedRock TN', /2110|payroll withholding/i, '2025-01-01', /Poland/i);
  console.log('\n--- TN: 1215 lines mentioning Poland ---');
  await dumpAccountLedger('MedRock TN', /employee advances/i, '2025-01-01', /Poland/i);

  console.log('\n--- FL: 1215 and 2110 lines mentioning Dightman ---');
  await dumpAccountLedger('MedRock FL', /employee advances|2110|payroll withholding/i, '2025-01-01', /Dightman/i);

  console.log('\n--- FL: 1215 and 2110 lines mentioning Webb ---');
  await dumpAccountLedger('MedRock FL', /employee advances|2110|payroll withholding/i, '2025-01-01', /Webb/i);

  console.log('\n--- FL: widen to 2024-01-01, unfiltered 1215 ledger (catch pre-2025 opening items for Dightman/Webb) ---');
  await dumpAccountLedger('MedRock FL', /employee advances/i, '2024-01-01');
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
