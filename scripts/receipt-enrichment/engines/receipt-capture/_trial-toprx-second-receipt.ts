// ONE-TRANSACTION TRIAL (Carson, 2026-08-04): does adding a second receipt to a transaction that
// already has the bookkeeper's blank scan "unlock" anything?
//
// Ramp exposes no receipt DELETE and no transaction unlock, so replacing her blank scan is
// impossible; adding ours alongside it is the only path. The open worry is whether that write
// disturbs the transaction's accounting state — flipping NOT_SYNC_READY, re-opening a synced txn,
// or otherwise creating rework for accounting.
//
// So this writes ONE receipt and NOTHING else. No split, no memo — those are separate writes, and
// mixing them in would make it impossible to attribute any state change to the receipt upload.
// State is captured immediately before and after, and re-read after a short settle, so the answer
// is measured rather than assumed.
//
// Target is deliberately the LOWEST-RISK of the six: smallest amount, NOT_SYNC_READY (nothing in
// QuickBooks to disturb). The one SYNCED blank txn (2026-03-24, $4,568.01) is untouched.
//
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_trial-toprx-second-receipt.ts          # dry-run, no write
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_trial-toprx-second-receipt.ts --live   # ONE receipt upload
//
// STEP 2 (--split-memo, Carson 2026-08-04): now add the memo and the line split to the SAME txn,
// using the exact helpers run-toprx.ts uses so the result is identical to what the pipeline would
// have produced. Split is the write that can 403 on a SYNCED txn; this one is NOT_SYNC_READY, and
// the prior memo + prior line items are captured into the audit first so the change is reversible.
import '../ramp-split-push/load-env';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { rampGet, rampToken, getRampTransactions } from '../ramp-split-push/ramp-client';
import { attachReceipt } from '../walmart-enrich/ramp-receipts';
import { parseTopRxInvoice } from './toprx-invoice';
import { buildVendorSplit } from './vendor-split';
import { patchSplit, patchMemo } from '../amazon-enrich/client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import { appendAudit } from './audit';
import type { Entity } from '../ramp-split-push/types';
import { RC } from '../../paths';

const ENTITY: Entity = 'FL';
const TXN_ID = 'ffb1c555-5d57-4955-a298-72183307ebba';   // 2026-07-04, $315.00, NOT_SYNC_READY
const INVOICE_NO = '10626557';
const ORDER_ID = '4569499';
const PDF = `${RC.pdf}/toprx-FL-4569499.pdf`;
const EXPECT_CENTS = 31500;
const AUDIT_PATH = RC.audit;

interface TxnState { state: string | null; syncStatus: string | null; receipts: number; userId: string | null }
interface RawTxn { id?: string; state?: string | null; sync_status?: string | null; receipts?: string[]; card_holder?: { user_id?: string } }

async function readState(token: string): Promise<TxnState> {
  const res = await rampGet<RawTxn>(ENTITY, `/transactions/${TXN_ID}`, token);
  if (res.status !== 200) throw new Error(`GET /transactions/${TXN_ID} -> HTTP ${res.status}`);
  const t = res.body;
  return {
    state: t.state ?? null,
    syncStatus: t.sync_status ?? null,
    receipts: (t.receipts ?? []).length,
    userId: t.card_holder?.user_id ?? null,
  };
}

function show(label: string, s: TxnState): void {
  console.log(`${label.padEnd(22)} state=${s.state} sync=${s.syncStatus} receipts=${s.receipts}`);
}

interface RawTxnFull extends RawTxn { memo?: string | null; line_items?: unknown }

async function runSplitAndMemo(live: boolean): Promise<void> {
  // accounting:read is REQUIRED — buildGlIndex calls getRampAccounts, and without that scope the
  // account list comes back empty, suspenseId is null, and buildVendorSplit returns null with no
  // explanation. Same scope strings run-toprx.ts uses.
  const token = await rampToken(ENTITY, live
    ? 'transactions:read transactions:write memos:write receipts:write accounting:read'
    : 'transactions:read accounting:read');
  const before = await readState(token);
  show('BEFORE', before);

  const raw = await rampGet<RawTxnFull>(ENTITY, `/transactions/${TXN_ID}`, token);
  const priorMemo = raw.body.memo ?? null;
  const priorLineItems = JSON.stringify(raw.body.line_items ?? []);
  console.log(`prior memo             ${priorMemo === null ? '(none)' : JSON.stringify(priorMemo)}`);
  console.log(`prior line_items       ${priorLineItems.slice(0, 160)}`);

  const txns = await getRampTransactions(ENTITY, token, 40);
  const txn = txns.find((t) => t.id === TXN_ID);
  if (!txn) throw new Error(`txn ${TXN_ID} not found`);
  if (Math.abs(txn.amountCents) !== EXPECT_CENTS) throw new Error(`amount guard failed: ${Math.abs(txn.amountCents)}`);

  const parsed = parseTopRxInvoice((await pdfParse(readFileSync(PDF))).text);
  if (parsed === null) throw new Error('invoice did not parse');
  // Same gate the pipeline uses: never split a txn from an invoice that doesn't reconcile to it.
  if (parsed.parsedTotalCents !== Math.abs(txn.amountCents)) {
    throw new Error(`no_reconcile: invoice ${parsed.parsedTotalCents} != txn ${Math.abs(txn.amountCents)}`);
  }
  const gl = await buildGlIndex(ENTITY, token);
  const built = buildVendorSplit('toprx', parsed, Math.abs(txn.amountCents), gl);
  if (built === null) throw new Error('split build failed');

  const memo = `TopRx invoice #${INVOICE_NO}, order #${ORDER_ID} (auto-captured)`;
  console.log(`\nmemo                   ${memo}`);
  console.log(`split                  ${built.lines.length} line(s), ${built.codedCount} coded / ${built.suspenseCount} suspense`);
  // VendorSplitLine.amount is in CENTS (vendor-split.ts compares it straight to txnAmountCents).
  for (const l of built.lines) console.log(`  $${(l.amount / 100).toFixed(2).padStart(9)}  ${l.coded ? l.glName : 'SUSPENSE'}  ${l.desc.slice(0, 46)}`);
  const sum = built.lines.reduce((a, l) => a + l.amount, 0);
  console.log(`  sum $${(sum / 100).toFixed(2)} vs txn $${(Math.abs(txn.amountCents) / 100).toFixed(2)} — ${sum === Math.abs(txn.amountCents) ? 'MATCH' : 'MISMATCH'}`);

  if (!live) { console.log('\nDRY-RUN — no memo, no split written.'); return; }

  const memoRes = await patchMemo(ENTITY, TXN_ID, memo, token);
  console.log(`\nPOST memo              HTTP ${memoRes.status}`);
  appendAudit(AUDIT_PATH, {
    runId: 'trial-toprx-second-receipt', mode: 'live', vendor: 'toprx', entity: ENTITY, txnId: TXN_ID,
    action: 'memo', invoiceKey: INVOICE_NO, amountCents: Math.abs(txn.amountCents), status: memoRes.status,
    detail: JSON.stringify(memoRes.body).slice(0, 300), priorMemo, priorLineItems,
  });

  const splitRes = await patchSplit(ENTITY, TXN_ID, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
  console.log(`PATCH split            HTTP ${splitRes.status} ${JSON.stringify(splitRes.body).slice(0, 160)}`);
  appendAudit(AUDIT_PATH, {
    runId: 'trial-toprx-second-receipt', mode: 'live', vendor: 'toprx', entity: ENTITY, txnId: TXN_ID,
    action: splitRes.status >= 200 && splitRes.status < 300 ? 'split' : 'error', invoiceKey: INVOICE_NO,
    amountCents: Math.abs(txn.amountCents), status: splitRes.status,
    detail: JSON.stringify(splitRes.body).slice(0, 300), priorMemo, priorLineItems,
  });

  await new Promise((r) => setTimeout(r, 20_000));
  const settled = await readState(token);
  show('AFTER (20s settle)', settled);
  const changed = before.state !== settled.state || before.syncStatus !== settled.syncStatus;
  console.log(`\nVERDICT: accounting state ${changed ? `CHANGED ${before.syncStatus} -> ${settled.syncStatus}` : 'UNCHANGED'}`);
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  if (process.argv.includes('--split-memo')) { await runSplitAndMemo(live); return; }
  const token = await rampToken(ENTITY, live ? 'transactions:read receipts:write' : 'transactions:read');

  const before = await readState(token);
  show('BEFORE', before);

  // Confirm we are on the transaction we think we are, by amount, before writing anything.
  const txns = await getRampTransactions(ENTITY, token, 40);
  const txn = txns.find((t) => t.id === TXN_ID);
  if (!txn) throw new Error(`txn ${TXN_ID} not found in the transaction list`);
  if (Math.abs(txn.amountCents) !== EXPECT_CENTS) {
    throw new Error(`amount guard: expected ${EXPECT_CENTS} cents, txn is ${Math.abs(txn.amountCents)} — refusing`);
  }
  const pdf = readFileSync(PDF);
  if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error(`${PDF} is not a PDF`);
  console.log(`target                 ${txn.date} $${(Math.abs(txn.amountCents) / 100).toFixed(2)} ${txn.merchantName} holder=${txn.cardHolder}`);
  console.log(`attaching              invoice ${INVOICE_NO} (order ${ORDER_ID}), ${pdf.length} bytes`);

  if (!live) {
    console.log('\nDRY-RUN — nothing written. Re-run with --live to upload this one receipt.');
    return;
  }

  const userId = txn.userId ?? before.userId;
  if (userId === null) throw new Error('no cardholder user_id — upload refused (a failed upload burns the idempotency key)');
  // Idempotency key is txn-scoped and stable, matching the sweep's convention, so a re-run of this
  // trial cannot produce a THIRD receipt.
  const key = `toprx-second-${TXN_ID}`;
  const res = await attachReceipt(ENTITY, TXN_ID, pdf, `TopRx-invoice-${INVOICE_NO}.pdf`, token, userId, key);
  console.log(`POST /receipts         HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  appendAudit(AUDIT_PATH, {
    runId: 'trial-toprx-second-receipt', mode: 'live', vendor: 'toprx', entity: ENTITY, txnId: TXN_ID,
    action: res.status >= 200 && res.status < 300 ? 'attach_receipt' : 'error',
    invoiceKey: INVOICE_NO, amountCents: Math.abs(txn.amountCents), status: res.status,
    detail: `trial_second_receipt ${JSON.stringify(res.body).slice(0, 200)}`, priorMemo: null, priorLineItems: '',
  });

  const after = await readState(token);
  show('AFTER (immediate)', after);
  await new Promise((r) => setTimeout(r, 20_000));
  const settled = await readState(token);
  show('AFTER (20s settle)', settled);

  const changed = before.state !== settled.state || before.syncStatus !== settled.syncStatus;
  console.log(`\nVERDICT: accounting state ${changed ? 'CHANGED — investigate before doing the rest' : 'UNCHANGED (receipt count only)'}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
