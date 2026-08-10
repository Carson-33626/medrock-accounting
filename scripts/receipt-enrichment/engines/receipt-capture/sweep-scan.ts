// The sweep's S1/S4 scan: every CLEARED, un-SYNCED Ramp txn with NO receipt. Pure module —
// run-sweep.ts drives it; snapshot CSVs land under out/sweep/. Read-only against Ramp.
import { rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

export interface RawScanTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  memo: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  all_requirements_met_and_approved: boolean | null;
}
interface Page { data: RawScanTxn[]; page?: { next?: string } }

export interface ScanRow {
  entity: Entity;
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
  holder: string;
  memo: string;
  syncStatus: string;
  approved: boolean;
}

export function isScanRow(t: RawScanTxn): boolean {
  return t.state === 'CLEARED' && t.sync_status !== 'SYNCED' && (t.receipts ?? []).length === 0;
}

export async function scanEntity(entity: Entity, token: string, pages = 200): Promise<ScanRow[]> {
  const out: ScanRow[] = [];
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && url !== null; i++) {
    let res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    for (let attempt = 0; res.status !== 200 && attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      res = await rampGet<Page>(entity, url, token);
    }
    if (res.status !== 200) throw new Error(`Ramp ${entity} sweep-scan page ${i} HTTP ${res.status}`);
    const rows: RawScanTxn[] = res.body.data ?? [];
    for (const t of rows) {
      if (!isScanRow(t)) continue;
      const h = t.card_holder;
      out.push({
        entity,
        id: t.id,
        date: (t.user_transaction_time ?? '').slice(0, 10),
        amountCents: Math.round(t.amount * 100),
        merchant: t.merchant_name ?? '(none)',
        holder: h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() : '',
        memo: t.memo ?? '',
        syncStatus: t.sync_status ?? '(none)',
        approved: t.all_requirements_met_and_approved === true,
      });
    }
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}

export function rollupByMerchant(rows: ScanRow[]): { merchant: string; n: number; cents: number }[] {
  const by = new Map<string, { n: number; cents: number }>();
  for (const r of rows) {
    const m = by.get(r.merchant) ?? { n: 0, cents: 0 };
    m.n++;
    m.cents += Math.abs(r.amountCents);
    by.set(r.merchant, m);
  }
  return [...by.entries()].map(([merchant, v]) => ({ merchant, ...v })).sort((a, b) => b.cents - a.cents);
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SCAN_CSV_HEADER = 'entity,txn_id,date,amount,merchant,cardholder,sync_status,approved,memo';

export function scanCsvLine(r: ScanRow): string {
  return [r.entity, r.id, r.date, (r.amountCents / 100).toFixed(2), r.merchant, r.holder, r.syncStatus, r.approved ? 'Y' : 'N', r.memo].map(csv).join(',');
}
