// Diagnostic: is a vendor's spend being entered on the QUICKBOOKS side (Bill/Purchase keyed by the
// emailed invoice) rather than against the Ramp card txn? If so, its receiptless Ramp txns are a
// bookkeeping duplicate risk, not an automation gap, and building a capture pipeline is wrong.
// READ-ONLY against both Ramp and QBO.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-vendor-in-qb.ts "Hospital Pharmaceutical"
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../../../src/lib/quickbooks-multi';

const NEEDLE = process.argv[2] ?? 'Hospital Pharmaceutical';
const SINCE = process.argv[3] ?? '2026-01-01';

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface QBRef { value: string; name?: string }
interface QBDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: QBRef;
  EntityRef?: QBRef;
  PrivateNote?: string;
}

interface RampRow { entity: Entity; id: string; date: string; amount: number; receipts: number; holder: string }

async function rampSide(): Promise<RampRow[]> {
  const out: RampRow[] = [];
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 200 && url !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      for (const t of rows) {
        if (!(t.merchant_name ?? '').toLowerCase().includes(NEEDLE.toLowerCase())) continue;
        const date = (t.user_transaction_time ?? '').slice(0, 10);
        if (date < SINCE) continue;
        out.push({
          entity,
          id: t.id,
          date,
          amount: Math.abs(t.amount),
          receipts: (t.receipts ?? []).length,
          holder: `${t.card_holder?.first_name ?? ''} ${t.card_holder?.last_name ?? ''}`.trim(),
        });
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function qbSide(): Promise<{ kind: string; entity: Entity; doc: QBDoc }[]> {
  const found: { kind: string; entity: Entity; doc: QBDoc }[] = [];
  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    for (const kind of ['Bill', 'Purchase']) {
      try {
        const docs = await qbQueryAll<QBDoc>(loc, kind, `WHERE TxnDate >= '${SINCE}'`);
        for (const d of docs) {
          const payee = d.VendorRef?.name ?? d.EntityRef?.name ?? '';
          if (!payee.toLowerCase().includes(NEEDLE.toLowerCase())) continue;
          found.push({ kind, entity, doc: d });
        }
      } catch (e: unknown) {
        console.log(`  [${entity}] ${kind} query failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  return found.sort((a, b) => (a.doc.TxnDate ?? '').localeCompare(b.doc.TxnDate ?? ''));
}

async function main(): Promise<void> {
  console.log(`vendor "${NEEDLE}", on/after ${SINCE}\n`);

  const ramp = await rampSide();
  const rampTotal = ramp.reduce((s, r) => s + r.amount, 0);
  const noReceipt = ramp.filter((r) => r.receipts === 0);
  console.log(`=== RAMP: ${ramp.length} txns, $${rampTotal.toFixed(2)} (${noReceipt.length} with NO receipt) ===`);
  for (const r of ramp) {
    console.log(`  ${r.date}  ${r.entity}  $${r.amount.toFixed(2).padStart(9)}  receipts=${r.receipts}  ${r.holder}  ${r.id.slice(0, 8)}`);
  }

  const qb = await qbSide();
  const qbTotal = qb.reduce((s, d) => s + (d.doc.TotalAmt ?? 0), 0);
  console.log(`\n=== QUICKBOOKS: ${qb.length} Bill/Purchase docs, $${qbTotal.toFixed(2)} ===`);
  for (const d of qb) {
    console.log(`  ${d.doc.TxnDate}  ${d.entity}  ${d.kind.padEnd(8)} $${(d.doc.TotalAmt ?? 0).toFixed(2).padStart(9)}  doc#${d.doc.DocNumber ?? '-'}  payee=${d.doc.VendorRef?.name ?? d.doc.EntityRef?.name ?? '?'}`);
  }

  // Do the two sides describe the SAME spend? Match on amount (exact) within a loose date window.
  console.log('\n=== AMOUNT OVERLAP (same spend recorded on both sides?) ===');
  let paired = 0;
  for (const r of ramp) {
    const hit = qb.find((d) => Math.abs((d.doc.TotalAmt ?? 0) - r.amount) < 0.005);
    if (hit) {
      paired++;
      console.log(`  ramp ${r.date} $${r.amount.toFixed(2)}  <->  QB ${hit.kind} ${hit.doc.TxnDate} doc#${hit.doc.DocNumber ?? '-'}`);
    }
  }
  console.log(`\nRamp txns with an exact-amount QB Bill/Purchase: ${paired} / ${ramp.length}`);
  console.log(`Ramp-only (no QB doc at that amount): ${ramp.length - paired}`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
