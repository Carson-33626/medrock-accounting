/**
 * READ-ONLY: which COGS account does the accountant's own 1220.30 relief hit?
 *
 * The chart carries five plausible offsets (5000.15/.20/.40/.45, and a generic
 * parent), and picking the wrong one puts a real number on the wrong line. Rather
 * than reason from account names, this reads the OTHER side of every JournalEntry
 * that has ever credited 1220.30 and reports what she actually used.
 *
 * Also confirms `2011 Accrued Expenses` exists in all three realms — the credit the
 * accrual half needs, and the one the lab-supplies build had to correct to.
 *
 * Run from web/:  npx tsx scripts/_probe-shipping-offsets.ts
 */
import './lib/load-env';
import { qbQueryAll, type Location } from '../src/lib/quickbooks-multi';

const LOCATIONS: readonly Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const ASSET_ACCT = '1220.30';

interface AccountRow {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  CurrentBalance?: number;
}

interface JeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string };
  };
}

interface JeDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: JeLine[];
}

async function main(): Promise<void> {
  for (const location of LOCATIONS) {
    console.log(`=== ${location} ===\n`);
    const accounts = await qbQueryAll<AccountRow>(location, 'Account', '');
    const byId = new Map<string, AccountRow>();
    for (const a of accounts) byId.set(a.Id, a);
    const assetId = accounts.find((a) => a.AcctNum === ASSET_ACCT)?.Id;
    if (assetId === undefined) {
      console.log(`   no ${ASSET_ACCT} account\n`);
      continue;
    }

    const jes = await qbQueryAll<JeDoc>(location, 'JournalEntry', `WHERE TxnDate >= '2024-01-01'`);

    // Every entry that touches 1220.30 — report what else is on it.
    const offsets = new Map<string, { debits: number; credits: number; entries: Set<string> }>();
    for (const je of jes) {
      const touches = (je.Line ?? []).some(
        (l) => l.JournalEntryLineDetail?.AccountRef?.value === assetId,
      );
      if (!touches) continue;
      for (const line of je.Line ?? []) {
        const acctId = line.JournalEntryLineDetail?.AccountRef?.value;
        if (acctId === undefined || acctId === assetId) continue;
        const a = byId.get(acctId);
        const key = `${a?.AcctNum ?? '?'} ${a?.FullyQualifiedName ?? acctId}`;
        const agg = offsets.get(key) ?? { debits: 0, credits: 0, entries: new Set<string>() };
        if (line.JournalEntryLineDetail?.PostingType === 'Debit') agg.debits += line.Amount ?? 0;
        else agg.credits += line.Amount ?? 0;
        agg.entries.add(je.Id);
        offsets.set(key, agg);
      }
    }

    console.log(`   offsetting accounts on entries touching ${ASSET_ACCT} (since 2024-01-01):`);
    for (const [key, v] of [...offsets.entries()].sort((a, b) => b[1].debits - a[1].debits)) {
      console.log(
        `      ${key.padEnd(56)} Dr ${v.debits.toFixed(2).padStart(12)}  ` +
          `Cr ${v.credits.toFixed(2).padStart(12)}  (${v.entries.size} entries)`,
      );
    }

    const accrued = accounts.filter(
      (a) => a.AcctNum === '2011' || /accrued expense/i.test(a.FullyQualifiedName ?? a.Name ?? ''),
    );
    console.log('\n   accrued-expense candidates:');
    for (const a of accrued) {
      console.log(
        `      ${(a.AcctNum ?? '—').padEnd(8)} ${(a.FullyQualifiedName ?? a.Name ?? '').padEnd(40)} ` +
          `${(a.AccountType ?? '').padEnd(20)} bal=${(a.CurrentBalance ?? 0).toFixed(2)}`,
      );
    }
    console.log('');
  }
}

void main();
