// Read back one Ramp bill by id and print the fields a human would verify before releasing a draft:
// entity, vendor, invoice number, dates, memo, per-line GL code + amount, attachments, status.
// Used to verify the Letco live pilot's draft. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-bill-fetch.ts <entity> <billId>
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

// Verified against a real draft (2026-08-04): `amount` is an object in MINOR UNITS (cents), the GL
// selection's `external_code` is the account number and `name` its full QuickBooks path, and the
// attached invoice comes back as a signed URL in `invoice_urls` — there is no `documents` array.
interface FieldSelection { external_code?: string | null; name?: string | null }
interface RampMoney { amount?: number; currency_code?: string }
interface LineItem {
  memo?: string | null;
  amount?: RampMoney | null;
  accounting_field_selections?: FieldSelection[];
}
interface Bill {
  id?: string;
  entity_id?: string | null;
  invoice_number?: string | null;
  issued_at?: string | null;
  due_at?: string | null;
  memo?: string | null;
  status?: string | null;
  payment_status?: string | null;
  sync_status?: string | null;
  amount?: RampMoney | null;
  vendor?: { id?: string; name?: string | null; remote_id?: string | null } | null;
  line_items?: LineItem[];
  invoice_urls?: string[];
  bill_owner?: { first_name?: string | null; last_name?: string | null } | null;
}

function money(a: number | undefined): string {
  return a === undefined ? '(none)' : (a / 100).toFixed(2);
}

async function main(): Promise<void> {
  const [entityArg, billId] = process.argv.slice(2);
  if (!entityArg || !ALL_ENTITIES.includes(entityArg as Entity) || !billId) {
    throw new Error('Usage: npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-bill-fetch.ts <FL|TN|TX> <billId>');
  }
  const entity = entityArg as Entity;
  const token = await rampToken(entity, 'bills:read');
  // A draft is NOT addressable at /bills/{id} (404, DEVELOPER_7002) — it lives under the same
  // /bills/drafts collection it was POSTed to. Try the draft path first, then the finalised path.
  let b: Bill | null = null;
  for (const path of [`/bills/drafts/${billId}`, `/bills/${billId}`]) {
    const res = await rampGet<Bill>(entity, path, token);
    console.log(`GET ${path} -> HTTP ${res.status}`);
    if (res.status === 200) { b = res.body; break; }
  }
  if (b === null) throw new Error(`bill ${billId} not readable at either path`);
  if (process.argv.includes('--raw')) { console.log(JSON.stringify(b, null, 2)); return; }
  console.log(`bill        ${b.id}`);
  console.log(`entity_id   ${b.entity_id ?? '(null)'}  [env RAMP_ENTITY_ID_${entity}=${process.env[`RAMP_ENTITY_ID_${entity}`] ?? '(unset)'}]`);
  console.log(`vendor      ${b.vendor?.name ?? '?'}  id=${b.vendor?.id ?? '?'}  remote_id=${b.vendor?.remote_id ?? '(null)'}`);
  console.log(`invoice #   ${b.invoice_number ?? '(none)'}`);
  console.log(`issued/due  ${b.issued_at ?? '?'}  ->  ${b.due_at ?? '?'}`);
  console.log(`memo        ${b.memo ?? '(none)'}`);
  console.log(`status      status=${b.status ?? '?'} payment=${b.payment_status ?? '?'} sync=${b.sync_status ?? '?'}`);
  console.log(`amount      ${money(b.amount?.amount)} ${b.amount?.currency_code ?? ''}`);

  const lines = b.line_items ?? [];
  console.log(`lines       ${lines.length}`);
  let sum = 0;
  for (const [i, li] of lines.entries()) {
    const amt = li.amount?.amount ?? 0;
    sum += amt;
    const gl = (li.accounting_field_selections ?? [])
      .map((s) => `${s.external_code ?? '?'}${s.name ? ` "${s.name}"` : ''}`)
      .join(' | ') || '(no GL selection)';
    console.log(`  [${i}] ${money(amt).padStart(10)}  ${gl}   memo=${li.memo ?? '(none)'}`);
  }
  console.log(`line sum    ${money(sum)}  (header ${money(b.amount?.amount)} — ${sum === (b.amount?.amount ?? -1) ? 'MATCH' : 'MISMATCH'})`);

  const urls = b.invoice_urls ?? [];
  console.log(`owner       ${b.bill_owner?.first_name ?? '?'} ${b.bill_owner?.last_name ?? ''}`);
  console.log(`invoices    ${urls.length} attached${urls.length > 0 ? ` (${urls[0].split('?')[0]})` : ''}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
