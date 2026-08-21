/**
 * READ-ONLY: for a payroll run that failed with QuickBooks' duplicate-DocNumber fault,
 * show (a) whether a JE with that DocNumber exists live in the entity's QB company, and
 * (b) how its lines compare to the local draft we were about to post.
 *
 * Usage: npx tsx scripts/probe-dup-docnumber.ts "MedRock FL" "07/21/2026" "MRFL"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface JE {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  Line?: QbLine[];
}

const [, , entityArg, payDateArg, payGroupArg] = process.argv;
const entity = entityArg ?? 'MedRock FL';
const payDate = payDateArg ?? '07/21/2026';
const payGroup = payGroupArg ?? 'MRFL';

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const { getRdsPool } = await import('../src/lib/rds');
  const { listSiblings, loadDraft } = await import('../src/lib/payroll/store');
  const { deriveJeIdentity } = await import('../src/lib/payroll/je-identity');

  const siblings = await listSiblings(entity as never, payDate, payGroup);
  console.log(`\n===== LOCAL DRAFT(S) — ${entity} ${payDate} ${payGroup} =====`);
  if (siblings.length === 0) {
    console.log('  no local headers found');
  }

  const wanted: Array<{ id: number; doc: string; txnDate: string }> = [];
  for (const [i, s] of siblings.entries()) {
    const ident = deriveJeIdentity(
      {
        entity: s.entity,
        kind: s.kind,
        pay_date: s.pay_date,
        pay_group: s.pay_group,
        period_segment: s.period_segment,
        period_start: s.period_start,
        period_end: s.period_end,
        txn_date: s.txn_date,
        qb_doc_number: s.qb_doc_number,
      },
      i,
      siblings.length,
    );
    console.log(
      `  id=${s.id} status=${s.status} kind=${s.kind} seg='${s.period_segment}' txn_date=${s.txn_date} ` +
        `qb_entry_id=${s.qb_entry_id ?? '-'} qb_doc_number=${s.qb_doc_number ?? '-'}`,
    );
    console.log(
      `     debits=${s.total_debits} credits=${s.total_credits} variance=${s.variance} rows=${s.row_count} ` +
        `-> derived DocNumber '${ident.docNumber}' TxnDate ${ident.txnDateIso}`,
    );
    wanted.push({ id: s.id, doc: ident.docNumber, txnDate: ident.txnDateIso });
  }

  const year = payDate.split('/')[2];
  const entries = await qbQueryAll<JE>(entity as never, 'JournalEntry', `WHERE TxnDate >= '${year}-01-01'`);
  console.log(`\n  (${entries.length} JEs fetched from ${entity} for ${year})`);

  for (const w of wanted) {
    console.log(`\n===== QUICKBOOKS — ${entity} DocNumber '${w.doc}' =====`);
    const hits = entries.filter((e) => e.DocNumber === w.doc);
    if (hits.length === 0) {
      console.log('  NOT FOUND live in QuickBooks — the duplicate fault did NOT come from this DocNumber');
      continue;
    }
    for (const je of hits) {
      let dr = 0;
      let cr = 0;
      for (const l of je.Line ?? []) {
        const t = l.JournalEntryLineDetail?.PostingType;
        if (t === 'Debit') dr += l.Amount ?? 0;
        else cr += l.Amount ?? 0;
      }
      console.log(
        `  Id=${je.Id} TxnDate=${je.TxnDate} lines=${(je.Line ?? []).length} debits=${round2(dr)} credits=${round2(cr)}`,
      );
      console.log(`  Created=${je.MetaData?.CreateTime ?? '?'} Updated=${je.MetaData?.LastUpdatedTime ?? '?'}`);
      console.log(`  PrivateNote=${je.PrivateNote ?? ''}`);

      // Line-level diff vs the local draft.
      const loaded = await loadDraft(w.id);
      if (!loaded) continue;
      const key = (
        acct: string,
        dept: string | null,
        cls: string | null,
        type: string,
        amt: number,
      ): string => `${type}|${acct}|${dept ?? ''}|${cls ?? ''}|${round2(amt).toFixed(2)}`;

      const qbKeys = new Map<string, number>();
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        if (!d) continue;
        const k = key(
          (d.AccountRef?.name ?? '').replace(/^\d+(?:\.\d+)*\s+/, ''),
          d.DepartmentRef?.name ?? null,
          d.ClassRef?.name ?? null,
          d.PostingType ?? '',
          l.Amount ?? 0,
        );
        qbKeys.set(k, (qbKeys.get(k) ?? 0) + 1);
      }
      const localKeys = new Map<string, number>();
      for (const l of loaded.lines) {
        const k = key(l.accountName, l.departmentName, l.className, l.postingType, l.amount);
        localKeys.set(k, (localKeys.get(k) ?? 0) + 1);
      }

      const onlyLocal: string[] = [];
      const onlyQb: string[] = [];
      for (const [k, n] of localKeys) {
        const m = qbKeys.get(k) ?? 0;
        for (let i = 0; i < n - m; i++) onlyLocal.push(k);
      }
      for (const [k, n] of qbKeys) {
        const m = localKeys.get(k) ?? 0;
        for (let i = 0; i < n - m; i++) onlyQb.push(k);
      }
      console.log(
        `\n  DIFF vs local draft id=${w.id}: local lines=${loaded.lines.length}, qb lines=${(je.Line ?? []).length}`,
      );
      if (onlyLocal.length === 0 && onlyQb.length === 0) {
        console.log('  *** IDENTICAL (account/dept/class/type/amount multiset) ***');
      } else {
        console.log(`  only in LOCAL (${onlyLocal.length}):`);
        for (const k of onlyLocal.slice(0, 40)) console.log(`    - ${k}`);
        console.log(`  only in QB (${onlyQb.length}):`);
        for (const k of onlyQb.slice(0, 40)) console.log(`    + ${k}`);
      }
    }
  }

  await getRdsPool().end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
