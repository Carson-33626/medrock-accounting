// Amazon enrichment — one run. Fetch eligible Amazon Ramp txns, parse their receipts, classify each
// line -> GL, reconcile to the cent, and split the txn (PATCH). Dry-run by default (writes CSV
// previews only); pass --live to write. Honors the [[accounting-automation-dry-run-mandate]]:
// live writes require the explicit flag + are capped, audited to CSV, and fully reversible.
//
//   cd web && npx tsx scripts/amazon-enrich/run.ts                 # dry-run, all entities
//   cd web && npx tsx scripts/amazon-enrich/run.ts --entity TN     # dry-run one entity
//   cd web && npx tsx scripts/amazon-enrich/run.ts --live --cap 10 # live, first 10 eligible writes
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  rampToken, getEligibleAmazonTxns, getReceipt, downloadReceipt, patchSplit,
} from './client';
import type { EligibleTxn, ReceiptMeta } from './client';
import { parseReceiptPdf } from './receipt-parser';
import type { ParsedReceipt } from './receipt-parser';
import { parseOcr } from './ocr-parser';
import { buildGlIndex } from './gl-resolve';
import { buildSplit } from './split';
import { isBasketMerchant, matchBasketMerchant } from './basket-merchants';
import type { Entity } from '../ramp-split-push/types';

const SCOPES_READ = 'transactions:read receipts:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write receipts:read accounting:read';
const CACHE = 'scripts/amazon-enrich/.receipts_cache';
const OUT = 'scripts/amazon-enrich/out';

interface Args { live: boolean; cap: number; entities: Entity[]; pages: number; basket: boolean }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | null => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1] : null; };
  const ent = get('--entity');
  return {
    live: a.includes('--live'),
    cap: Number(get('--cap') ?? '0') || 0, // 0 = no cap
    entities: ent ? (ent.split(',') as Entity[]) : (['FL', 'TN', 'TX'] as Entity[]),
    pages: Number(get('--pages') ?? '15') || 15,
    basket: a.includes('--basket'), // Track A: widen from Amazon-only to the basket-vendor allowlist
  };
}

// Receipt metadata (url, ext, Ramp OCR) in one call, cached. `include_ocr_data=true` is what
// populates the ocr block.
async function cachedMeta(entity: Entity, rid: string, token: string): Promise<ReceiptMeta> {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${rid}.rcpt.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as ReceiptMeta;
  const meta = await getReceipt(entity, rid, token);
  writeFileSync(f, JSON.stringify(meta));
  return meta;
}

// Only downloaded when the pdf-parse fallback is needed (OCR didn't reconcile a PDF receipt).
async function cachedPdf(rid: string, url: string): Promise<Buffer | null> {
  const file = `${CACHE}/${rid}.pdf`;
  if (existsSync(file)) return readFileSync(file);
  try {
    const bytes = await downloadReceipt(url);
    writeFileSync(file, bytes);
    return bytes;
  } catch {
    return null;
  }
}

const EMPTY_PDF: ParsedReceipt = {
  layout: null, source: 'pdf', order: null, glHint: null, items: [], taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: 0,
};

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type SetAsideReason = 'image_no_ocr' | 'no_receipt_url' | 'parse_fail' | 'no_reconcile' | 'build_fail';

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const previewRows: string[] = ['entity,merchant,txn_id,date,cardholder,amount,source,layout,line_desc,split_amount,gl_name,confidence,coded,mode'];
  const setAsideRows: string[] = ['entity,merchant,txn_id,date,amount,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; prior_line_items: unknown }[] = [];
  const summary: Record<string, { eligible: number; split: number; setAside: number; writeFail: number; coded: number; suspense: number }> = {};
  // Track A: reconcile outcome per merchant group so we can see which basket vendors actually itemize.
  const byMerchant: Map<string, { eligible: number; split: number; setAside: number }> = new Map();
  const bump = (label: string, k: 'eligible' | 'split' | 'setAside'): void => {
    const m = byMerchant.get(label) ?? { eligible: 0, split: 0, setAside: 0 };
    m[k]++; byMerchant.set(label, m);
  };
  const groupOf = (name: string | null): string => matchBasketMerchant(name)?.label ?? (name ?? 'Other');
  let liveWrites = 0;

  for (const entity of args.entities) {
    const s = summary[entity] = { eligible: 0, split: 0, setAside: 0, writeFail: 0, coded: 0, suspense: 0 };
    const token = await rampToken(entity, args.live ? SCOPES_WRITE : SCOPES_READ);
    const index = await buildGlIndex(entity, token);
    const txns: EligibleTxn[] = await getEligibleAmazonTxns(entity, token, args.pages, args.basket ? isBasketMerchant : undefined);
    s.eligible = txns.length;

    for (const t of txns) {
      const mg = groupOf(t.merchantName);
      bump(mg, 'eligible');
      const aside = (reason: SetAsideReason, detail = ''): void => {
        s.setAside++;
        bump(mg, 'setAside');
        setAsideRows.push([entity, mg, t.id, t.date, (t.amountCents / 100).toFixed(2), reason, detail].map(csv).join(','));
      };
      if (!t.receiptId) { aside('no_receipt_url'); continue; }
      let meta: ReceiptMeta;
      try { meta = await cachedMeta(entity, t.receiptId, token); } catch (e) { aside('no_receipt_url', (e as Error).message); continue; }
      if (!meta.url) { aside('no_receipt_url'); continue; }

      // PRIMARY: Ramp OCR (covers PDF + image receipts). FALLBACK: pdf-parse for PDFs OCR fumbles.
      let parsed: ParsedReceipt | null = null;
      const ocr = parseOcr(meta.ocr);
      if (ocr.layout && ocr.parsedTotalCents === t.amountCents) parsed = ocr;
      if (!parsed && meta.ext === 'pdf') {
        const bytes = await cachedPdf(t.receiptId, meta.url);
        if (bytes) {
          let p: ParsedReceipt;
          try { p = await parseReceiptPdf(bytes); } catch { p = EMPTY_PDF; }
          if (p.layout && p.items.length > 0 && p.parsedTotalCents === t.amountCents) parsed = p;
        }
      }
      if (!parsed) {
        if (ocr.layout) aside('no_reconcile', `ocr=$${(ocr.parsedTotalCents / 100).toFixed(2)} ext=${meta.ext}`);
        else if (meta.ext !== 'pdf') aside('image_no_ocr', meta.ext);
        else aside('parse_fail', 'no_layout');
        continue;
      }
      const built = buildSplit(parsed, t.amountCents, index);
      if (!built) { aside('build_fail'); continue; }

      const capped = args.live && args.cap > 0 && liveWrites >= args.cap;
      const mode = args.live && !capped ? 'live' : 'dry_run';
      if (mode === 'live') {
        const res = await patchSplit(entity, t.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
        if (res.status < 200 || res.status >= 300) {
          s.writeFail++;
          setAsideRows.push([entity, t.id, t.date, (t.amountCents / 100).toFixed(2), 'write_fail', `HTTP ${res.status}`].map(csv).join(','));
          continue;
        }
        liveWrites++;
        rollback.push({ entity, txn_id: t.id, prior_line_items: t.priorLineItems });
      }
      s.split++;
      bump(mg, 'split');
      s.coded += built.codedCount;
      s.suspense += built.suspenseCount;
      for (const l of built.lines) {
        previewRows.push([entity, mg, t.id, t.date, t.cardHolder, (t.amountCents / 100).toFixed(2), parsed.source, parsed.layout,
          l.desc, (l.amount / 100).toFixed(2), l.glName, l.confidence, l.coded, mode].map(csv).join(','));
      }
    }
    console.log(`${entity}: eligible ${s.eligible} | split ${s.split} | set-aside ${s.setAside} | write-fail ${s.writeFail} | lines coded ${s.coded} / suspense ${s.suspense}`);
  }

  writeFileSync(`${OUT}/preview_splits.csv`, previewRows.join('\n'));
  writeFileSync(`${OUT}/set_aside.csv`, setAsideRows.join('\n'));
  // Append to the rollback audit trail — never clobber prior live runs' snapshots. Dedup by txn_id.
  if (rollback.length) {
    const path = `${OUT}/rollback.json`;
    const prior: typeof rollback = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seen = new Set(prior.map((r) => r.txn_id));
    const merged = [...prior, ...rollback.filter((r) => !seen.has(r.txn_id))];
    writeFileSync(path, JSON.stringify(merged, null, 2));
  }
  if (args.basket) {
    console.log('\n=== PER-MERCHANT RECONCILE (eligible → split / set-aside) ===');
    const rows = [...byMerchant.entries()].sort((a, b) => b[1].eligible - a[1].eligible);
    for (const [label, m] of rows) {
      const pct = m.eligible ? Math.round((m.split / m.eligible) * 100) : 0;
      console.log(`  ${label.slice(0, 26).padEnd(26)} eligible=${String(m.eligible).padStart(4)}  split=${String(m.split).padStart(4)}  set-aside=${String(m.setAside).padStart(4)}  reconcile=${pct}%`);
    }
  }
  console.log(`\nMODE: ${args.live ? `LIVE (cap ${args.cap || '∞'}, ${liveWrites} written)` : 'DRY-RUN (no writes)'}`);
  console.log(`Wrote ${OUT}/preview_splits.csv (${previewRows.length - 1} lines), ${OUT}/set_aside.csv (${setAsideRows.length - 1})${rollback.length ? `, ${OUT}/rollback.json (${rollback.length})` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
