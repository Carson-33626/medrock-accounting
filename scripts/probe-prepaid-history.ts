/**
 * READ-ONLY (Ash via Carson, 2026-08-19): full order history for the Prepaid - Other
 * vendors, at LINE-ITEM level, so re-order gaps reveal how long each item lasts
 * (the accrual/amortization window). Pulls Ramp bills back to 2024 for FL + TN.
 *   npx tsx scripts/probe-prepaid-history.ts
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

const ENTITIES: Entity[] = ['FL', 'TN'];
const VENDOR_RE = /kingsway|smartdollar|smart dollar|nabp/i;
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface JsonRecord { [k: string]: unknown }
interface Page { data?: JsonRecord[]; page?: { next?: string | null } }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n########## RAMP ${entity} — prepaid-vendor bill history (line items) ##########`);
    const token = await rampToken(entity, 'bills:read');
    let url: string | null = `/bills?from_issued_at=2024-01-01T00:00:00Z&page_size=100`;
    const bills: JsonRecord[] = [];
    while (url) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) throw new Error(`${entity} bills HTTP ${res.status}`);
      bills.push(...(res.body.data ?? []));
      url = res.body.page?.next ?? null;
    }
    const wanted = bills.filter((b) => {
      const v = b.vendor as JsonRecord | undefined;
      const name = String(v?.remote_name ?? v?.name ?? '');
      return VENDOR_RE.test(name);
    });
    wanted.sort((a, b) => String(a.issued_at ?? '').localeCompare(String(b.issued_at ?? '')));
    console.log(`${wanted.length} bill(s) from prepaid vendors (of ${bills.length} total)`);
    for (const b of wanted) {
      const v = b.vendor as JsonRecord | undefined;
      const vname = String(v?.remote_name ?? v?.name ?? '?');
      const amtObj = b.amount as JsonRecord | undefined;
      const amt = amtObj && typeof amtObj.amount === 'number' ? (amtObj.amount as number) / 100 : 0;
      console.log(`\n  ${String(b.issued_at ?? '').slice(0, 10)}  ${vname}  #${String(b.invoice_number ?? '')}  ${money(amt)}`);
      const items = (b.line_items as JsonRecord[] | undefined) ?? [];
      for (const li of items) {
        const liAmt = (li.amount as JsonRecord | undefined);
        const cents = liAmt && typeof liAmt.amount === 'number' ? (liAmt.amount as number) / 100 : (typeof li.amount === 'number' ? li.amount : 0);
        const acct = JSON.stringify(li.accounting_field_selections ?? '').includes('Prepaid') ? ' [PREPAID]' : '';
        console.log(`     ${money(cents).padStart(11)}  ${String(li.memo ?? li.description ?? '').slice(0, 90)}${acct}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
