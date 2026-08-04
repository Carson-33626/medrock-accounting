// One-time lookup: Letco's Ramp vendor id per entity, and the GL field/option external ids that
// draft-bill lines must carry (1220.10 Inventory Asset : Compound Ingredient Inventory,
// 5000.45 COGS : Shipping & Handling - COGS Purchases — see letco-gl.ts). READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-ramp-bill-setup.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken, getRampAccounts, getRampFields } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import { LETCO_PRODUCT_ACCOUNT, LETCO_SHIPPING_ACCOUNT } from './letco-gl';

interface RampVendor { id: string; name?: string; is_active?: boolean }
interface VendorPage { data?: RampVendor[]; page?: { next?: string } }

// The GL category selector on line_items is a Ramp *system* field, not a custom one — every prior
// integration (amazon-enrich/split.ts, walmart-enrich, amazon-csv-enrich) hardcodes this literal
// rather than looking it up, and their live rollback JSON confirms it round-trips through Ramp
// unchanged. Still cross-checked against /accounting/fields below rather than trusted blind.
const EXPECTED_GL_FIELD_EXTERNAL_ID = 'QuickbooksCategory';

async function main(): Promise<void> {
  // WRONG SOURCE — kept only for reference. /accounting/vendors returns the ACCOUNTING-provider
  // (QBO) vendor ids; feeding one to POST /bills gets HTTP 422 {"vendor_id":["Not a valid UUID."]},
  // which is exactly how the 2026-08-04 FL live pilot failed. The Bills API wants the Bill Pay
  // vendor UUID from GET /vendors — use _probe-billpay-vendor-id.ts for LETCO_RAMP_VENDOR_*.
  console.log('=== Step 1: Letco vendor id per entity (ACCOUNTING ids — NOT the bill vendor_id) ===');
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'accounting:read');
    let url: string | null = '/accounting/vendors?page_size=100';
    const hits: RampVendor[] = [];
    for (let i = 0; i < 50 && url !== null; i++) {
      const res: { status: number; body: VendorPage } = await rampGet<VendorPage>(entity, url, token);
      if (res.status !== 200) break;
      for (const v of res.body.data ?? []) {
        if (/letco|fagron/i.test(v.name ?? '')) hits.push(v);
      }
      url = res.body.page?.next ?? null;
    }
    console.log(`[${entity}] Letco/Fagron vendor matches:`);
    for (const v of hits) console.log(`   id=${v.id}  active=${v.is_active ?? '?'}  "${v.name}"`);
    if (hits.length === 0) console.log('   NONE — the vendor must exist in Ramp before a draft bill can reference it.');
  }

  console.log('\n=== Step 2: GL field external id (system field, cross-checked) ===');
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'accounting:read');
    const fields = await getRampFields(entity, token);
    const match = fields.find((f) => f.id === EXPECTED_GL_FIELD_EXTERNAL_ID);
    console.log(`[${entity}] fields: ${fields.map((f) => f.id).join(', ') || '(none returned)'}`);
    console.log(`[${entity}] "${EXPECTED_GL_FIELD_EXTERNAL_ID}" present: ${match ? 'YES' : 'NO (not listed — may still be valid as an implicit system field; see amazon-enrich precedent)'}`);
  }

  console.log(`\n=== Step 3: GL option ids for ${LETCO_PRODUCT_ACCOUNT} and ${LETCO_SHIPPING_ACCOUNT} (per entity — option ids are entity-specific) ===`);
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'accounting:read');
    const accounts = await getRampAccounts(entity, token);
    const product = accounts.find((a) => a.code === LETCO_PRODUCT_ACCOUNT);
    const shipping = accounts.find((a) => a.code === LETCO_SHIPPING_ACCOUNT);
    console.log(`[${entity}] ${LETCO_PRODUCT_ACCOUNT} -> ${product ? `id=${product.id} "${product.name}"` : 'NOT FOUND'}`);
    console.log(`[${entity}] ${LETCO_SHIPPING_ACCOUNT} -> ${shipping ? `id=${shipping.id} "${shipping.name}"` : 'NOT FOUND'}`);
  }

  console.log('\n=== Step 4 (bonus, read-only): does a bills:write token mint? ===');
  for (const entity of ALL_ENTITIES) {
    try {
      await rampToken(entity, 'bills:write');
      console.log(`[${entity}] bills:write token: OK`);
    } catch (e) {
      console.log(`[${entity}] bills:write token FAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
