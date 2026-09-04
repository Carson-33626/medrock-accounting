/**
 * READ-ONLY (books sweep L7). sweep-L7-carrier-and-fringe.ts found zero dental/vision carrier
 * Bills/Purchases under common carrier names (Delta Dental, VSP, Guardian, MetLife, Cigna,
 * UnitedHealth, Humana, Principal) despite ADP withholding real dental/vision EE premiums every
 * pay period. Before concluding "no separate carrier bill exists", check the actual Vendor list
 * for anything dental/vision-shaped by name, per entity.
 *
 *   npx tsx scripts/payroll/sweep-L7-dental-vision-vendor-search.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
interface QbVendor { Id?: string; DisplayName?: string; Active?: boolean }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n=== ${entity}: vendors matching dental|vision|aetna|insur|benefit|life ins ===`);
    const vendors = await qbQueryAll<QbVendor>(entity, 'Vendor', '');
    const hits = vendors.filter((v) => /dental|vision|aetna|insur|benefit|life\s*ins/i.test(v.DisplayName ?? ''));
    for (const v of hits) console.log(`  ${v.DisplayName}  (Id=${v.Id}, active=${v.Active})`);
    if (hits.length === 0) console.log('  (none)');
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
