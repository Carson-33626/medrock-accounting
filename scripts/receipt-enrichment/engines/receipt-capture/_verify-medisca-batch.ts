// Read back EVERY Medisca draft from Ramp after the 2026-08-05 create+enrich batch — the writes
// claimed success, this is the proof. For each draft: line count, GL-coded line count, sum vs
// total, attachment count. Cross-checked against the local create registry.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_verify-medisca-batch.ts
import '../ramp-split-push/load-env';
import { readFileSync } from 'node:fs';
import { listDraftBills, isGlCoded } from './bill-draft';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import { RC } from '../../paths';

const VENDOR_RE = /medisca/i;

interface Registry { [invoice: string]: { draftId: string; entity: string } }

interface Detail {
  id: string;
  invoice_number?: string | null;
  amount?: { amount?: number } | null;
  invoice_urls?: string[];
  line_items?: { amount?: { amount?: number }; accounting_field_selections?: Parameters<typeof isGlCoded>[0] }[];
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(`${RC.out}/medisca-consumed.json`, 'utf8')) as Registry;
  const createdIds = new Set(Object.values(registry).map((r) => r.draftId));
  console.log(`registry: ${createdIds.size} created draft(s)\n`);

  let drafts = 0; let fullyCoded = 0; let uncoded = 0; let partial = 0; let sumBad = 0; let noPdf = 0;
  const createdSeen = new Set<string>();

  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read accounting:read');
    const list = (await listDraftBills(entity, token, rampGet)).filter((d) => VENDOR_RE.test(d.vendor?.name ?? ''));
    for (const head of list) {
      const res = await rampGet<Detail>(entity, `/bills/drafts/${head.id}`, token);
      const d = res.body;
      drafts++;
      if (createdIds.has(d.id)) createdSeen.add(d.id);
      const lines = d.line_items ?? [];
      const coded = lines.filter((l) => isGlCoded(l.accounting_field_selections)).length;
      const sum = lines.reduce((a, l) => a + (l.amount?.amount ?? 0), 0);
      const total = d.amount?.amount ?? 0;
      const pdfs = (d.invoice_urls ?? []).length;
      const tag = createdIds.has(d.id) ? 'CREATED' : 'HERS';
      if (coded === lines.length && lines.length > 0) fullyCoded++;
      else if (coded === 0) uncoded++;
      else partial++;
      if (sum !== total) sumBad++;
      if (pdfs === 0) noPdf++;
      const flag = (coded > 0 && coded < lines.length) || sum !== total ? '  <-- PROBLEM' : '';
      if (flag || coded === 0) {
        console.log(`[${entity}] ${tag.padEnd(7)} ${d.invoice_number} lines=${lines.length} coded=${coded} sum=${(sum / 100).toFixed(2)} total=${(total / 100).toFixed(2)} pdfs=${pdfs}${flag}`);
      }
    }
    console.log(`[${entity}] scanned ${list.length} draft(s)`);
  }

  console.log(`\nTOTAL drafts=${drafts} fullyCoded=${fullyCoded} uncoded=${uncoded} PARTIAL=${partial} sumMismatch=${sumBad} noPdf=${noPdf}`);
  const missing = [...createdIds].filter((id) => !createdSeen.has(id));
  console.log(`created drafts present in Ramp: ${createdSeen.size}/${createdIds.size}${missing.length ? ` MISSING: ${missing.join(', ')}` : ''}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
