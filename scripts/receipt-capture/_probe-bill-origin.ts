// Diagnostic: are a vendor's QB Bills hand-keyed, or synced in from Ramp Bill Pay? Ramp stamps
// "View this bill in Ramp: https://app.ramp.com/s/bill-pay/bills/<id>" into PrivateNote, so the
// note is a reliable origin marker. Decides whether automating a vendor saves keying at all.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-bill-origin.ts "Letco"
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const NEEDLE = (process.argv[2] ?? '').toLowerCase();
const SINCE = process.argv[3] ?? '2026-01-01';

interface QBRef { value: string; name?: string }
interface QBBill {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: QBRef;
  PrivateNote?: string;
}

const RAMP_MARK = /app\.ramp\.com\/s\/bill-pay/i;

async function main(): Promise<void> {
  console.log(`Bill origin${NEEDLE === '' ? ' (ALL vendors)' : ` for "${NEEDLE}"`} since ${SINCE}\n`);

  interface Row { vendor: string; ramp: number; manual: number; rampCents: number; manualCents: number }
  const byVendor = new Map<string, Row>();
  let ramp = 0;
  let manual = 0;

  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    const bills = await qbQueryAll<QBBill>(loc, 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of bills) {
      const vendor = b.VendorRef?.name ?? '(none)';
      if (NEEDLE !== '' && !vendor.toLowerCase().includes(NEEDLE)) continue;
      const isRamp = RAMP_MARK.test(b.PrivateNote ?? '');
      const r = byVendor.get(vendor) ?? { vendor, ramp: 0, manual: 0, rampCents: 0, manualCents: 0 };
      const cents = Math.round((b.TotalAmt ?? 0) * 100);
      if (isRamp) { r.ramp++; r.rampCents += cents; ramp++; } else { r.manual++; r.manualCents += cents; manual++; }
      byVendor.set(vendor, r);
    }
  }

  const total = ramp + manual;
  console.log(`bills: ${total} | from Ramp Bill Pay: ${ramp} (${total > 0 ? Math.round((ramp / total) * 100) : 0}%) | no Ramp marker: ${manual}\n`);

  console.log('vendor                                     ramp  manual      ramp $    manual $');
  const rows = [...byVendor.values()].sort((a, b) => (b.ramp + b.manual) - (a.ramp + a.manual));
  for (const r of rows.slice(0, 30)) {
    console.log(
      `${r.vendor.slice(0, 42).padEnd(43)} ${String(r.ramp).padStart(5)} ${String(r.manual).padStart(7)} ${(r.rampCents / 100).toFixed(2).padStart(11)} ${(r.manualCents / 100).toFixed(2).padStart(11)}`,
    );
  }
  console.log('\n"manual" = no Ramp bill-pay link in PrivateNote. Those are the ones a human actually entered.');
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
