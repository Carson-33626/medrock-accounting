// Why: the FL live pilot created a draft for C335-176896 that Carson identified as a DUPLICATE of
// something that already existed — so the layered dedupe (registry -> QB DocNumber -> Ramp
// invoice_number) has a hole. This finds the pre-existing copy and, more importantly, measures
// whether run-letco.ts's own dedupe INPUTS are complete:
//   - fetchRampBills() caps at 30 pages x 100 = 3000 bills with NO warning when the cap is hit
//   - the QB check only counts bills whose VendorRef name matches /letco|fagron/
//   - the QB check floors at TxnDate >= 2026-01-01
// READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-dupe.ts <FL|TN|TX> [invoiceNumber]
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';

interface RampBillRaw {
  id: string;
  invoice_number?: string | null;
  status?: string | null;
  sync_status?: string | null;
  created_at?: string | null;
  issued_at?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { name?: string | null } | null;
}
interface BillsPage { data?: RampBillRaw[]; page?: { next?: string | null } }

interface QbBillRow {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: { name?: string; value?: string };
}

// Deliberately far above run-letco.ts's 30 so we can SEE whether 30 was truncating.
const HARD_PAGE_CAP = 200;

async function fetchAllRampBills(entity: Entity, token: string): Promise<{ bills: RampBillRaw[]; pages: number; hitCap: boolean }> {
  const out: RampBillRaw[] = [];
  let url: string | null = '/bills?page_size=100';
  let pages = 0;
  for (; pages < HARD_PAGE_CAP && url !== null; pages++) {
    const res: { status: number; body: BillsPage } = await rampGet<BillsPage>(entity, url, token);
    if (res.status !== 200) throw new Error(`Ramp /bills failed (${entity}): HTTP ${res.status}`);
    const rows = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return { bills: out, pages, hitCap: url !== null };
}

async function main(): Promise<void> {
  const [entityArg, invoiceArg] = process.argv.slice(2);
  if (!entityArg || !ALL_ENTITIES.includes(entityArg as Entity)) {
    throw new Error('Usage: npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-dupe.ts <FL|TN|TX> [invoiceNumber]');
  }
  const entity = entityArg as Entity;
  const invoice = invoiceArg ?? 'C335-176896';

  // ---- Ramp side, uncapped ----
  const token = await rampToken(entity, 'bills:read');
  const { bills, pages, hitCap } = await fetchAllRampBills(entity, token);
  const withInvoice = bills.filter((b) => (b.invoice_number ?? '').trim() !== '');
  console.log(`=== Ramp /bills (${entity}) ===`);
  console.log(`total=${bills.length} pages=${pages} withInvoiceNumber=${withInvoice.length} hitHardCap=${hitCap}`);
  console.log(`run-letco.ts caps at 30 pages -> it would have seen ${Math.min(bills.length, 3000)} of ${bills.length}` +
    `${bills.length > 3000 ? '   <-- TRUNCATED, dedupe input was incomplete' : '   (no truncation)'}`);

  const rampHits = bills.filter((b) => (b.invoice_number ?? '').trim().toUpperCase() === invoice.toUpperCase());
  console.log(`\nRamp bills with invoice_number=${invoice}: ${rampHits.length}`);
  for (const b of rampHits) {
    console.log(`  id=${b.id} status=${b.status ?? '?'} sync=${b.sync_status ?? '?'} amount=${((b.amount?.amount ?? 0) / 100).toFixed(2)} created=${b.created_at ?? '?'} vendor="${b.vendor?.name ?? '?'}"`);
  }
  const letcoRamp = bills.filter((b) => /letco|fagron/i.test(b.vendor?.name ?? ''));
  const rampStatuses = new Map<string, number>();
  for (const b of letcoRamp) {
    const k = `${b.status ?? '?'}/${b.sync_status ?? '?'}`;
    rampStatuses.set(k, (rampStatuses.get(k) ?? 0) + 1);
  }
  console.log(`Letco bills in Ramp: ${letcoRamp.length} — status/sync mix: ${[...rampStatuses].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const noInvoiceNo = letcoRamp.filter((b) => (b.invoice_number ?? '').trim() === '').length;
  console.log(`Letco bills in Ramp with NO invoice_number (invisible to the Ramp dedupe layer): ${noInvoiceNo}`);

  // ---- QuickBooks side, no vendor filter, no floor ----
  const location = ENTITY_TO_QB_LOCATION[entity];
  const qbAll = await qbQueryAll<QbBillRow>(location, 'Bill', `WHERE TxnDate >= '2026-01-01'`);
  const qbExact = qbAll.filter((b) => (b.DocNumber ?? '').trim().toUpperCase() === invoice.toUpperCase());
  console.log(`\n=== QuickBooks Bills (${location}, TxnDate >= 2026-01-01) ===`);
  console.log(`total=${qbAll.length}`);
  console.log(`DocNumber=${invoice}: ${qbExact.length}`);
  for (const b of qbExact) {
    console.log(`  Id=${b.Id} TxnDate=${b.TxnDate} Total=${b.TotalAmt} Vendor="${b.VendorRef?.name ?? '?'}" (matches /letco|fagron/: ${/letco|fagron/i.test(b.VendorRef?.name ?? '')})`);
  }
  // Does the vendor-name filter drop any C335-* bills?
  const qbC335 = qbAll.filter((b) => /^C335-/i.test((b.DocNumber ?? '').trim()));
  const qbC335Filtered = qbC335.filter((b) => /letco|fagron/i.test(b.VendorRef?.name ?? ''));
  console.log(`C335-* bills in QB: ${qbC335.length}; surviving the /letco|fagron/ vendor filter: ${qbC335Filtered.length}`);
  const droppedVendors = new Set(qbC335.filter((b) => !/letco|fagron/i.test(b.VendorRef?.name ?? '')).map((b) => b.VendorRef?.name ?? '?'));
  if (droppedVendors.size > 0) console.log(`  vendor names DROPPED by the filter: ${[...droppedVendors].join(' | ')}   <-- dedupe blind spot`);

  // ---- Purchases: a Letco charge could also be recorded as a Purchase, not a Bill ----
  const purchases = await qbQueryAll<QbBillRow>(location, 'Purchase', `WHERE TxnDate >= '2026-01-01'`);
  const purchHits = purchases.filter((p) => (p.DocNumber ?? '').trim().toUpperCase() === invoice.toUpperCase());
  console.log(`\nQB Purchases with DocNumber=${invoice}: ${purchHits.length} (of ${purchases.length} purchases since 2026-01-01)`);
  for (const p of purchHits) console.log(`  Id=${p.Id} TxnDate=${p.TxnDate} Total=${p.TotalAmt} Vendor="${p.VendorRef?.name ?? '?'}"`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
