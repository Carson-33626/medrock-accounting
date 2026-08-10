// web/scripts/receipt-enrichment/engines/receipt-capture/run-amazon.ts
// Amazon stream reversal (spec 2026-07-28): Barbara's flow makes QBO's Amazon-direct connection
// the itemization source of record, so Ramp Amazon txns must land in QBO as PLAIN single-line
// Suspense entries carrying the Amazon order ID in the memo. Per unsynced Amazon txn:
//   - un-split (PATCH line_items: []) if Engine A enriched it
//   - prepend "Amazon order# <id>" to the memo (id from receipt PDF > existing memos > descriptor)
//   - no receipt -> C4 gap row (Amazon-CSV-backfill workstream); no order id -> flagged
// Dry-run by default: zero Ramp writes. --live writes, capped at --limit, audited with prior state.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-amazon.ts [--entity=FL] [--live] [--limit 5] [--pages 100]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchAmazonWorklist } from './amazon-worklist';
import type { AmazonWorkTxn } from './amazon-worklist';
import { collectOrderIds, composeMemo, postMemo } from './amazon-memo';
import { getReceipt, downloadReceipt, patchSplit } from '../amazon-enrich/client';
import { parseReceiptPdf } from '../amazon-enrich/receipt-parser';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { appendAudit } from './audit';
import { parseNumericFlag } from './cli-args';
import type { Entity } from '../ramp-split-push/types';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import { AMZ, RC } from '../../paths';

const OUT = RC.out;
const CACHE = AMZ.receipts; // shared with Engine A: 250+ PDFs already cached
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const VENDOR = 'amazon' as const;
const SCOPES_READ = 'transactions:read receipts:read';
const SCOPES_WRITE = 'transactions:read transactions:write memos:write receipts:read';

interface Args { entities: Entity[]; live: boolean; limit: number; pages: number }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const entityArg = get('--entity');
  const entities: Entity[] = entityArg ? [entityArg as Entity] : [...ALL_ENTITIES];
  for (const e of entities) {
    if (!ALL_ENTITIES.includes(e)) throw new Error(`Unknown --entity ${e as string} (expected FL, TN, or TX)`);
  }
  return {
    entities,
    live: argv.includes('--live'),
    limit: parseNumericFlag('--limit', get('--limit'), 5, 'clamp'),
    pages: parseNumericFlag('--pages', get('--pages'), 100, 'reject'),
  };
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Order id from an attached receipt: cached PDF first (Engine A already downloaded most of these),
// else fetch FRESH receipt meta — .rcpt.json S3 URLs cached by Engine A expire, so never reuse a
// cached URL for downloading. Image receipts (jpg/png) carry no extractable order# -> null; the
// memo/descriptor sources still get their chance in the caller.
async function receiptOrderId(entity: Entity, receiptId: string, token: string): Promise<string | null> {
  try {
    if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
    const f = `${CACHE}/${receiptId}.pdf`;
    let bytes: Buffer;
    if (existsSync(f)) {
      bytes = readFileSync(f);
    } else {
      const meta = await getReceipt(entity, receiptId, token);
      if (!meta.url || meta.ext !== 'pdf') return null;
      bytes = await downloadReceipt(meta.url);
      writeFileSync(f, bytes);
    }
    return (await parseReceiptPdf(bytes)).order;
  } catch {
    return null;
  }
}

interface PlanRow {
  txnId: string;
  txnDate: string;
  amountCents: number;
  cardHolder: string | null;
  merchant: string | null;
  enriched: boolean;
  orderIds: string[];
  orderIdSource: string;
  hasReceipt: boolean;
  plannedActions: string;
  mode: 'live' | 'dry_run';
  notes: string;
}

function planRowLine(r: PlanRow): string {
  return [
    r.txnId, r.txnDate, (r.amountCents / 100).toFixed(2), r.cardHolder ?? '', r.merchant ?? '',
    r.enriched ? 'Y' : 'N', r.orderIds.join(' '), r.orderIdSource, r.hasReceipt ? 'Y' : 'N',
    r.plannedActions, r.mode, r.notes,
  ].map(csv).join(',');
}

interface GapRow { entity: Entity; t: AmazonWorkTxn; orderIds: string[] }

async function runEntity(entity: Entity, args: Args, runId: string, gapRows: GapRow[]): Promise<void> {
  const token = await rampToken(entity, args.live ? SCOPES_WRITE : SCOPES_READ);
  const worklist = await fetchAmazonWorklist(entity, token, args.pages);

  const rows: PlanRow[] = [];
  let unsplitPlanned = 0, memoPlanned = 0, noReceipt = 0, noOrderId = 0, liveWrites = 0, writeFails = 0;

  for (const t of worklist) {
    const receiptOrders: (string | null)[] = [];
    for (const rid of t.receiptIds.slice(0, 5)) receiptOrders.push(await receiptOrderId(entity, rid, token));
    const ids = collectOrderIds([...receiptOrders, t.memo, ...t.lineMemos, t.merchantDescriptor]);
    const memoToWrite = composeMemo(ids, t.memo);
    const orderIdSource = receiptOrders.some((o) => o !== null) ? 'receipt'
      : collectOrderIds([t.memo]).length > 0 ? 'memo'
      : collectOrderIds(t.lineMemos).length > 0 ? 'line_memo'
      : collectOrderIds([t.merchantDescriptor]).length > 0 ? 'descriptor' : '';

    const actions: string[] = [];
    if (t.enriched) { actions.push('unsplit'); unsplitPlanned++; }
    if (memoToWrite !== null) { actions.push('memo'); memoPlanned++; }

    const notes: string[] = [];
    const isRefund = t.amountCents < 0;
    if (isRefund) notes.push('refund'); // negative-amount refunds have no receipt by nature; they must still reach
    // QBO (memo write stays eligible) but don't belong in the receipt-gap backfill worklist below.
    if (t.receiptIds.length === 0) {
      notes.push('no_receipt'); // C4: routed to the Amazon-CSV-backfill workstream (non-refunds only)
      noReceipt++;
      if (!isRefund) gapRows.push({ entity, t, orderIds: ids });
    }
    if (ids.length === 0) { notes.push('no_order_id'); noOrderId++; }
    else if (memoToWrite === null) notes.push('memo_already_current');

    const executeLive = args.live && actions.length > 0 && liveWrites < args.limit;
    const mode: 'live' | 'dry_run' = executeLive ? 'live' : 'dry_run';
    if (executeLive) {
      liveWrites++;
      const priorLineItems = t.priorLineItems == null ? '' : JSON.stringify(t.priorLineItems);
      const invoiceKey = ids.join(' ');
      // Re-check sync_status right before writing: the worklist fetch and this write can be
      // minutes apart across a full run, and an accountant-triggered Ramp sync can flip a txn
      // NOT_SYNC_READY -> SYNC_READY/SYNCED in between. Writing after that flip would disturb a
      // txn QBO already considers reconciled, so skip all writes for this txn if the status moved.
      const check = await rampGet<{ sync_status?: string | null }>(entity, `/transactions/${t.id}`, token);
      const stillEligible = check.status === 200 && check.body.sync_status === 'NOT_SYNC_READY';
      if (!stillEligible) {
        const statusVal = check.status === 200 ? String(check.body.sync_status ?? 'null') : `HTTP ${check.status}`;
        appendAudit(AUDIT_PATH, {
          runId, mode: 'live', vendor: VENDOR, entity, txnId: t.id, action: 'skip',
          invoiceKey, amountCents: t.amountCents, status: check.status,
          detail: `sync_status_changed: ${statusVal}`,
          priorMemo: t.memo, priorLineItems,
        });
        notes.push('sync_status_changed');
      } else {
        if (t.enriched) {
          // Un-split: PATCH with empty line_items restores the single default line; Ramp's own
          // categorization (Suspense for Amazon) applies. Prior lines are in the audit row.
          const res = await patchSplit(entity, t.id, [], token);
          const ok = res.status >= 200 && res.status < 300;
          if (!ok) writeFails++;
          appendAudit(AUDIT_PATH, {
            runId, mode: 'live', vendor: VENDOR, entity, txnId: t.id, action: ok ? 'unsplit' : 'error',
            invoiceKey, amountCents: t.amountCents, status: res.status,
            detail: ok ? 'line_items -> []' : JSON.stringify(res.body).slice(0, 500),
            priorMemo: t.memo, priorLineItems,
          });
        }
        if (memoToWrite !== null) {
          // Memo is independent of the un-split (txn-level field) — attempt it either way.
          const res = await postMemo(t.id, memoToWrite, token);
          const ok = res.status >= 200 && res.status < 300;
          if (!ok) writeFails++;
          appendAudit(AUDIT_PATH, {
            runId, mode: 'live', vendor: VENDOR, entity, txnId: t.id, action: ok ? 'memo' : 'error',
            invoiceKey, amountCents: t.amountCents, status: res.status,
            detail: ok ? memoToWrite : res.body, priorMemo: t.memo, priorLineItems,
          });
        }
      }
    }

    rows.push({
      txnId: t.id, txnDate: t.date, amountCents: t.amountCents, cardHolder: t.cardHolder,
      merchant: t.merchantName, enriched: t.enriched, orderIds: ids, orderIdSource,
      hasReceipt: t.receiptIds.length > 0,
      plannedActions: actions.length > 0 ? actions.join(';') : 'none',
      mode,
      notes: mode === 'dry_run' && args.live && actions.length > 0
        ? [...notes, 'over_limit'].join(';')
        : notes.join(';'),
    });
  }

  const planPath = `${OUT}/amazon-plan-${entity}.csv`;
  const header = 'txn_id,txn_date,amount,cardholder,merchant,enriched,order_ids,order_id_source,has_receipt,planned_actions,mode,notes';
  writeFileSync(planPath, [header, ...rows.map(planRowLine)].join('\n') + '\n');
  console.log(
    `[${entity}] worklist=${worklist.length} | unsplit planned=${unsplitPlanned} memo planned=${memoPlanned} ` +
    `no_receipt=${noReceipt} no_order_id=${noOrderId} | ` +
    `${args.live ? `live txns=${liveWrites} (limit ${args.limit}) write-fails=${writeFails}` : 'dry-run (no writes)'} | wrote ${planPath} (${rows.length} rows)`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `amazon-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`run ${runId} | entities=${args.entities.join(',')} | mode=${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}`);
  const gapRows: GapRow[] = [];
  for (const entity of args.entities) {
    await runEntity(entity, args, runId, gapRows);
  }
  // C4: the receipt-gap worklist, combined across entities, for the Amazon-CSV-backfill
  // workstream / manual upload. These will sit in QBO Suspense as designed until receipted.
  const gapHeader = 'entity,txn_id,txn_date,amount,cardholder,merchant,order_ids,memo';
  const gapLines = gapRows.map((g) => [
    g.entity, g.t.id, g.t.date, (g.t.amountCents / 100).toFixed(2), g.t.cardHolder ?? '',
    g.t.merchantName ?? '', g.orderIds.join(' '), g.t.memo ?? '',
  ].map(csv).join(','));
  writeFileSync(`${OUT}/amazon-receipt-gap.csv`, [gapHeader, ...gapLines].join('\n') + '\n');
  console.log(`receipt-gap worklist: ${gapRows.length} txn(s) -> ${OUT}/amazon-receipt-gap.csv`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
