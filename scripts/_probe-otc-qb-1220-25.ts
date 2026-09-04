/**
 * READ-ONLY: what QuickBooks account 1220.25 OTC Items Inventory actually holds.
 *
 * WHAT IT PROVES
 *
 * `ds-qb-inventory-account-coverage.md` §3 assumed 1220.25 carried retail OTC
 * stock — CeraVe, Aquaphor and friends — against a balance it put near $27,477.
 * It does not. Every document ever coded to the account in any realm is COMBS,
 * plus $164.52 of silicone scar sheets miscoded in Florida. The OTC products that
 * are actually dispensed were purchased into 1220.05 and 1220.10.
 *
 * That is why the OTC contributor (`src/lib/inventory/otc-dispensing.ts`) posts a
 * COGS reclass and never credits 1220.25.
 *
 * It also reads the per-month balance for 2026, which needs `getBalanceSheetInventory`
 * rather than a hand-rolled report call: ⚠ QuickBooks SILENTLY IGNORES `end_date`
 * on reports/BalanceSheet unless a `start_date` is sent too — HTTP 200, a
 * well-formed report, and the wrong period. `buildBalanceSheetEndpoint` sends one.
 *
 * Read-only: Account + Bill + Purchase + JournalEntry queries and BalanceSheet
 * reports. Nothing is written to QuickBooks.
 *
 * Run from web/:  npx tsx scripts/_probe-otc-qb-1220-25.ts
 */
import './lib/load-env';
import {
  getBalanceSheetInventory,
  getConnectedLocations,
  qbQueryAll,
  type Location,
} from '../src/lib/quickbooks-multi';

const OTC_ACCT_NUM = '1220.25';
const OTC_COGS_ACCT_NUM = '5000.35';

/** 2026 only — Carson's scope ruling (ds-device-standard-cost-2026-09-03.md §8). */
const MONTH_ENDS = [
  '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
  '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
] as const;

/** Document entities that can carry a line coded to a balance-sheet account. */
const DOC_ENTITIES = ['Bill', 'Purchase', 'JournalEntry', 'VendorCredit'] as const;

interface QbAccount {
  Id: string;
  AcctNum?: string;
  FullyQualifiedName?: string;
  CurrentBalance?: number;
}

interface QbLine {
  Amount?: number;
  Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
  ItemBasedExpenseLineDetail?: { Qty?: number; UnitPrice?: number };
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { value?: string } };
}

interface QbDoc {
  Id: string;
  TxnDate?: string;
  VendorRef?: { name?: string };
  Line?: QbLine[];
}

const money = (n: number): string => n.toFixed(2);

async function main(): Promise<void> {
  const locations = (await getConnectedLocations()).filter((l) => String(l) !== 'FOCAS');
  console.log(`connected inventory realms: ${locations.join(', ')}\n`);

  for (const location of locations) {
    const accounts = await qbQueryAll<QbAccount>(location as Location, 'Account', '');
    const asset = accounts.filter((a) => a.AcctNum === OTC_ACCT_NUM);
    const cogs = accounts.filter((a) => a.AcctNum === OTC_COGS_ACCT_NUM);

    console.log(`### ${location}`);
    for (const a of asset) {
      console.log(`  ${a.AcctNum}  ${a.FullyQualifiedName}   CurrentBalance ${money(a.CurrentBalance ?? 0)}`);
    }
    for (const a of cogs) {
      console.log(`  ${a.AcctNum}  ${a.FullyQualifiedName}   CurrentBalance ${money(a.CurrentBalance ?? 0)}`);
    }
    if (asset.length === 0) {
      console.log(`  no ${OTC_ACCT_NUM} account in this realm`);
      console.log('');
      continue;
    }

    console.log('  balance by month-end (BalanceSheet, Accrual, start_date sent):');
    for (const asOf of MONTH_ENDS) {
      const bs = await getBalanceSheetInventory(location as Location, asOf);
      if (bs === null) {
        console.log(`    ${asOf}  (report unavailable)`);
        continue;
      }
      const row = bs.accounts.find((x) => x.name.startsWith(`${OTC_ACCT_NUM} `));
      console.log(
        `    ${asOf}  ${OTC_ACCT_NUM} ${(row ? money(row.value) : 'absent from report').padStart(18)}` +
          `    (whole ${bs.accountName}: ${money(bs.total)})`,
      );
    }

    const assetIds = new Set(asset.map((a) => a.Id));
    console.log('  every document ever coded to it:');
    let net = 0;
    let lineCount = 0;
    for (const entity of DOC_ENTITIES) {
      let docs: QbDoc[] = [];
      try {
        docs = await qbQueryAll<QbDoc>(location as Location, entity, '');
      } catch (error) {
        console.log(`    ${entity}: unreadable — ${error instanceof Error ? error.message.slice(0, 70) : String(error)}`);
        continue;
      }
      for (const doc of docs) {
        for (const line of doc.Line ?? []) {
          const ref =
            line.AccountBasedExpenseLineDetail?.AccountRef?.value ??
            line.JournalEntryLineDetail?.AccountRef?.value;
          if (ref === undefined || !assetIds.has(ref)) continue;
          const amount = line.Amount ?? 0;
          const signed = line.JournalEntryLineDetail?.PostingType === 'Credit' ? -amount : amount;
          net += signed;
          lineCount += 1;
          const qty = line.ItemBasedExpenseLineDetail?.Qty;
          console.log(
            `    ${entity.padEnd(13)} ${doc.TxnDate ?? '—'}  ${(doc.VendorRef?.name ?? '—').slice(0, 30).padEnd(30)}` +
              ` ${money(signed).padStart(11)}${qty === undefined ? '' : `  qty=${qty}`}` +
              `  ${(line.Description ?? '').replace(/\s+/g, ' ').slice(0, 74)}`,
          );
        }
      }
    }
    console.log(`  -> ${lineCount} lines, net ${money(net)}\n`);
  }

  console.log(
    'READING: no document names a comb COUNT, so there is no defensible $/comb and\n' +
      'nothing here can relieve 1220.25. The FIFO side receives combs at a placeholder\n' +
      "$0.0002/unit, so the close's own relief of them rounds to zero. See §7 of\n" +
      'docs/fifo-monthly-close/ds-otc-category-2026-09-04.md.',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
