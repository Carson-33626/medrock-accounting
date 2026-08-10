// Why: the dedupe's Ramp layer reads GET /bills, and every Letco bill it returns is OPEN or PAID —
// no DRAFT ever appears. If Ramp holds bills in a draft/unapproved state that /bills hides (e.g. its
// own AP-inbox ingestion of the same emailed invoice), run-letco.ts is structurally blind to them
// and will create a second draft for an invoice Ramp already has. This lists the draft collection
// directly and reports any Letco invoice numbers sitting there. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-ramp-drafts.ts <FL|TN|TX>
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

interface DraftRaw {
  id?: string;
  invoice_number?: string | null;
  status?: string | null;
  created_at?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { name?: string | null } | null;
}
interface DraftPage { data?: DraftRaw[]; page?: { next?: string | null } }

interface DraftLine { memo?: string | null; accounting_field_selections?: { external_code?: string | null }[] }
interface DraftDetail { line_items?: DraftLine[]; invoice_urls?: string[] }

async function main(): Promise<void> {
  const [entityArg] = process.argv.slice(2);
  if (!entityArg || !ALL_ENTITIES.includes(entityArg as Entity)) {
    throw new Error('Usage: npx tsx engines/receipt-capture/_probe-ramp-drafts.ts <FL|TN|TX>');
  }
  const entity = entityArg as Entity;
  const token = await rampToken(entity, 'bills:read');

  // Which listing paths even exist? A 404/405 tells us the collection is not enumerable, which is
  // itself the answer: dedupe cannot cover drafts via the API and needs a different guard.
  for (const path of ['/bills/drafts?page_size=100', '/bills?page_size=1&status=DRAFT', '/bills?page_size=1&include_drafts=true']) {
    const res = await rampGet<DraftPage>(entity, path, token);
    const rows = res.body?.data ?? [];
    console.log(`GET ${path} -> HTTP ${res.status}  rows=${Array.isArray(rows) ? rows.length : 'n/a'}`);
    if (res.status !== 200) console.log(`   ${JSON.stringify(res.body).slice(0, 220)}`);
  }

  console.log('\n=== enumerating /bills/drafts ===');
  let url: string | null = '/bills/drafts?page_size=100';
  const all: DraftRaw[] = [];
  for (let i = 0; i < 50 && url !== null; i++) {
    const res: { status: number; body: DraftPage } = await rampGet<DraftPage>(entity, url, token);
    if (res.status !== 200) { console.log(`stopped at HTTP ${res.status}`); break; }
    const rows = res.body.data ?? [];
    all.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  console.log(`[${entity}] drafts=${all.length}`);
  for (const d of all) {
    const isLetco = /letco|fagron/i.test(d.vendor?.name ?? '') || /^C335-/i.test((d.invoice_number ?? '').trim());
    console.log(`${isLetco ? '  * ' : '    '}id=${d.id ?? '?'} invoice=${d.invoice_number ?? '(none)'} status=${d.status ?? '?'} amount=${((d.amount?.amount ?? 0) / 100).toFixed(2)} vendor="${d.vendor?.name ?? '?'}" created=${d.created_at ?? '?'}`);
  }
  const letcoDrafts = all.filter((d) => /^C335-/i.test((d.invoice_number ?? '').trim()));
  console.log(`\nLetco (C335-*) drafts sitting in Ramp: ${letcoDrafts.length}`);

  // The decisive question for create-vs-enrich: Ramp's own AP ingestion already splits the lines and
  // attaches the PDF, so the only thing our pipeline adds is the GL coding. Measure how many of
  // Ramp's existing Letco draft lines actually carry a GL selection.
  console.log('\n=== GL coding on Ramp\'s own Letco drafts ===');
  let codedLines = 0;
  let uncodedLines = 0;
  for (const d of letcoDrafts) {
    if (d.id === undefined) continue;
    const res = await rampGet<DraftDetail>(entity, `/bills/drafts/${d.id}`, token);
    if (res.status !== 200) { console.log(`  ${d.invoice_number}: HTTP ${res.status}`); continue; }
    const lines = res.body.line_items ?? [];
    const coded = lines.filter((l) => (l.accounting_field_selections ?? []).length > 0).length;
    codedLines += coded;
    uncodedLines += lines.length - coded;
    console.log(`  ${d.invoice_number}: ${lines.length} line(s), ${coded} GL-coded, ${lines.length - coded} UNCODED  | attachments=${(res.body.invoice_urls ?? []).length}`);
  }
  console.log(`TOTAL lines on Ramp's Letco drafts: ${codedLines} coded / ${uncodedLines} uncoded`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
