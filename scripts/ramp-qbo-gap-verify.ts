// READ-ONLY follow-up to ramp-qbo-gap-scan: for the Ramp txns marked SYNCED but not
// matched in QB, hunt harder — same amount at ANY date, and across ALL purchase accounts
// (not just the Ramp card account). Distinguishes "matcher miss" from "genuinely absent".
// Run from web/ dir:  npx tsx scripts/ramp-qbo-gap-verify.ts
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';
import { ENTITY_TO_QB_LOCATION } from './receipt-enrichment/engines/ramp-split-push/types';
import { qbQueryAll } from '../src/lib/quickbooks-multi';

interface QBRef { value: string; name?: string }
interface QBPurchaseRaw {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  AccountRef?: QBRef;
  EntityRef?: QBRef;
  PrivateNote?: string;
}
interface MissRow {
  entity: Entity;
  id: string;
  date: string;
  merchant: string;
  holder: string;
  amount: number;
  syncedAt: string;
}

function parseCsv(path: string): MissRow[] {
  const lines = readFileSync(path, 'utf8').split('\n').slice(1);
  const out: MissRow[] = [];
  for (const line of lines) {
    // fields we need are never quoted (entity/id/date/amount/sync_status); merchant/holder may be
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (q) {
        if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    if (cells.length < 8 || cells[6] !== 'SYNCED') continue;
    out.push({
      entity: cells[0] as Entity,
      id: cells[1],
      date: cells[2],
      merchant: cells[3],
      holder: cells[4],
      amount: Number(cells[5]),
      syncedAt: cells[7],
    });
  }
  return out;
}

async function main(): Promise<void> {
  const misses = parseCsv(join(__dirname, 'out', 'ramp-qbo-missing.csv'));
  console.log(`Verifying ${misses.length} SYNCED-but-unmatched Ramp txns...\n`);
  const byEntity = new Map<Entity, MissRow[]>();
  for (const m of misses) {
    const list = byEntity.get(m.entity) ?? [];
    list.push(m);
    byEntity.set(m.entity, list);
  }
  for (const [entity, rows] of byEntity) {
    const location = ENTITY_TO_QB_LOCATION[entity];
    const all = await qbQueryAll<QBPurchaseRaw>(location, 'Purchase', '');
    const byCents = new Map<number, QBPurchaseRaw[]>();
    for (const p of all) {
      const c = Math.abs(Math.round((p.TotalAmt ?? 0) * 100));
      const list = byCents.get(c) ?? [];
      list.push(p);
      byCents.set(c, list);
    }
    for (const m of rows) {
      const cents = Math.abs(Math.round(m.amount * 100));
      const cands = byCents.get(cents) ?? [];
      console.log(`${entity} ${m.date} ${m.merchant} / ${m.holder} $${m.amount.toFixed(2)} (synced_at ${m.syncedAt.slice(0, 10)})`);
      if (cands.length === 0) {
        console.log('   -> NO purchase with this amount anywhere in QB — genuinely absent');
      } else {
        for (const c of cands.slice(0, 5)) {
          console.log(
            `   -> candidate Purchase ${c.Id} ${c.TxnDate} acct="${c.AccountRef?.name ?? '?'}" payee="${c.EntityRef?.name ?? '?'}" note="${(c.PrivateNote ?? '').slice(0, 60)}"`,
          );
        }
        if (cands.length > 5) console.log(`   -> (+${cands.length - 5} more candidates)`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
