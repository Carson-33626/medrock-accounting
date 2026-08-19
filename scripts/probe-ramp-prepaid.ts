/**
 * READ-ONLY (Barbara, 2026-08-19): every 2026 Ramp transaction and bill whose accounting
 * coding points at a Prepaid account, across FL/TN/TX — the Ramp half of the prepaid
 * account inspection (QB GL half pulled separately).
 *   npx tsx scripts/probe-ramp-prepaid.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import { rampToken, rampGet } from './lib/ramp';
import type { Entity } from './lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface Page<T> { data?: T[]; page?: { next?: string | null } }
interface JsonRecord { [k: string]: unknown }

function findPrepaidStrings(obj: unknown, hits: Set<string>): void {
  if (typeof obj === 'string') {
    if (obj.toLowerCase().includes('prepaid')) hits.add(obj);
    return;
  }
  if (Array.isArray(obj)) { for (const x of obj) findPrepaidStrings(x, hits); return; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj as JsonRecord)) findPrepaidStrings(v, hits); }
}

async function scan(entity: Entity, kind: 'transactions' | 'bills', token: string, firstUrl: string,
  describe: (item: JsonRecord, codes: string[]) => string): Promise<{ n: number; total: number }> {
  let url: string | null = firstUrl;
  let n = 0;
  let total = 0;
  while (url) {
    const res: { status: number; body: Page<JsonRecord> } = await rampGet<Page<JsonRecord>>(entity, url, token);
    const { status, body } = res;
    if (status !== 200) throw new Error(`${entity} ${kind} HTTP ${status}`);
    for (const item of body.data ?? []) {
      const hits = new Set<string>();
      findPrepaidStrings(item, hits);
      if (hits.size === 0) continue;
      n++;
      const line = describe(item, [...hits]);
      console.log(`   ${line}`);
      const amt = typeof item.amount === 'number' ? item.amount
        : typeof (item.amount as JsonRecord | undefined)?.amount === 'number' ? ((item.amount as JsonRecord).amount as number) / 100
        : 0;
      total += amt;
    }
    url = body.page?.next ?? null;
  }
  return { n, total };
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n########## RAMP ${entity} ##########`);
    const token = await rampToken(entity, 'transactions:read bills:read');

    console.log(`--- card transactions coded to Prepaid (2026) ---`);
    const t = await scan(entity, 'transactions', token,
      `/transactions?from_date=2026-01-01T00:00:00Z&page_size=100`,
      (txn, codes) => {
        const merchant = String(txn.merchant_name ?? '?');
        const user = (txn.card_holder as JsonRecord | undefined);
        const holder = user ? `${String(user.first_name ?? '')} ${String(user.last_name ?? '')}`.trim() : '?';
        const date = String(txn.user_transaction_time ?? '').slice(0, 10);
        const amt = typeof txn.amount === 'number' ? txn.amount : 0;
        const memo = String(txn.memo ?? '');
        const receipts = Array.isArray(txn.receipts) ? txn.receipts.length : 0;
        return `${date} ${money(amt).padStart(11)}  ${merchant}  [${holder}]  receipts=${receipts}  memo=${memo.slice(0, 60)}  -> ${codes.join(' | ')}`;
      });
    console.log(`   = ${t.n} transaction(s), ${money(t.total)}`);

    console.log(`--- bills with a Prepaid-coded line (2026) ---`);
    const b = await scan(entity, 'bills', token,
      `/bills?from_issued_at=2026-01-01T00:00:00Z&page_size=100`,
      (bill, codes) => {
        const vendor = (bill.vendor as JsonRecord | undefined);
        const vname = vendor ? String(vendor.remote_name ?? vendor.name ?? '?') : '?';
        const inv = String(bill.invoice_number ?? '');
        const date = String(bill.issued_at ?? '').slice(0, 10);
        const amtObj = bill.amount as JsonRecord | undefined;
        const amt = amtObj && typeof amtObj.amount === 'number' ? (amtObj.amount as number) / 100 : 0;
        return `${date} ${money(amt).padStart(11)}  ${vname} #${inv}  -> ${codes.join(' | ')}`;
      });
    console.log(`   = ${b.n} bill(s), ${money(b.total)}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
