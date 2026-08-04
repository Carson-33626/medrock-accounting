// Why: _probe-medisca-coverage.ts harvested ZERO account codes from the 35 already-coded Medisca
// drafts, even though the list response clearly reports those lines AS coded. Either the list's
// accounting_field_selections are abbreviated (no external_code) and only the detail fetch carries
// the account, or the harvest has a bug. That distinction decides whether the classifier can use
// Ramp's own coded drafts as a history source cheaply, or must fetch every draft individually.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-selection-shape.ts [FL|TN|TX] [vendorRegex]
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

interface Line { memo?: string | null; accounting_field_selections?: unknown[] }
interface Draft { id?: string; vendor?: { name?: string | null } | null; line_items?: Line[] }
interface Page { data?: Draft[] }

async function main(): Promise<void> {
  const entity = (process.argv[2] ?? 'FL') as Entity;
  const re = new RegExp(process.argv[3] ?? 'medisca', 'i');
  const token = await rampToken(entity, 'bills:read');

  const res = await rampGet<Page>(entity, '/bills/drafts?page_size=100', token);
  const drafts = (res.body.data ?? []).filter((d) => re.test(d.vendor?.name ?? ''));
  const coded = drafts.filter((d) => (d.line_items ?? []).some((l) => (l.accounting_field_selections ?? []).length > 0));
  console.log(`[${entity}] ${drafts.length} matching draft(s) on page 1, ${coded.length} with >=1 coded line`);
  if (coded.length === 0) return;

  const d = coded[0];
  const line = (d.line_items ?? []).find((l) => (l.accounting_field_selections ?? []).length > 0);
  console.log(`\ndraft ${d.id}  memo="${line?.memo ?? ''}"`);
  console.log(`LIST   selections: ${JSON.stringify(line?.accounting_field_selections)}`);

  const det = await rampGet<Draft>(entity, `/bills/drafts/${d.id}`, token);
  const dline = (det.body.line_items ?? []).find((l) => (l.accounting_field_selections ?? []).length > 0);
  console.log(`DETAIL selections: ${JSON.stringify(dline?.accounting_field_selections)}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
