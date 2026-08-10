// Stop-the-line check: does any invoice the dry run wants to CREATE already exist as a QuickBooks
// Bill? A single hit means the dedupe is unsafe and nothing may go live. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-create-audit.ts
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../../../src/lib/quickbooks-multi';
import { readFileSync, existsSync } from 'node:fs';
import { RC } from '../../paths';

interface QBRef { value: string; name?: string }
interface QBBill { Id: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; VendorRef?: QBRef }

function planRows(entity: Entity): { invoice: string; verdict: string; total: string }[] {
  const path = `${RC.out}/letco-plan-${entity}.csv`;
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return { invoice: c[0] ?? '', verdict: c[8] ?? '', total: c[5] ?? '' };
  });
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

async function main(): Promise<void> {
  let totalCreate = 0;
  let collisions = 0;

  for (const entity of ALL_ENTITIES) {
    const rows = planRows(entity);
    if (rows.length === 0) {
      console.log(`[${entity}] no plan CSV — skipped`);
      continue;
    }
    const creates = rows.filter((r) => r.verdict === 'create');
    totalCreate += creates.length;

    // Every Letco Bill DocNumber QuickBooks knows about, for this entity, all time since 2024.
    const bills = (await qbQueryAll<QBBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '2024-01-01'`))
      .filter((b) => /letco|fagron/i.test(b.VendorRef?.name ?? ''));
    const known = new Set(bills.map((b) => norm(b.DocNumber ?? '')));

    console.log(`\n[${entity}] plan rows ${rows.length} | create ${creates.length} | QB Letco bills known ${known.size}`);
    for (const c of creates) {
      if (known.has(norm(c.invoice))) {
        collisions++;
        console.log(`  *** COLLISION: ${c.invoice} (total ${c.total}) is marked CREATE but already exists in QuickBooks`);
      }
    }
    if (creates.length > 0 && collisions === 0) console.log(`  none of the ${creates.length} create rows exist in QB — clean`);
  }

  console.log(`\n=== VERDICT ===`);
  console.log(`create rows across entities: ${totalCreate}`);
  console.log(
    collisions === 0
      ? 'CLEAN — no invoice marked create already exists in QuickBooks. Dedupe holds.'
      : `STOP THE LINE — ${collisions} invoice(s) marked create already exist in QuickBooks.`,
  );
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
