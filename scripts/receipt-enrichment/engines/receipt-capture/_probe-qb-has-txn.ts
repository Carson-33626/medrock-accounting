// Before marking anything "synced" in Ramp, verify the premise: is this charge ALREADY in
// QuickBooks? POST /accounting/syncs tells Ramp an object reached the ERP — if that is not true,
// Ramp stops trying and the expense silently never arrives. NOT_SYNC_READY is precisely the state
// of the ~$952k that the 2026-07-27 gap scan found ABSENT from QBO, so the premise is doubtful and
// must be checked, not assumed.
//
// Searches QB Purchases and Bills around the charge date for the amount, and reports anything that
// could be this transaction. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-qb-has-txn.ts <FL|TN|TX> <amount> <YYYY-MM-DD> [vendorRegex]
import '../ramp-split-push/load-env';
import { ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';

interface QbRow {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  PrivateNote?: string;
  EntityRef?: { name?: string };
  VendorRef?: { name?: string };
  AccountRef?: { name?: string };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const entity = process.argv[2] as Entity;
  const amount = Number(process.argv[3]);
  const date = process.argv[4];
  const vendorRe = new RegExp(process.argv[5] ?? 'top\\s*rx', 'i');
  const loc = ENTITY_TO_QB_LOCATION[entity];
  const from = addDays(date, -20);
  const to = addDays(date, 20);
  console.log(`[${entity}/${loc}] looking for $${amount.toFixed(2)} between ${from} and ${to}`);

  for (const type of ['Purchase', 'Bill'] as const) {
    const rows = await qbQueryAll<QbRow>(loc, type, `WHERE TxnDate >= '${from}' AND TxnDate <= '${to}'`);
    const byAmount = rows.filter((r) => Math.abs((r.TotalAmt ?? 0) - amount) < 0.005);
    const byVendor = rows.filter((r) => vendorRe.test(r.VendorRef?.name ?? r.EntityRef?.name ?? ''));
    console.log(`\n${type}: ${rows.length} in window | amount matches=${byAmount.length} | vendor matches=${byVendor.length}`);
    for (const r of byAmount) {
      console.log(`  AMOUNT  Id=${r.Id} ${r.TxnDate} $${(r.TotalAmt ?? 0).toFixed(2)} vendor="${r.VendorRef?.name ?? r.EntityRef?.name ?? '?'}" doc=${r.DocNumber ?? ''} note=${(r.PrivateNote ?? '').slice(0, 60)}`);
    }
    for (const r of byVendor.slice(0, 10)) {
      console.log(`  VENDOR  Id=${r.Id} ${r.TxnDate} $${(r.TotalAmt ?? 0).toFixed(2)} vendor="${r.VendorRef?.name ?? r.EntityRef?.name ?? '?'}" doc=${r.DocNumber ?? ''}`);
    }
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
