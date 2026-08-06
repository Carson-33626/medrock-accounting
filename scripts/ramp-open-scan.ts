// READ-ONLY scan of Ramp "open" transactions (approval/documentation backlog) by month.
// Honors the dry-run mandate: zero writes. Run from web/ dir:  npx tsx scripts/ramp-open-scan.ts
import './ramp-split-push/load-env';
import { rampToken, rampGet } from './ramp-split-push/ramp-client';
import type { Entity } from './ramp-split-push/types';

const ENTITIES: Entity[] = ['TN', 'FL', 'TX'];
const SCOPE = 'transactions:read receipts:read users:read';

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  user_transaction_time: string | null;
  memo: string | null;
  receipts: string[] | null;
  merchant_name: string | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  accounting_field_selections: unknown[] | null;
  policy_violations: unknown[] | null;
  // requirement / approval flags — names verified at runtime via key dump below
  [k: string]: unknown;
}
interface Page {
  data: RawTxn[];
  page?: { next?: string };
}

async function pullAll(entity: Entity, token: string): Promise<RawTxn[]> {
  const out: RawTxn[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 100 && next !== null; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
    const status: number = res.status;
    const body: Page = res.body;
    if (status !== 200) {
      console.error(`  ${entity} page ${i} HTTP ${status}`);
      break;
    }
    const rows = body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    next = body.page?.next ?? null;
  }
  return out;
}

function ym(t: RawTxn): string {
  return (t.user_transaction_time ?? '').slice(0, 7) || 'unknown';
}
function holder(t: RawTxn): string {
  const h = t.card_holder;
  return h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() : '(none)';
}
function money(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  let dumped = false;
  const all: { entity: Entity; t: RawTxn }[] = [];

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);
    const txns = await pullAll(entity, token);
    console.error(`${entity}: pulled ${txns.length} txns`);
    if (!dumped && txns.length) {
      console.error('--- sample txn top-level keys ---');
      console.error(Object.keys(txns[0]).sort().join(', '));
      dumped = true;
    }
    for (const t of txns) all.push({ entity, t });
  }

  // "Open" = requirements not met and/or not approved. Detect the flag name defensively.
  const flagName = ['all_requirements_met_and_approved', 'requirements_met_and_approved'].find(
    (k) => all.length && k in all[0].t,
  );
  console.error(`\nApproval flag used: ${flagName ?? 'FALLBACK (state/memo/receipt heuristic)'}\n`);

  const isOpen = (t: RawTxn): boolean => {
    if (flagName) return t[flagName] === false;
    return false;
  };
  const missingMemo = (t: RawTxn): boolean => !t.memo || t.memo.trim() === '';
  const missingReceipt = (t: RawTxn): boolean => !t.receipts || t.receipts.length === 0;

  // group by month across all entities
  interface Bucket {
    count: number;
    cents: number;
    noMemo: number;
    noReceipt: number;
    docsOnly: number; // missing memo or receipt (fillable)
    approvalOnly: number; // docs present, just needs approval
  }
  const byMonth = new Map<string, Bucket>();
  const byMonthEntity = new Map<string, Bucket>();
  const openRows: { entity: Entity; t: RawTxn }[] = [];

  for (const { entity, t } of all) {
    if (t.state && t.state !== 'CLEARED') continue; // ignore pending/declined for "open work"
    if (!isOpen(t)) continue;
    openRows.push({ entity, t });
    const m = ym(t);
    const cents = Math.round(t.amount * 100);
    const docsMissing = missingMemo(t) || missingReceipt(t);
    for (const [key, map] of [
      [m, byMonth],
      [`${m}|${entity}`, byMonthEntity],
    ] as [string, Map<string, Bucket>][]) {
      const b = map.get(key) ?? { count: 0, cents: 0, noMemo: 0, noReceipt: 0, docsOnly: 0, approvalOnly: 0 };
      b.count++;
      b.cents += cents;
      if (missingMemo(t)) b.noMemo++;
      if (missingReceipt(t)) b.noReceipt++;
      if (docsMissing) b.docsOnly++;
      else b.approvalOnly++;
      map.set(key, b);
    }
  }

  console.log('\n================ OPEN RAMP TRANSACTIONS BY MONTH (all entities) ================');
  console.log('Month     | Count |        Amount | NoMemo | NoRcpt | Docs-fixable | Needs-approval');
  console.log('----------|-------|---------------|--------|--------|--------------|---------------');
  for (const m of [...byMonth.keys()].sort()) {
    const b = byMonth.get(m)!;
    console.log(
      `${m.padEnd(9)} | ${String(b.count).padStart(5)} | ${money(b.cents).padStart(13)} | ${String(b.noMemo).padStart(6)} | ${String(b.noReceipt).padStart(6)} | ${String(b.docsOnly).padStart(12)} | ${String(b.approvalOnly).padStart(13)}`,
    );
  }
  const tot = openRows.reduce((s, r) => s + Math.round(r.t.amount * 100), 0);
  console.log(`\nTOTAL open: ${openRows.length} txns / ${money(tot)}`);

  console.log('\n================ BY MONTH x ENTITY ================');
  console.log('Month-Entity | Count |        Amount');
  console.log('-------------|-------|---------------');
  for (const k of [...byMonthEntity.keys()].sort()) {
    const b = byMonthEntity.get(k)!;
    console.log(`${k.padEnd(12)} | ${String(b.count).padStart(5)} | ${money(b.cents).padStart(13)}`);
  }

  // Focus months: April + May 2026 — actionable buckets + top offenders
  for (const focus of ['2026-04', '2026-05']) {
    const rows = openRows.filter((r) => ym(r.t) === focus);
    if (!rows.length) continue;

    // actionable segmentation
    const seg = { memoOnly: [0, 0], rcptOnly: [0, 0], both: [0, 0], approval: [0, 0] };
    for (const r of rows) {
      const c = Math.round(r.t.amount * 100);
      const nm = missingMemo(r.t);
      const nr = missingReceipt(r.t);
      const k = nm && nr ? 'both' : nm ? 'memoOnly' : nr ? 'rcptOnly' : 'approval';
      seg[k][0]++;
      seg[k][1] += c;
    }
    console.log(`\n================ FOCUS ${focus} — ACTIONABLE BUCKETS ================`);
    console.log(`  Missing MEMO only (receipt present) : ${String(seg.memoOnly[0]).padStart(3)}x  ${money(seg.memoOnly[1])}`);
    console.log(`  Missing RECEIPT only (memo present) : ${String(seg.rcptOnly[0]).padStart(3)}x  ${money(seg.rcptOnly[1])}`);
    console.log(`  Missing BOTH memo + receipt         : ${String(seg.both[0]).padStart(3)}x  ${money(seg.both[1])}`);
    console.log(`  Docs done, NEEDS APPROVAL click     : ${String(seg.approval[0]).padStart(3)}x  ${money(seg.approval[1])}`);

    const byHolder = new Map<string, { count: number; cents: number }>();
    for (const r of rows) {
      const key = `${r.entity} / ${holder(r.t)}`;
      const b = byHolder.get(key) ?? { count: 0, cents: 0 };
      b.count++;
      b.cents += Math.round(r.t.amount * 100);
      byHolder.set(key, b);
    }
    console.log(`\n================ FOCUS ${focus} — top cardholders (${rows.length} open txns) ================`);
    const sorted = [...byHolder.entries()].sort((a, b) => b[1].cents - a[1].cents).slice(0, 12);
    for (const [k, b] of sorted) {
      console.log(`  ${money(b.cents).padStart(12)}  ${String(b.count).padStart(3)}x  ${k}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
