// Read back the pilot draft through Ramp's own GET — a 201 on create is not proof of state.
//   npx tsx scripts/receipt-capture/_verify-medisca-pilot.ts <draftId>
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';

interface Sel { field_external_id?: string; field_option_external_id?: string; category_info?: { type?: string; name?: string } | null; external_code?: string | null; name?: string | null }
interface Line { amount?: { amount?: number }; memo?: string | null; accounting_field_selections?: Sel[] }
interface Draft {
  id: string; invoice_number?: string | null; memo?: string | null;
  issued_at?: string | null; due_at?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { id?: string; name?: string | null } | null;
  entity?: { id?: string; name?: string | null } | null;
  line_items?: Line[]; invoice_urls?: string[];
}

async function main(): Promise<void> {
  const draftId = process.argv[2];
  if (!draftId) throw new Error('usage: _verify-medisca-pilot.ts <draftId>');
  const token = await rampToken('TX', 'bills:read accounting:read');
  const res = await rampGet<Draft>('TX', `/bills/drafts/${draftId}`, token);
  const d = res.body;
  console.log(`HTTP ${res.status}`);
  console.log(`invoice   ${d.invoice_number}`);
  console.log(`vendor    ${d.vendor?.name} (${d.vendor?.id})`);
  console.log(`entity    ${JSON.stringify(d.entity)}`);
  console.log(`dates     issued ${d.issued_at} due ${d.due_at}`);
  console.log(`total     $${((d.amount?.amount ?? 0) / 100).toFixed(2)}`);
  console.log(`memo      ${d.memo}`);
  console.log(`pdf       ${(d.invoice_urls ?? []).length} attachment(s)`);
  console.log(`lines     ${(d.line_items ?? []).length}`);
  let sum = 0;
  for (const l of d.line_items ?? []) {
    sum += l.amount?.amount ?? 0;
    const gl = (l.accounting_field_selections ?? [])
      .map((s) => `${s.category_info?.type ?? '?'}:${s.name ?? s.external_code ?? '?'}`).join(' | ');
    console.log(`  $${((l.amount?.amount ?? 0) / 100).toFixed(2).padStart(9)}  [${gl}]  ${JSON.stringify((l.memo ?? '').slice(0, 60))}`);
  }
  console.log(`lines sum $${(sum / 100).toFixed(2)}  ${sum === (d.amount?.amount ?? 0) ? '== total OK' : '!= TOTAL MISMATCH'}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
