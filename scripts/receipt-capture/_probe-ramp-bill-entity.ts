// Gate for the live pilot: is `entity_id` required on a Ramp bill for this account's multi-entity
// setup, or is the entity already implied by which OAuth token created it?
//
// Empirical answer: read bills Ramp ALREADY holds (50 Letco bills arrived via Ramp Bill Pay) and
// see whether they carry an entity field at all. READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-ramp-bill-entity.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';

interface RampBillRaw {
  id: string;
  invoice_number?: string | null;
  vendor?: { name?: string | null } | null;
  remote_id?: string | null;
  [key: string]: unknown;
}
interface BillsPage { data?: RampBillRaw[]; page?: { next?: string | null } }

async function main(): Promise<void> {
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read');
    const res = await rampGet<BillsPage>(entity, '/bills?page_size=25', token);
    const bills = res.body.data ?? [];
    console.log(`\n=== ${entity}: HTTP ${res.status}, ${bills.length} bills sampled ===`);
    if (bills.length === 0) continue;

    // Which keys does Ramp actually return on a bill? Look for anything entity-shaped.
    const keys = new Set<string>();
    for (const b of bills) for (const k of Object.keys(b)) keys.add(k);
    const entityish = [...keys].filter((k) => /entity|business|company|subsidiar/i.test(k));
    console.log(`  entity-shaped keys present: ${entityish.length === 0 ? '(NONE)' : entityish.join(', ')}`);

    for (const k of entityish) {
      const values = new Set(bills.map((b) => JSON.stringify(b[k])));
      console.log(`    ${k}: ${[...values].slice(0, 4).join(' | ')}`);
    }

    const letco = bills.filter((b) => /letco|fagron/i.test(b.vendor?.name ?? ''));
    console.log(`  Letco bills in sample: ${letco.length}`);
    if (letco.length > 0) {
      const sample = letco[0];
      console.log(`    sample invoice_number=${sample.invoice_number ?? '-'} remote_id=${sample.remote_id ?? '-'}`);
      for (const k of entityish) console.log(`    sample ${k} = ${JSON.stringify(sample[k])}`);
    }
  }

  console.log(
    '\nREAD: if no entity-shaped key exists on bills Ramp itself created, the entity is implied by the OAuth token' +
    '\n      (each entity has its own RAMP_<ENT>_CLIENT_ID/SECRET) and omitting entity_id on create is correct.',
  );
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
