// READ-ONLY: list every QuickBooks VENDOR option per entity whose name looks Amazon-ish, with its
// Ramp option id — the target values for "fix the vendor to be just amazon".
import '../receipt-enrichment/engines/ramp-split-push/load-env';
import { rampToken, rampGet } from '../receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from '../receipt-enrichment/engines/ramp-split-push/types';

// category_info.id for QuickbooksVendor, harvested live in probe-ramp-amazon-rule.ts.
const VENDOR_FIELD: Record<Entity, string> = {
  FL: '4ce19957-b8cc-41fd-aee5-3360ac334359',
  TN: '53ebc389-9564-4731-8d6e-097e86d4e6f7',
  TX: 'af058668-8384-4d36-acd9-ce9ffed89cbc',
};

interface Opt { id: string; value: string; code?: string | null }
interface OptPage { data: Opt[]; page?: { next?: string } }

async function main(): Promise<void> {
  for (const entity of ['FL', 'TN', 'TX'] as Entity[]) {
    const token = await rampToken(entity, 'accounting:read');
    const all: Opt[] = [];
    let url: string | null = `/accounting/field-options?field_id=${VENDOR_FIELD[entity]}&page_size=100`;
    for (let i = 0; i < 80 && url !== null; i++) {
      const res: { status: number; body: OptPage } = await rampGet<OptPage>(entity, url, token);
      if (res.status !== 200) { console.log(`${entity}: HTTP ${res.status}`); break; }
      const rows = res.body.data ?? [];
      all.push(...rows);
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
    const amz = all.filter((o) => /amazon|amzn|\baws\b/i.test(o.value));
    console.log(`\n${entity}: ${all.length} vendor options total`);
    for (const o of amz) console.log(`   "${o.value}"  id=${o.id}  code=${o.code ?? ''}`);
    if (amz.length === 0) console.log('   (no Amazon-ish vendor option)');
  }
}
main().catch((e: Error) => { console.error(e); process.exit(1); });
