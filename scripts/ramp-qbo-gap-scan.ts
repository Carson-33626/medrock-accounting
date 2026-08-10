// READ-ONLY scan: which cleared Ramp card transactions have NO counterpart in QBO?
// Context: QBO's Ramp connection only back-synced ~30 days, so older Ramp txns may be
// missing from QB entirely. Match method (verified in docs/ramp-recon/amazon-qb-ramp-linkage.md):
// Ramp card charges land in QB as Purchases matching on amount + date (±3 days) — no Ramp id
// is stored on the QB side. Honors the dry-run mandate: zero writes to Ramp or QB.
// Run from web/ dir:  npx tsx scripts/ramp-qbo-gap-scan.ts
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rampToken, rampGet } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';
import { ENTITY_TO_QB_LOCATION, ALL_ENTITIES } from './receipt-enrichment/engines/ramp-split-push/types';
import { qbQueryAll } from '../src/lib/quickbooks-multi';

const DATE_WINDOW_DAYS = 3;

// ---- Ramp side ----
interface RawRampTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;   // "SYNCED" once Ramp has pushed the txn to QB
  synced_at: string | null;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  receipts: string[] | null;
  all_requirements_met_and_approved: boolean | null;
  policy_violations: unknown[] | null;
  accounting_field_selections: unknown[] | null;
}
interface RampPage {
  data: RawRampTxn[];
  page?: { next?: string };
}
interface RampRow {
  entity: Entity;
  id: string;
  absCents: number;
  signedCents: number;
  date: string; // YYYY-MM-DD
  merchant: string | null;
  holder: string | null;
  memo: string | null;
  syncStatus: string;
  syncedAt: string | null;
  hasMemo: boolean;
  hasReceipt: boolean;
  approved: boolean;
  policyViolation: boolean;
  hasCoding: boolean;
}

// What Barbara needs to fix before Ramp will push this txn to QBO.
// Note: `approved` = Ramp's all_requirements_met_and_approved. When it's true, a missing
// memo/receipt is NOT required by policy for that txn — the block is coding or the sync itself.
function blocker(r: RampRow): string {
  if (r.syncStatus === 'SYNCED') return 'nothing - Ramp says synced; NOT found in QBO (investigate)';
  if (r.syncStatus === 'SYNC_READY') return 'nothing - queued, will sync on next Ramp push';
  if (!r.approved) {
    const docs: string[] = [];
    if (!r.hasMemo) docs.push('memo');
    if (!r.hasReceipt) docs.push('receipt');
    if (r.policyViolation) docs.push('policy violation');
    if (docs.length > 0) return `missing ${docs.join(' + ')}, then approval`;
    return 'needs approval click (docs complete)';
  }
  if (!r.hasCoding) return 'approved but missing GL coding (assign category/account in Ramp)';
  return 'approved + coded - stuck in Ramp sync (check sync errors in Ramp settings)';
}

async function pullRampCleared(entity: Entity): Promise<RampRow[]> {
  const token = await rampToken(entity, 'transactions:read');
  const out: RampRow[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 200 && next !== null; i++) {
    let res: { status: number; body: RampPage } = await rampGet<RampPage>(entity, next, token);
    for (let attempt = 0; res.status !== 200 && attempt < 4; attempt++) {
      console.error(`  Ramp ${entity} page ${i} HTTP ${res.status} — retrying in ${2 ** attempt}s: ${JSON.stringify(res.body).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      res = await rampGet<RampPage>(entity, next, token);
    }
    if (res.status !== 200) throw new Error(`Ramp ${entity} page ${i} HTTP ${res.status}`);
    const rows: RawRampTxn[] = res.body.data ?? [];
    for (const r of rows) {
      if (r.state !== 'CLEARED') continue; // pending/declined never sync to QB
      const cents = Math.round(r.amount * 100);
      const h = r.card_holder;
      out.push({
        entity,
        id: r.id,
        absCents: Math.abs(cents),
        signedCents: cents,
        date: (r.user_transaction_time ?? '').slice(0, 10),
        merchant: r.merchant_name,
        holder: h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() || null : null,
        memo: r.memo,
        syncStatus: r.sync_status ?? '(none)',
        syncedAt: r.synced_at,
        hasMemo: (r.memo ?? '').trim() !== '',
        hasReceipt: (r.receipts ?? []).length > 0,
        approved: r.all_requirements_met_and_approved === true,
        policyViolation: (r.policy_violations ?? []).length > 0,
        hasCoding: (r.accounting_field_selections ?? []).length > 0,
      });
    }
    if (rows.length === 0) break;
    next = res.body.page?.next ?? null;
  }
  return out;
}

// ---- QB side ----
interface QBRef { value: string; name?: string }
interface QBAccountRaw { Id: string; Name?: string; FullyQualifiedName?: string }
interface QBPurchaseRaw {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  Credit?: boolean;
  AccountRef?: QBRef;   // the paying account — Ramp-synced purchases post against the Ramp card account
  EntityRef?: QBRef;
  PrivateNote?: string;
}
interface QBRow {
  qbId: string;
  absCents: number;
  date: string;
  epochDay: number;
  account: string;
  payee: string;
  consumed: boolean;
}

function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

async function pullQbPurchases(
  entity: Entity,
): Promise<{ rows: QBRow[]; all: QBRow[]; scope: string; minDate: string; maxDate: string }> {
  const location = ENTITY_TO_QB_LOCATION[entity];
  const rampAccounts = await qbQueryAll<QBAccountRaw>(location, 'Account', "WHERE Name LIKE '%Ramp%'");
  const rampIds = new Set(rampAccounts.map((a) => a.Id));
  const raw = await qbQueryAll<QBPurchaseRaw>(location, 'Purchase', '');
  interface QBRowWithAcct extends QBRow { accountId: string }
  const toRow = (p: QBPurchaseRaw): QBRowWithAcct => ({
    qbId: p.Id,
    absCents: Math.abs(Math.round((p.TotalAmt ?? 0) * 100)),
    date: (p.TxnDate ?? '').slice(0, 10),
    epochDay: epochDay((p.TxnDate ?? '').slice(0, 10)),
    account: p.AccountRef?.name ?? '?',
    payee: p.EntityRef?.name ?? '',
    accountId: p.AccountRef?.value ?? '',
    consumed: false,
  });
  const all: QBRowWithAcct[] = raw.filter((p) => (p.TxnDate ?? '') !== '').map(toRow);
  const scoped = rampIds.size > 0 ? all.filter((r) => rampIds.has(r.accountId)) : all;
  const scope =
    rampIds.size > 0
      ? `Ramp account(s): ${rampAccounts.map((a) => a.FullyQualifiedName ?? a.Name ?? a.Id).join(', ')} (${scoped.length}/${all.length} purchases)`
      : `NO Ramp-named QB account found — matching against ALL ${all.length} purchases (looser)`;
  const dates = scoped.map((r) => r.date).sort();
  return { rows: scoped, all, scope, minDate: dates[0] ?? '(none)', maxDate: dates[dates.length - 1] ?? '(none)' };
}

// ---- matching: greedy 1:1, amount exact + nearest date within ±window ----
function matchEntity(ramp: RampRow[], qb: QBRow[]): { matched: RampRow[]; missing: RampRow[] } {
  const byCents = new Map<number, QBRow[]>();
  for (const q of qb) {
    const list = byCents.get(q.absCents) ?? [];
    list.push(q);
    byCents.set(q.absCents, list);
  }
  const matched: RampRow[] = [];
  const missing: RampRow[] = [];
  // oldest first so contested amounts resolve in chronological order
  const sorted = [...ramp].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) {
    const candidates = byCents.get(r.absCents) ?? [];
    const rDay = epochDay(r.date);
    let best: QBRow | null = null;
    let bestDiff = DATE_WINDOW_DAYS + 1;
    for (const c of candidates) {
      if (c.consumed) continue;
      const diff = Math.abs(c.epochDay - rDay);
      if (diff <= DATE_WINDOW_DAYS && diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    if (best) {
      best.consumed = true;
      matched.push(r);
    } else {
      missing.push(r);
    }
  }
  return { matched, missing };
}

function money(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function csvCell(v: string | null): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  interface MonthBucket { rampCount: number; rampCents: number; missCount: number; missCents: number }
  interface MissOut extends RampRow { qboCandidate: 'Y' | 'N'; qboCandidateDetail: string }
  const byMonth = new Map<string, MonthBucket>();
  const allMissing: MissOut[] = [];
  let totalRamp = 0;
  let totalMatched = 0;

  // sequential per realm: concurrent QB token refresh races (see qb-amazon-reader.ts)
  for (const entity of ALL_ENTITIES) {
    const ramp = await pullRampCleared(entity);
    const qb = await pullQbPurchases(entity);
    console.error(`${entity}: ${ramp.length} cleared Ramp txns | QB ${qb.scope}`);
    console.error(`${entity}: QB Ramp-purchase date range ${qb.minDate} → ${qb.maxDate}`);
    const { matched, missing } = matchEntity(ramp, qb.rows);
    totalRamp += ramp.length;
    totalMatched += matched.length;
    // Loose pairing search for Barbara: same amount within ±14 days across ALL QB purchase
    // accounts (not just the Ramp card account), excluding purchases already paired above.
    const looseByCents = new Map<number, QBRow[]>();
    for (const q of qb.all) {
      const list = looseByCents.get(q.absCents) ?? [];
      list.push(q);
      looseByCents.set(q.absCents, list);
    }
    for (const r of missing) {
      const rDay = epochDay(r.date);
      let best: QBRow | null = null;
      let bestDiff = 15;
      for (const c of looseByCents.get(r.absCents) ?? []) {
        if (c.consumed) continue;
        const diff = Math.abs(c.epochDay - rDay);
        if (diff < bestDiff) {
          best = c;
          bestDiff = diff;
        }
      }
      allMissing.push({
        ...r,
        qboCandidate: best ? 'Y' : 'N',
        qboCandidateDetail: best
          ? `QBO Purchase ${best.qbId} on ${best.date} | account: ${best.account}${best.payee ? ` | payee: ${best.payee}` : ''}`
          : '',
      });
    }
    for (const r of ramp) {
      const m = `${r.date.slice(0, 7)}|${entity}`;
      const b = byMonth.get(m) ?? { rampCount: 0, rampCents: 0, missCount: 0, missCents: 0 };
      b.rampCount++;
      b.rampCents += r.signedCents;
      byMonth.set(m, b);
    }
    for (const r of missing) {
      const b = byMonth.get(`${r.date.slice(0, 7)}|${entity}`)!;
      b.missCount++;
      b.missCents += r.signedCents;
    }
  }

  console.log('\n========== RAMP TXNS MISSING FROM QBO — BY MONTH x ENTITY ==========');
  console.log('Month   | Ent |  Ramp# |   Ramp amount | Miss# |   Missing amt | Miss%');
  console.log('--------|-----|--------|---------------|-------|---------------|------');
  for (const k of [...byMonth.keys()].sort()) {
    const [m, e] = k.split('|');
    const b = byMonth.get(k)!;
    const pct = b.rampCount ? ((b.missCount / b.rampCount) * 100).toFixed(0) : '0';
    console.log(
      `${m} | ${e.padEnd(3)} | ${String(b.rampCount).padStart(6)} | ${money(b.rampCents).padStart(13)} | ${String(b.missCount).padStart(5)} | ${money(b.missCents).padStart(13)} | ${pct.padStart(4)}%`,
    );
  }
  const missCents = allMissing.reduce((s, r) => s + r.signedCents, 0);
  console.log(`\nTOTAL: ${totalRamp} cleared Ramp txns | ${totalMatched} matched in QBO | ${allMissing.length} MISSING (${money(missCents)})`);

  // The load-bearing split: Ramp-says-SYNCED-but-absent-from-QB is a QBO-side gap;
  // anything else is Ramp-side backlog that was never pushed (expected absent).
  console.log('\n========== MISSING TXNS BY RAMP sync_status ==========');
  const bySync = new Map<string, { count: number; cents: number }>();
  for (const r of allMissing) {
    const b = bySync.get(r.syncStatus) ?? { count: 0, cents: 0 };
    b.count++;
    b.cents += r.signedCents;
    bySync.set(r.syncStatus, b);
  }
  for (const [k, b] of [...bySync.entries()].sort((a, b2) => b2[1].cents - a[1].cents)) {
    console.log(`  ${k.padEnd(16)} ${String(b.count).padStart(5)}x  ${money(b.cents).padStart(13)}`);
  }
  const syncedMissing = allMissing.filter((r) => r.syncStatus === 'SYNCED');
  const syncedMissCents = syncedMissing.reduce((s, r) => s + r.signedCents, 0);
  console.log(`\n>>> TRUE QBO-SIDE GAP (Ramp SYNCED, not found in QB): ${syncedMissing.length} txns / ${money(syncedMissCents)}`);
  const gapByMonth = new Map<string, { count: number; cents: number }>();
  for (const r of syncedMissing) {
    const k = `${r.date.slice(0, 7)}|${r.entity}`;
    const b = gapByMonth.get(k) ?? { count: 0, cents: 0 };
    b.count++;
    b.cents += r.signedCents;
    gapByMonth.set(k, b);
  }
  for (const k of [...gapByMonth.keys()].sort()) {
    const b = gapByMonth.get(k)!;
    console.log(`  ${k.padEnd(12)} ${String(b.count).padStart(5)}x  ${money(b.cents).padStart(13)}`);
  }

  const outDir = join(__dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'ramp-qbo-missing.csv');
  console.log('\n========== WHAT IS BLOCKING THE QBO PUSH (missing txns) ==========');
  const byBlocker = new Map<string, { count: number; cents: number }>();
  for (const r of allMissing) {
    const k = blocker(r);
    const b = byBlocker.get(k) ?? { count: 0, cents: 0 };
    b.count++;
    b.cents += r.signedCents;
    byBlocker.set(k, b);
  }
  for (const [k, b] of [...byBlocker.entries()].sort((a, b2) => b2[1].cents - a[1].cents)) {
    console.log(`  ${String(b.count).padStart(5)}x  ${money(b.cents).padStart(13)}  ${k}`);
  }

  const preamble = [
    '"WHAT THIS IS: Every Ramp card transaction (FL / TN / TX) with NO matching transaction found in QuickBooks Online. QBO is not missing these because of a 30-day pull limit - Ramp has not pushed most of them yet."',
    '"WHATS_MISSING_TO_PUSH_TO_QBO: what has to happen in Ramp before it will send the transaction to QBO. Ramp only pushes after a transaction is documented, approved, and GL-coded. Rows marked stuck-in-sync are fully ready and point to a Ramp sync problem, not staff work."',
    '"EXISTING_QBO_TXN_TO_PAIR: Y = QBO already has a purchase for the same amount within 14 days (see qbo_txn_detail) - review and pair to that instead of creating a new entry. N = nothing similar exists in QBO; it will arrive when Ramp syncs it (do not key it manually unless marked investigate)."',
    '""',
  ];
  const header = [
    'entity',
    'date',
    'merchant',
    'cardholder',
    'amount',
    'whats_missing_to_push_to_qbo',
    'existing_qbo_txn_to_pair',
    'qbo_txn_detail',
    'has_memo',
    'has_receipt',
    'approved',
    'has_gl_coding',
    'ramp_sync_status',
    'memo',
    'ramp_txn_id',
  ].join(',');
  const lines = allMissing
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.date.localeCompare(b.date))
    .map((r) =>
      [
        r.entity,
        r.date,
        csvCell(r.merchant),
        csvCell(r.holder),
        (r.signedCents / 100).toFixed(2),
        csvCell(blocker(r)),
        r.qboCandidate,
        csvCell(r.qboCandidateDetail),
        r.hasMemo ? 'Y' : 'N',
        r.hasReceipt ? 'Y' : 'N',
        r.approved ? 'Y' : 'N',
        r.hasCoding ? 'Y' : 'N',
        r.syncStatus,
        csvCell(r.memo),
        r.id,
      ].join(','),
    );
  writeFileSync(outPath, [...preamble, header, ...lines].join('\n'), 'utf8');
  console.log(`\nMissing-txn detail written to ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
