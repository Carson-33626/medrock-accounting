// The enrich backlog, by vendor: every Ramp DRAFT bill grouped by vendor with its coded vs uncoded
// line counts. Letco proved the pattern (26 drafts, 68 lines, 0 coded -> all coded by us); this
// answers "which vendor is next" with numbers instead of a guess, and shows whether a vendor's
// drafts even carry the invoice PDF and line split that enrich depends on. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-draft-coding.ts [FL|TN|TX|all] [vendorRegex]
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { isGlCoded } from './bill-draft';
import type { RampDraftSelection } from './bill-draft';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

interface DraftLine { memo?: string | null; amount?: { amount?: number } | null; accounting_field_selections?: RampDraftSelection[] }
interface Draft {
  id?: string;
  invoice_number?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { name?: string | null } | null;
  bill_owner?: { first_name?: string | null; last_name?: string | null } | null;
  line_items?: DraftLine[];
  invoice_urls?: string[];
}
interface DraftPage { data?: Draft[]; page?: { next?: string | null } }

interface VendorStat {
  vendor: string;
  drafts: number;
  cents: number;
  lines: number;
  coded: number;
  withPdf: number;
  multiLine: number;
  owners: Set<string>;
}

async function surveyEntity(entity: Entity, filter: RegExp | null): Promise<Map<string, VendorStat>> {
  const token = await rampToken(entity, 'bills:read');
  const drafts: Draft[] = [];
  let url: string | null = '/bills/drafts?page_size=100';
  for (let i = 0; i < 50 && url !== null; i++) {
    const res: { status: number; body: DraftPage } = await rampGet<DraftPage>(entity, url, token);
    if (res.status !== 200) break;
    const rows = res.body.data ?? [];
    drafts.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }

  const byVendor = new Map<string, VendorStat>();
  for (const d of drafts) {
    const vendor = d.vendor?.name ?? '(unnamed)';
    if (filter !== null && !filter.test(vendor)) continue;
    const lines = d.line_items ?? [];
    // isGlCoded, not "any selection": Medisca's drafts carry a Billable=false selection with a null
    // external_code, which counted as GL coding on the first pass and badly understated the backlog.
    const coded = lines.filter((l) => isGlCoded(l.accounting_field_selections)).length;
    const prev = byVendor.get(vendor) ?? { vendor, drafts: 0, cents: 0, lines: 0, coded: 0, withPdf: 0, multiLine: 0, owners: new Set<string>() };
    prev.drafts++;
    prev.cents += d.amount?.amount ?? 0;
    prev.lines += lines.length;
    prev.coded += coded;
    if ((d.invoice_urls ?? []).length > 0) prev.withPdf++;
    if (lines.length > 1) prev.multiLine++;
    const owner = `${d.bill_owner?.first_name ?? ''} ${d.bill_owner?.last_name ?? ''}`.trim();
    if (owner !== '') prev.owners.add(owner);
    byVendor.set(vendor, prev);
  }
  return byVendor;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const [entityArg, patternArg] = process.argv.slice(2);
  const entities: Entity[] = entityArg && entityArg !== 'all'
    ? [entityArg as Entity]
    : [...ALL_ENTITIES];
  for (const e of entities) {
    if (!ALL_ENTITIES.includes(e)) throw new Error(`Unknown entity ${e}`);
  }
  const filter = patternArg ? new RegExp(patternArg, 'i') : null;

  const totals = new Map<string, VendorStat>();
  for (const entity of entities) {
    const byVendor = await surveyEntity(entity, filter);
    for (const [vendor, s] of byVendor) {
      const prev = totals.get(vendor);
      if (prev === undefined) { totals.set(vendor, s); continue; }
      prev.drafts += s.drafts; prev.cents += s.cents; prev.lines += s.lines;
      prev.coded += s.coded; prev.withPdf += s.withPdf; prev.multiLine += s.multiLine;
      for (const o of s.owners) prev.owners.add(o);
    }
  }

  const rows = [...totals.values()].sort((a, b) => (b.lines - b.coded) - (a.lines - a.coded));
  console.log(`entities=${entities.join(',')}${filter ? ` filter=/${filter.source}/i` : ''}`);
  console.log(`${'vendor'.padEnd(44)} ${'drafts'.padStart(6)} ${'$'.padStart(13)} ${'lines'.padStart(6)} ${'uncoded'.padStart(7)} ${'pdf'.padStart(5)} ${'multi'.padStart(5)}  owners`);
  for (const r of rows) {
    console.log(
      `${r.vendor.slice(0, 44).padEnd(44)} ${String(r.drafts).padStart(6)} ${money(r.cents).padStart(13)} ` +
      `${String(r.lines).padStart(6)} ${String(r.lines - r.coded).padStart(7)} ${`${r.withPdf}/${r.drafts}`.padStart(5)} ` +
      `${`${r.multiLine}/${r.drafts}`.padStart(5)}  ${[...r.owners].join(', ')}`,
    );
  }
  const tot = rows.reduce((a, r) => ({ d: a.d + r.drafts, l: a.l + r.lines, u: a.u + (r.lines - r.coded), c: a.c + r.cents }), { d: 0, l: 0, u: 0, c: 0 });
  console.log(`\nTOTAL drafts=${tot.d} ${money(tot.c)} lines=${tot.l} uncoded=${tot.u}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
