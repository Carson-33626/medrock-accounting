/** READ-ONLY: does QBO accept `WHERE FileName = '...'` on Attachable? That query is the
 *  idempotency check in je-attach, and an unsupported filter would silently return nothing.
 *  GETs only. Untracked scratch. */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Location } from '../../src/lib/quickbooks-multi';

interface Row { Id: string; FileName?: string; ContentType?: string; Size?: number }

async function main(): Promise<void> {
  const location: Location = 'MedRock TX';
  const name = 'TX PTO 2026.03.xlsx';

  try {
    const hit = await qbQueryAll<Row>(location, 'Attachable', `WHERE FileName = '${name}'`);
    console.log(`WHERE FileName = '${name}': ${hit.length} row(s)`);
    for (const r of hit.slice(0, 5)) console.log(`  #${r.Id} ${r.FileName} ${r.ContentType} ${r.Size}`);
  } catch (e) {
    console.log('FileName filter FAILED:', e instanceof Error ? e.message.slice(0, 300) : e);
  }

  try {
    const miss = await qbQueryAll<Row>(location, 'Attachable', `WHERE FileName = 'ZZ_does_not_exist.xlsx'`);
    console.log(`WHERE FileName = 'ZZ_does_not_exist.xlsx': ${miss.length} row(s) (expect 0)`);
  } catch (e) {
    console.log('negative-control filter FAILED:', e instanceof Error ? e.message.slice(0, 300) : e);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
