// ATTACH — the single-line-policy replacement for the retired split writers (2026-07-28). Barbara's
// flow makes QBO's Amazon-direct connection the itemization source of record, so Ramp Amazon txns
// stay single-line; this runner's only job is to get every receiptless, unsynced Amazon-family txn
// a REAL invoice PDF receipt plus an "Amazon order# <id>" memo, using the same charge-level
// amount+date+last4 pairing the retired split runners used. It never edits line_items.
//   npx tsx scripts/amazon-csv-enrich/run-attach.ts [--entity FL|TN|TX] [--from 2026-04-01 --to 2026-05-31] [--live] [--cap N] [--ramp-pages 260]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { parseCsvRows } from './csv-parser';
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';
import { matchCharges } from './matcher';
import { getReceiptlessAmazonTxns, rampToken } from './client';
import { sharedPdfPath } from './paths';
import { collectOrderIds, composeMemo, postMemo } from '../receipt-capture/amazon-memo';
import { appendAudit } from '../receipt-capture/audit';
import { attachReceipt } from '../walmart-enrich/ramp-receipts';
import { rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity, RampTxn } from '../ramp-split-push/types';
import type { AmazonCharge } from './types';

const ROOT = 'scripts/amazon-csv-enrich/out';
const OUT = `${ROOT}/_attach`;
const AUDIT_PATH = 'scripts/receipt-capture/out/receipt-capture-audit.csv';
const VENDOR = 'amazon-csv';
const SCOPES_READ = 'transactions:read receipts:read';
const SCOPES_WRITE = 'transactions:read receipts:read receipts:write memos:write';

function argVal(f: string, d: string): string { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (f: string): boolean => process.argv.includes(f);
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const inWin = (d: string, from: string, to: string): boolean => (!from || d >= from) && (!to || d <= to);

// Ported from the retired split runners' charge-level pairing (run-recon-split.ts / reconcile-txns.ts):
// one row per Payment Reference ID (= one card charge = one Ramp txn target), carrying every Order ID
// it reconciles to plus the card last-4 the matcher uses as a same-amount tiebreaker. No split/GL fields.
function parseTxnReport(text: string): AmazonCharge[] {
  const byRef = new Map<string, AmazonCharge>();
  for (const r of parseCsvRows(text)) {
    if (unwrapExcel(r['Transaction Type'] ?? '').toLowerCase() !== 'charge') continue;
    const paymentRef = unwrapExcel(r['Payment Reference ID'] ?? '');
    if (!paymentRef) continue;
    const orderId = unwrapExcel(r['Order ID'] ?? '');
    let c = byRef.get(paymentRef);
    if (!c) {
      const last4 = unwrapExcel(r['Payment Identifier'] ?? '');
      const cents = parseMoneyCents(r['Payment Amount'] ?? '');
      c = {
        paymentRef, orderIds: [], primaryOrderId: orderId, accountGroup: unwrapExcel(r['Account Group'] ?? ''),
        chargeCents: cents, payDate: parseMDY(r['Transaction Date'] ?? ''),
        cardLast4: last4 && last4 !== 'N/A' ? last4 : null, items: [], itemsTotalCents: cents,
      };
      byRef.set(paymentRef, c);
    }
    if (orderId && !c.orderIds.includes(orderId)) c.orderIds.push(orderId);
    if (!c.primaryOrderId && orderId) c.primaryOrderId = orderId;
  }
  return [...byRef.values()];
}

interface PlanRow {
  txnId: string; date: string; amountCents: number; entity: Entity; orderIds: string[];
  pdfCached: boolean; plannedActions: string; mode: 'live' | 'dry_run'; notes: string;
}
function planLine(r: PlanRow): string {
  return [
    r.txnId, r.date, (r.amountCents / 100).toFixed(2), r.entity, r.orderIds.join(' '),
    r.pdfCached ? 'Y' : 'N', r.plannedActions, r.mode, r.notes,
  ].map(csv).join(',');
}

interface EntityStats {
  eligible: number; paired: number; needsInvoiceFetch: number;
  attached: number; memoWritten: number; fails: number; skipped: number;
}
const emptyStats = (): EntityStats => ({ eligible: 0, paired: 0, needsInvoiceFetch: 0, attached: 0, memoWritten: 0, fails: 0, skipped: 0 });

async function main(): Promise<void> {
  const entityArg = argVal('--entity', '');
  const entities: Entity[] = entityArg ? [entityArg as Entity] : [...ALL_ENTITIES];
  for (const e of entities) {
    if (!ALL_ENTITIES.includes(e)) throw new Error(`Unknown --entity ${e as string} (expected FL, TN, or TX)`);
  }
  const from = argVal('--from', ''), to = argVal('--to', '');
  const live = has('--live');
  const cap = Number(argVal('--cap', '0')) || 0;
  const pages = Number(argVal('--ramp-pages', '260')) || 260;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `attach-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const plan: PlanRow[] = [];
  const setAside: string[] = ['txn_id,entity,date,amount,reason,detail'];

  // Pool charges from each entity's cached Transactions report; a missing report just narrows the
  // pairing pool for that entity (its eligible txns still get a plan row, unmatched).
  const byRef = new Map<string, AmazonCharge>();
  for (const e of entities) {
    const p = `${ROOT}/${e}/transactions.csv`;
    if (!existsSync(p)) {
      console.log(`[${e}] no transactions.csv cached - skipping (run the extract for this entity first)`);
      setAside.push(['', e, '', '', 'no_transactions_csv', p].map(csv).join(','));
      continue;
    }
    for (const c of parseTxnReport(readFileSync(p, 'utf8'))) if (!byRef.has(c.paymentRef)) byRef.set(c.paymentRef, c);
  }
  let charges = [...byRef.values()];
  if (from || to) charges = charges.filter((c) => inWin(c.payDate, from, to));

  // Pool receiptless-eligible Ramp Amazon txns for the requested entities.
  const token: Record<Entity, string> = {} as Record<Entity, string>;
  let pool: RampTxn[] = [];
  const statsByEntity: Record<string, EntityStats> = {};
  for (const e of entities) {
    token[e] = await rampToken(e, live ? SCOPES_WRITE : SCOPES_READ);
    const txns = await getReceiptlessAmazonTxns(e, token[e], pages);
    pool.push(...txns);
    statsByEntity[e] = emptyStats();
  }
  if (from || to) pool = pool.filter((t) => inWin(t.date, from, to));
  for (const t of pool) statsByEntity[t.entity].eligible++;

  const { confident, ambiguous, unmatched } = matchCharges(charges, pool);
  const confidentByTxnId = new Map(confident.map((m) => [m.txn.id, m] as const));
  for (const c of ambiguous) setAside.push(['', '', c.payDate, (c.chargeCents / 100).toFixed(2), 'ambiguous_charge', c.primaryOrderId].map(csv).join(','));
  for (const c of unmatched) setAside.push(['', '', c.payDate, (c.chargeCents / 100).toFixed(2), 'unmatched_charge', c.primaryOrderId].map(csv).join(','));

  let writes = 0;
  for (const t of pool) {
    const stats = statsByEntity[t.entity];
    const m = confidentByTxnId.get(t.id);
    if (!m) {
      plan.push({ txnId: t.id, date: t.date, amountCents: t.amountCents, entity: t.entity, orderIds: [], pdfCached: false, plannedActions: 'none', mode: 'dry_run', notes: 'no_charge_match' });
      setAside.push([t.id, t.entity, t.date, (t.amountCents / 100).toFixed(2), 'unmatched_txn', ''].map(csv).join(','));
      continue;
    }
    stats.paired++;
    const orderIds = collectOrderIds(m.charge.orderIds.length ? m.charge.orderIds : [m.charge.primaryOrderId]);
    const pdfPath = sharedPdfPath(m.charge.primaryOrderId);
    const pdfCached = existsSync(pdfPath);
    const memoToWrite = composeMemo(orderIds, t.memo);
    const actions: string[] = [];
    if (pdfCached) actions.push('attach_receipt');
    if (memoToWrite !== null) actions.push('memo');

    const notes: string[] = [];
    if (!pdfCached) {
      notes.push('needs_invoice_fetch');
      stats.needsInvoiceFetch++;
      setAside.push([t.id, t.entity, t.date, (t.amountCents / 100).toFixed(2), 'needs_invoice_fetch', m.charge.primaryOrderId].map(csv).join(','));
    }
    if (orderIds.length === 0) notes.push('no_order_id');
    else if (memoToWrite === null) notes.push('memo_already_current');

    const priorLineItems = t.priorLineItems == null ? '' : JSON.stringify(t.priorLineItems);
    const capped = live && cap > 0 && writes >= cap;
    // A pair with no cached PDF has NO live-executable work: attach is impossible (no bytes to
    // upload) and memo is attach-gated (see below), so entering the live branch here would burn
    // cap budget and fire a TOCTOU GET for a pass that can never write anything or leave an audit
    // row. Gate live-mode entry on pdfCached — attach is the prerequisite for everything.
    const mode: 'live' | 'dry_run' = live && !capped && pdfCached ? 'live' : 'dry_run';

    if (mode === 'live') {
      writes++;
      // TOCTOU re-check: the eligibility fetch and this write can be minutes apart across a full
      // run, and an accountant-triggered Ramp sync can flip a txn NOT_SYNC_READY -> something else
      // in between. Writing after that flip would disturb a txn QBO already considers reconciled.
      const check = await rampGet<{ sync_status?: string | null }>(t.entity, `/transactions/${t.id}`, token[t.entity]);
      const stillEligible = check.status === 200 && check.body.sync_status === 'NOT_SYNC_READY';
      if (!stillEligible) {
        const statusVal = check.status === 200 ? String(check.body.sync_status ?? 'null') : `HTTP ${check.status}`;
        appendAudit(AUDIT_PATH, {
          runId, mode: 'live', vendor: VENDOR, entity: t.entity, txnId: t.id, action: 'skip',
          invoiceKey: m.charge.primaryOrderId, amountCents: t.amountCents, status: check.status,
          detail: `sync_status_changed: ${statusVal}`, priorMemo: t.memo, priorLineItems,
        });
        notes.push('sync_status_changed');
        stats.skipped++;
      } else {
        let attachOk = false;
        if (pdfCached) {
          if (!t.userId) {
            appendAudit(AUDIT_PATH, {
              runId, mode: 'live', vendor: VENDOR, entity: t.entity, txnId: t.id, action: 'skip',
              invoiceKey: m.charge.primaryOrderId, amountCents: t.amountCents, status: null,
              detail: 'no_user_id', priorMemo: t.memo, priorLineItems,
            });
            notes.push('no_user_id');
            stats.skipped++;
            setAside.push([t.id, t.entity, t.date, (t.amountCents / 100).toFixed(2), 'skip', 'no_user_id'].map(csv).join(','));
          } else {
            const pdf = readFileSync(pdfPath);
            const att = await attachReceipt(t.entity, t.id, pdf, `amazon-${m.charge.primaryOrderId}.pdf`, token[t.entity], t.userId, `amazon-csv-receipt-${m.charge.primaryOrderId}`);
            attachOk = att.status >= 200 && att.status < 300;
            appendAudit(AUDIT_PATH, {
              runId, mode: 'live', vendor: VENDOR, entity: t.entity, txnId: t.id, action: attachOk ? 'attach_receipt' : 'error',
              invoiceKey: m.charge.primaryOrderId, amountCents: t.amountCents, status: att.status,
              detail: attachOk ? 'attached' : JSON.stringify(att.body).slice(0, 500), priorMemo: t.memo, priorLineItems,
            });
            if (attachOk) stats.attached++;
            else {
              notes.push('attach_fail');
              stats.fails++;
              setAside.push([t.id, t.entity, t.date, (t.amountCents / 100).toFixed(2), 'attach_fail', `HTTP ${att.status}`].map(csv).join(','));
            }
          }
        }
        if (memoToWrite !== null) {
          if (attachOk) {
            const res = await postMemo(t.id, memoToWrite, token[t.entity]);
            const ok = res.status >= 200 && res.status < 300;
            appendAudit(AUDIT_PATH, {
              runId, mode: 'live', vendor: VENDOR, entity: t.entity, txnId: t.id, action: ok ? 'memo' : 'error',
              invoiceKey: m.charge.primaryOrderId, amountCents: t.amountCents, status: res.status,
              detail: ok ? memoToWrite : res.body, priorMemo: t.memo, priorLineItems,
            });
            if (ok) stats.memoWritten++;
            else { notes.push('memo_fail'); stats.fails++; }
          } else {
            notes.push('memo_skipped_no_attach');
          }
        }
      }
    }

    plan.push({
      txnId: t.id, date: t.date, amountCents: t.amountCents, entity: t.entity, orderIds,
      pdfCached, plannedActions: actions.length > 0 ? actions.join(';') : 'none', mode,
      // A confident, PDF-ready pair only ever lands in dry_run here because the cap was hit
      // (mirrors run-amazon.ts's over_limit convention) — flag it so the plan CSV distinguishes
      // "would have written but for the cap" from the other dry_run reasons (no pdf, not live).
      notes: mode === 'dry_run' && live && capped && pdfCached
        ? [...notes, 'over_cap'].join(';')
        : notes.join(';'),
    });
  }

  writeFileSync(`${OUT}/plan.csv`, ['txn_id,date,amount,entity,order_ids,pdf_cached,planned_actions,mode,notes', ...plan.map(planLine)].join('\n') + '\n');
  writeFileSync(`${OUT}/set_aside.csv`, setAside.join('\n') + '\n');

  for (const e of entities) {
    const s = statsByEntity[e];
    console.log(
      `[${e}] eligible=${s.eligible} paired=${s.paired} needs_invoice_fetch=${s.needsInvoiceFetch} | ` +
      `${live ? `attached=${s.attached} memo=${s.memoWritten} skipped=${s.skipped} fails=${s.fails}` : 'dry-run (no writes)'}`,
    );
  }
  console.log(`\nMODE: ${live ? `LIVE (cap ${cap || 'none'}, ${writes} attempted)` : 'DRY-RUN (no writes)'}`);
  console.log(`charges ${charges.length} | confident ${confident.length} | ambiguous ${ambiguous.length} | unmatched ${unmatched.length}`);
  console.log(`Wrote ${OUT}/plan.csv (${plan.length}), ${OUT}/set_aside.csv (${setAside.length - 1})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
