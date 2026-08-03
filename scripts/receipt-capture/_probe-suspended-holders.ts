// Diagnostic: how many open receiptless txns sit on a SUSPENDED cardholder? Ramp's receipts
// endpoint rejects those uploads with a misleading "User does not exist" (DEVELOPER_7002), and the
// failed attempt burns the idempotency key. READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-suspended-holders.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
  card_holder: { user_id?: string; first_name?: string; last_name?: string } | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface Holder { name: string; entity: Entity; txns: number; cents: number; merchants: Set<string> }

async function main(): Promise<void> {
  const byUser = new Map<string, Holder>();

  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 200 && url !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      for (const t of rows) {
        if (t.state !== 'CLEARED' || t.sync_status === 'SYNCED') continue;
        if ((t.receipts ?? []).length > 0) continue;
        const uid = t.card_holder?.user_id;
        if (uid === undefined) continue;
        const key = `${entity}|${uid}`;
        const h = byUser.get(key) ?? {
          name: `${t.card_holder?.first_name ?? ''} ${t.card_holder?.last_name ?? ''}`.trim(),
          entity,
          txns: 0,
          cents: 0,
          merchants: new Set<string>(),
        };
        h.txns++;
        h.cents += Math.abs(Math.round(t.amount * 100));
        h.merchants.add(t.merchant_name ?? '(blank)');
        byUser.set(key, h);
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
  }

  console.log(`distinct (entity, cardholder) pairs holding receiptless txns: ${byUser.size}\n`);
  console.log('status            entity  txns          $  cardholder            top merchants');

  const rows: { status: string; entity: Entity; txns: number; cents: number; name: string; merchants: string }[] = [];
  for (const [key, h] of byUser) {
    const [entity, uid] = key.split('|') as [Entity, string];
    const u = await rampGet<{ status?: string }>(entity, `/users/${uid}`, await rampToken(entity, 'users:read'));
    const status = u.status === 200 ? (u.body.status ?? '(none)') : `HTTP ${u.status}`;
    rows.push({ status, entity, txns: h.txns, cents: h.cents, name: h.name, merchants: [...h.merchants].slice(0, 3).join(', ') });
  }

  for (const r of rows.sort((a, b) => (a.status === b.status ? b.cents - a.cents : a.status.localeCompare(b.status)))) {
    console.log(
      `${r.status.padEnd(17)} ${r.entity.padEnd(6)} ${String(r.txns).padStart(4)} ${(r.cents / 100).toFixed(2).padStart(10)}  ${r.name.slice(0, 20).padEnd(21)} ${r.merchants.slice(0, 44)}`,
    );
  }

  const bad = rows.filter((r) => r.status !== 'USER_ACTIVE');
  const badTxns = bad.reduce((s, r) => s + r.txns, 0);
  const badCents = bad.reduce((s, r) => s + r.cents, 0);
  console.log(`\nNON-ACTIVE cardholders: ${bad.length} | ${badTxns} txns | $${(badCents / 100).toFixed(2)} — every receipt upload for these will 7002 and burn its key.`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
