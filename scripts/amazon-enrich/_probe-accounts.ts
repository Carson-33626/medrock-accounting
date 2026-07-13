// READ-ONLY. Dump raw /accounting/accounts fields for a few known GL accounts per entity so we
// resolve the CORRECT field_option_external_id for PATCH (memory: use external_id like FL Suspense=221,
// NOT the acctnum 8220 nor a ramp uuid). Run: cd web && npx tsx scripts/amazon-enrich/_probe-accounts.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
interface RawAcct { id?: string; external_id?: string; external_code?: string; code?: string; name?: string; ramp_id?: string }
interface Page { data: RawAcct[]; page?: { next?: string } }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'accounting:read');
    const all: RawAcct[] = [];
    let url: string | null = '/accounting/accounts?page_size=100';
    for (let i = 0; i < 10 && url; i++) {
      const { body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      all.push(...(body.data ?? []));
      url = body.page?.next ?? null;
      if (!(body.data ?? []).length) break;
    }
    console.log(`\n=== ${entity}: ${all.length} accounts | raw keys: ${Object.keys(all[0] ?? {}).sort().join(',')} ===`);
    const wanted = ['8220', '1220.15', '1220.10', '1220.20', '5000.25'];
    for (const w of wanted) {
      const a = all.find((x) => (x.external_code ?? x.code ?? '') === w);
      if (a) console.log(`   acctnum ${w}: id=${a.id} external_id=${a.external_id} external_code=${a.external_code} code=${a.code} name=${a.name}`);
      else console.log(`   acctnum ${w}: NOT FOUND`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
