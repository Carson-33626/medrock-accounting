// READ-ONLY audit: every Amazon Ramp transaction in a date window (default April+May 2026), across all
// entities, flagged for what it still needs — a receipt, an itemized split/coding, or both. Built to
// confirm the books can close: nothing is written to Ramp.
//   npx tsx scripts/amazon-csv-enrich/audit-ramp.ts [--from 2026-04-01] [--to 2026-05-31] [--pages 200]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

const OUT = 'scripts/amazon-csv-enrich/out/_audit';
function argVal(flag: string, def: string): string { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

interface RawLine { memo?: string | null }
interface RawTxn {
  id: string; amount: number; user_transaction_time?: string; merchant_name: string | null;
  sync_status?: string; card_holder?: { first_name?: string; last_name?: string } | null;
  line_items?: RawLine[]; receipts?: string[];
}
interface Page { data: RawTxn[]; page?: { next?: string } }

const isAmazon = (n: string | null): boolean => /amazon/i.test(n ?? '');
// Enriched = itemized by us/Engine A or Amy: >1 line, or a single line carrying a product memo.
function isEnriched(t: RawTxn): boolean {
  const lines = t.line_items ?? [];
  if (lines.length > 1) return true;
  return lines.some((l) => (l.memo ?? '').trim().length > 0);
}

interface Row {
  entity: Entity; id: string; date: string; amount: number; merchant: string; sync: string;
  receipts: number; lines: number; enriched: boolean; holder: string; status: string;
}

async function auditEntity(entity: Entity, from: string, to: string, maxPages: number): Promise<Row[]> {
  const token = await rampToken(entity, 'transactions:read');
  const rows: Row[] = [];
  let url: string | null = `/transactions?page_size=100&order_by_date_desc=true&from_date=${from}T00:00:00Z&to_date=${to}T23:59:59Z`;
  for (let i = 0; i < maxPages && url; i++) {
    const { status, body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    if (status !== 200) break;
    const data = body.data ?? [];
    if (!data.length) break;
    let allOlder = true;
    for (const t of data) {
      const date = (t.user_transaction_time ?? '').slice(0, 10);
      if (date && date >= from) allOlder = false;
      if (!date || date < from || date > to) continue; // client-side window guard (robust to server filter)
      if (!isAmazon(t.merchant_name)) continue;
      const receipts = t.receipts?.length ?? 0;
      const lines = t.line_items?.length ?? 0;
      const enriched = isEnriched(t);
      const synced = t.sync_status && t.sync_status !== 'NOT_SYNC_READY';
      const status = synced ? `SYNCED(${t.sync_status})`
        : (!receipts && !enriched) ? 'NEEDS_BOTH'
        : (!receipts) ? 'NEEDS_RECEIPT'
        : (!enriched) ? 'NEEDS_SPLIT'
        : 'DONE';
      rows.push({
        entity, id: t.id, date, amount: t.amount, merchant: t.merchant_name ?? '', sync: t.sync_status ?? '',
        receipts, lines, enriched, holder: t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : '', status,
      });
    }
    // desc order: once an entire page is older than `from`, we've passed the window.
    if (allOlder) break;
    url = body.page?.next ?? null;
  }
  return rows;
}

async function main(): Promise<void> {
  const from = argVal('--from', '2026-04-01');
  const to = argVal('--to', '2026-05-31');
  const maxPages = Number(argVal('--pages', '200')) || 200;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const all: Row[] = [];
  for (const e of ALL_ENTITIES) {
    const rows = await auditEntity(e, from, to, maxPages);
    all.push(...rows);
    console.log(`  ${e}: ${rows.length} Amazon txns in ${from}..${to}`);
  }

  const header = 'entity,txn_id,date,amount,sync_status,receipts,lines,enriched,card_holder,status';
  const lines = all.sort((a, b) => (a.entity + a.date).localeCompare(b.entity + b.date))
    .map((r) => [r.entity, r.id, r.date, r.amount.toFixed(2), r.sync, r.receipts, r.lines, r.enriched ? 'y' : 'n', r.holder, r.status].map(csv).join(','));
  writeFileSync(`${OUT}/amazon_apr_may_audit.csv`, [header, ...lines].join('\n'));

  // Summary by status, and a $ tally of what still needs work.
  const byStatus = new Map<string, { n: number; amt: number }>();
  for (const r of all) { const k = r.status.startsWith('SYNCED') ? 'SYNCED' : r.status; const c = byStatus.get(k) ?? { n: 0, amt: 0 }; c.n++; c.amt += r.amount; byStatus.set(k, c); }
  console.log(`\n=== Amazon ${from}..${to} — ${all.length} txns across ${ALL_ENTITIES.join('/')} ===`);
  for (const [k, v] of [...byStatus.entries()].sort()) console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)}  $${v.amt.toFixed(2)}`);
  const needsWork = all.filter((r) => r.status.startsWith('NEEDS'));
  console.log(`\nNEEDS WORK: ${needsWork.length} txns ($${needsWork.reduce((s, r) => s + r.amount, 0).toFixed(2)})`);
  const byEntity = new Map<Entity, number>();
  for (const r of needsWork) byEntity.set(r.entity, (byEntity.get(r.entity) ?? 0) + 1);
  console.log('  by entity: ' + [...byEntity.entries()].map(([e, n]) => `${e}=${n}`).join(', '));
  console.log(`\nWrote ${OUT}/amazon_apr_may_audit.csv`);
}
main().catch((e) => { console.error(e); process.exit(1); });
