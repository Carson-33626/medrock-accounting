// Fill transaction-level MEMOS on Amazon + Walmart Ramp txns that lack one, using Ramp's own OCR to
// itemize each receipt. Clears the "missing memo" approval-backlog blocker with real content.
// Endpoint: POST /developer/v1/memos/{transaction_id} (spec-documented, verified 200 on 2026-07-23).
// Dry-run by default (writes a CSV preview only); --live POSTs. Honors the dry-run mandate: live
// writes need the explicit flag, are capped, audited to CSV, and record prior memo state.
//
//   cd web && npx tsx scripts/ramp-memo-fill.ts                          # dry-run, all entities+merchants
//   cd web && npx tsx scripts/ramp-memo-fill.ts --merchant amazon        # dry-run, Amazon only
//   cd web && npx tsx scripts/ramp-memo-fill.ts --live --cap 5           # live, first 5 writes
//   cd web && npx tsx scripts/ramp-memo-fill.ts --live --entity FL       # live, FL only
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import { getReceipt } from './receipt-enrichment/engines/amazon-enrich/client';
import { parseOcr } from './receipt-enrichment/engines/amazon-enrich/ocr-parser';
import { classify } from './receipt-enrichment/engines/amazon-enrich/classifier';
import { overrideLabel, isOcrClassify, loadHistoryLabels } from './ramp-memo-fill/merchant-rules';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const BASE = 'https://api.ramp.com/developer/v1';
const OUT = 'scripts/ramp-memo-fill/out';
const MEMO_MAX = 255;

type MerchantGroup = 'Amazon' | 'Walmart';
const GROUPS: { group: MerchantGroup; re: RegExp }[] = [
  { group: 'Amazon', re: /amazon/i },
  { group: 'Walmart', re: /walmart|sam'?s\s*club|sams\s*club/i },
];
function groupOf(name: string | null): MerchantGroup | null {
  return GROUPS.find((g) => g.re.test(name ?? ''))?.group ?? null;
}

interface Args { live: boolean; cap: number; entities: Entity[]; pages: number; groups: MerchantGroup[]; skipGeneric: boolean; allMerchants: boolean; exclude: string[] }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | null => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1] : null; };
  const ent = get('--entity');
  const m = get('--merchant');
  const groups: MerchantGroup[] = m
    ? (m.toLowerCase() === 'amazon' ? ['Amazon'] : m.toLowerCase() === 'walmart' ? ['Walmart'] : ['Amazon', 'Walmart'])
    : ['Amazon', 'Walmart'];
  return {
    live: a.includes('--live'),
    cap: Number(get('--cap') ?? '0') || 0,
    entities: ent ? (ent.split(',') as Entity[]) : (['FL', 'TN', 'TX'] as Entity[]),
    pages: Number(get('--pages') ?? '40') || 40,
    groups,
    skipGeneric: a.includes('--skip-generic'),
    allMerchants: a.includes('--all-merchants'),
    exclude: (get('--exclude') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status?: string;
  all_requirements_met_and_approved: boolean;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  sk_category_name: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

// allMerchants=true drops the Amazon/Walmart filter and accepts ANY merchant (still empty-memo,
// CLEARED only). groups still gates when allMerchants is false.
async function pullCandidates(entity: Entity, token: string, groups: MerchantGroup[], pages: number, allMerchants: boolean, exclude: string[]): Promise<RawTxn[]> {
  const out: RawTxn[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && next !== null; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
    if (res.status !== 200) break;
    const rows: RawTxn[] = res.body.data ?? [];
    if (rows.length === 0) break;
    for (const t of rows) {
      const nameLc = (t.merchant_name ?? '').toLowerCase();
      if (exclude.some((x) => nameLc.includes(x))) continue; // e.g. --exclude uline
      if (!allMerchants) {
        const g = groupOf(t.merchant_name);
        if (!g || !groups.includes(g)) continue;
      }
      if (t.state && t.state !== 'CLEARED') continue; // pending/declined not actionable
      if (t.all_requirements_met_and_approved !== false) continue; // only OPEN (floating) txns — a memo on an already-approved txn clears no blocker
      if (t.memo && t.memo.trim() !== '') continue; // already has a memo — never overwrite
      out.push(t);
    }
    next = res.body.page?.next ?? null;
  }
  return out;
}

const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/;
function parseOrder(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) { if (!t) continue; const m = ORDER_RE.exec(t); if (m) return m[0]; }
  return null;
}

// Descriptive category label = the leaf of the classifier's QB account name, e.g.
// "Inventory Asset:Lab Supplies Inventory" -> "Lab Supplies Inventory",
// "6200.80 General & Administrative -:Office Expense" -> "Office Expense".
const MEMO_CONF_FLOOR = 0.5; // descriptive memo (not a GL posting) — permissive; weak guesses -> Uncategorized
function categoryLabel(desc: string): string {
  const c = classify(desc);
  if (!c.glName || c.confidence < MEMO_CONF_FLOOR) return 'Uncategorized';
  const noCode = c.glName.replace(/^\d[\d.]*\s+/, ''); // strip a leading acctnum like "6200.80 "
  const leaf = noCode.split(':').pop()!.trim();
  return leaf || 'Uncategorized';
}

// Group a receipt's items into spend categories (via the item->GL classifier) with summed dollars,
// then render a <=255-char memo. Used for Amazon/Walmart AND blend vendors like ULINE:
//   1 category  -> "ULINE: Compound Packaging Inventory"
//   >1 category -> "Amazon: Lab Supplies Inventory $120.00, Office Expense $40.00 +N more"
function buildItemizedMemo(prefix: string, items: { desc: string; amountCents: number }[], order: string | null): string {
  const orderSuffix = order ? ` (order ${order})` : '';
  if (items.length === 0) return `${prefix} purchase${orderSuffix}`.slice(0, MEMO_MAX);

  const byCat = new Map<string, number>();
  for (const it of items) byCat.set(categoryLabel(it.desc), (byCat.get(categoryLabel(it.desc)) ?? 0) + it.amountCents);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]); // largest spend first
  const single = cats.length === 1;
  const render = (name: string, cents: number): string => (single ? name : `${name} $${(cents / 100).toFixed(2)}`);

  const parts: string[] = [];
  for (let i = 0; i < cats.length; i++) {
    const remaining = cats.length - (i + 1);
    const tail = remaining > 0 ? ` +${remaining} more` : '';
    const candidate = `${prefix}: ${[...parts, render(cats[i][0], cats[i][1])].join(', ')}${tail}${orderSuffix}`;
    if (candidate.length > MEMO_MAX && parts.length > 0) break;
    parts.push(render(cats[i][0], cats[i][1]));
  }
  const dropped = cats.length - parts.length;
  const tail = dropped > 0 ? ` +${dropped} more` : '';
  let memo = `${prefix}: ${parts.join(', ')}${tail}${orderSuffix}`;
  if (memo.length > MEMO_MAX) memo = memo.slice(0, MEMO_MAX - 1).trimEnd() + '…';
  return memo;
}

// General (non-Amazon/Walmart) memo: use the merchant name + Ramp's own auto-assigned category
// (sk_category_name, populated on ~100% of txns) + OCR item names when present. The pharmacy GL
// classifier isn't used here — it can't categorize a burrito or a fuel charge. Renders <=255 chars:
//   no items -> "Uber — Taxi and Rideshare"
//   w/ items -> "Doordash — Restaurants: Grilled Chicken Sandwich, Fried Shrimp +2 more"
function buildGeneralMemo(merchant: string | null, category: string | null, items: { desc: string }[], order: string | null): string {
  const m = (merchant ?? '').replace(/\s+/g, ' ').trim() || 'Purchase';
  const cat = (category ?? '').replace(/\s+/g, ' ').trim();
  const head = `${m}${cat ? ` — ${cat}` : ''}`;
  const orderSuffix = order ? ` (order ${order})` : '';
  const names = [...new Set(items.map((i) => i.desc.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (names.length === 0) return `${head}${orderSuffix}`.slice(0, MEMO_MAX);
  const parts: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const remaining = names.length - (i + 1);
    const tail = remaining > 0 ? ` +${remaining} more` : '';
    const candidate = `${head}: ${[...parts, names[i]].join(', ')}${tail}${orderSuffix}`;
    if (candidate.length > MEMO_MAX && parts.length > 0) break;
    parts.push(names[i]);
  }
  const dropped = names.length - parts.length;
  const tail = dropped > 0 ? ` +${dropped} more` : '';
  let memo = `${head}: ${parts.join(', ')}${tail}${orderSuffix}`;
  if (memo.length > MEMO_MAX) memo = memo.slice(0, MEMO_MAX - 1).trimEnd() + '…';
  return memo;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Resilient memo POST: retries transient network errors + 429/5xx with backoff, and NEVER throws
// (returns status 0 on final failure) so one blip can't kill a 1,200-txn run mid-stream.
async function postMemo(txnId: string, memo: string, token: string, retries = 4): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/memos/${txnId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    } catch (e) {
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      return { status: 0, body: `fetch error: ${(e as Error).message}` };
    }
  }
}

function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function money(cents: number): string { return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const scope = args.live ? 'transactions:read receipts:read memos:write' : 'transactions:read receipts:read';
  const historyLabels = loadHistoryLabels(`${OUT}/merchant_gl_history.csv`); // vendor -> dominant manual GL leaf

  const rows: string[] = ['entity,group,txn_id,date,cardholder,amount,receipt,items,source,memo,mode,http'];
  // Write-through audit: load any prior record, then persist after EVERY successful write so a
  // mid-run stop is always fully recorded (prior end-of-run flush lost writes when killed early).
  interface AuditRec { entity: Entity; txn_id: string; prior_memo: string | null; new_memo: string }
  const auditPath = `${OUT}/memo_audit.json`;
  const audit: AuditRec[] = existsSync(auditPath) ? (JSON.parse(readFileSync(auditPath, 'utf8')) as AuditRec[]) : [];
  const auditSeen = new Set(audit.map((r) => r.txn_id));
  const recordAudit = (rec: AuditRec): void => {
    if (auditSeen.has(rec.txn_id)) return;
    audit.push(rec); auditSeen.add(rec.txn_id);
    writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  };
  const stats: Record<string, { candidates: number; itemized: number; generic: number; noReceipt: number; written: number; failed: number; skipped: number }> = {};
  const samples: string[] = [];
  let liveWrites = 0;

  for (const entity of args.entities) {
    const s = stats[entity] = { candidates: 0, itemized: 0, generic: 0, noReceipt: 0, written: 0, failed: 0, skipped: 0 };
    const token = await rampToken(entity, scope);
    const cands = await pullCandidates(entity, token, args.groups, args.pages, args.allMerchants, args.exclude);
    s.candidates = cands.length;

    for (const t of cands) {
      const g = groupOf(t.merchant_name); // null for non-Amazon/Walmart merchants
      const groupLabel = g ?? 'Other';
      const cents = Math.round(t.amount * 100);
      const holder = t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : '';
      const order = parseOrder(t.merchant_descriptor);

      let items: { desc: string; amountCents: number }[] = [];
      let source = 'none';
      const rid = t.receipts?.[0] ?? null;
      if (rid) {
        try {
          const meta = await getReceipt(entity, rid, token);
          const parsed = parseOcr(meta.ocr);
          if (parsed.items.length > 0) { items = parsed.items; source = 'ocr'; }
          else source = meta.url ? 'receipt_no_ocr' : 'no_receipt_url';
        } catch { source = 'receipt_err'; }
      } else {
        source = 'no_receipt';
      }

      const isGeneric = items.length === 0;
      if (isGeneric) { s.noReceipt++; if (args.skipGeneric) { s.skipped++; continue; } s.generic++; }
      else s.itemized++;

      // Memo label priority: Amazon/Walmart -> per-item classifier; ULINE-style blend -> per-item
      // classifier when OCR present; else override -> manual history -> Ramp category.
      let memo: string;
      if (g) {
        memo = buildItemizedMemo(g, items, order);
      } else if (isOcrClassify(t.merchant_name) && items.length > 0) {
        memo = buildItemizedMemo((t.merchant_name ?? 'Purchase').trim() || 'Purchase', items, order);
      } else {
        const cat = overrideLabel(t.merchant_name)
          ?? historyLabels.get((t.merchant_name ?? '').toLowerCase())
          ?? t.sk_category_name;
        memo = buildGeneralMemo(t.merchant_name, cat, items, order);
      }

      const capped = args.live && args.cap > 0 && liveWrites >= args.cap;
      const mode = args.live && !capped ? 'live' : 'dry_run';
      let http = '';
      if (mode === 'live') {
        const res = await postMemo(t.id, memo, token);
        http = String(res.status);
        if (res.status < 200 || res.status >= 300) { s.failed++; }
        else { s.written++; liveWrites++; recordAudit({ entity, txn_id: t.id, prior_memo: t.memo, new_memo: memo }); }
      }
      rows.push([entity, groupLabel, t.id, (t.user_transaction_time ?? '').slice(0, 10), holder, (cents / 100).toFixed(2),
        rid ? 'y' : 'n', items.length, source, memo, mode, http].map(csv).join(','));
      if (samples.length < 15) samples.push(`  [${entity}/${groupLabel}] ${money(cents)}  "${memo}"`);
    }

    console.log(`${entity}: candidates ${s.candidates} | itemized ${s.itemized} | generic ${s.generic} | no-receipt ${s.noReceipt} | written ${s.written} | failed ${s.failed} | skipped ${s.skipped}`);
  }

  writeFileSync(`${OUT}/preview_memos.csv`, rows.join('\n')); // audit persisted write-through above

  console.log('\n=== SAMPLE PROPOSED MEMOS ===');
  for (const line of samples) console.log(line);
  console.log(`(see ${OUT}/preview_memos.csv for all ${rows.length - 1} proposed memos)`);
  console.log(`\nMODE: ${args.live ? `LIVE (cap ${args.cap || '∞'}, ${liveWrites} written)` : 'DRY-RUN (no writes)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
