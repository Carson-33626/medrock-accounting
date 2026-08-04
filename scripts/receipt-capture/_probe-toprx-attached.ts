// The cached TopRx invoice PDFs on disk are fully populated (line items, totals, invoice number),
// so "blank receipts" is NOT a capture failure. That leaves the other half of the path: what Ramp
// actually stores and shows her. This pulls the receipt Ramp holds for each TopRx txn we attached
// to, downloads it, and compares byte size + extracted text against the local cache we uploaded.
//
// A mismatch means the upload sent the wrong bytes; a match means the file is fine and the "blank"
// is a rendering/viewing problem (or she is looking at receipts from a different source). READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-toprx-attached.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

const AUDIT = 'scripts/receipt-capture/out/receipt-capture-audit.csv';
const PDF_DIR = 'scripts/receipt-capture/out/pdf';

interface RampReceipt { id?: string; receipt_url?: string; created_at?: string; file_name?: string }

interface AttachRow { entity: Entity; txnId: string; invoiceKey: string; receiptId: string }

// audit.csv columns: ts,runId,mode,vendor,entity,txnId,action,invoiceKey,amountCents,status,detail,...
function readAttachRows(entityFilter: string): AttachRow[] {
  const out: AttachRow[] = [];
  for (const line of readFileSync(AUDIT, 'utf8').split(/\r?\n/)) {
    if (!line.includes(',toprx,') || !line.includes(',attach_receipt,')) continue;
    const c = line.split(',');
    const entity = c[4] as Entity;
    if (entityFilter !== '' && entity !== entityFilter) continue;
    if (!ALL_ENTITIES.includes(entity)) continue;
    const m = /"\{""id"":""([0-9a-f-]{36})""/.exec(line);
    out.push({ entity, txnId: c[5], invoiceKey: c[7], receiptId: m ? m[1] : '' });
  }
  return out;
}

async function textOf(buf: Buffer): Promise<{ chars: number; head: string }> {
  try {
    const p = await pdfParse(buf);
    const t = (p.text ?? '').replace(/\s+/g, ' ').trim();
    return { chars: t.length, head: t.slice(0, 90) };
  } catch (e) {
    return { chars: -1, head: `PARSE FAILED: ${(e as Error).message.slice(0, 60)}` };
  }
}

function localPdfFor(entity: Entity, invoiceKey: string): string | null {
  const direct = `${PDF_DIR}/toprx-${entity}-${invoiceKey}.pdf`;
  if (existsSync(direct)) return direct;
  // The receipt filename uses the INVOICE number but the cache is keyed by ORDER id (or vice
  // versa), so fall back to any cached file whose name contains the key.
  const hit = readdirSync(PDF_DIR).find((f) => f.includes(`-${entity}-`) && f.includes(invoiceKey));
  return hit ? `${PDF_DIR}/${hit}` : null;
}

async function main(): Promise<void> {
  const entityFilter = process.argv[2] ?? '';
  const rows = readAttachRows(entityFilter);
  console.log(`${rows.length} TopRx attach_receipt row(s) in the audit${entityFilter ? ` for ${entityFilter}` : ''}`);

  // --receipt <ENT> <id>: dump any single receipt. Used to compare the 6 blank FL receipts (none of
  // which appear in our audit) against one we uploaded — user_id and created_at identify who put it
  // there, which decides whether "blank TopRx receipts" is our bug or another capture path's.
  const ri = process.argv.indexOf('--receipt');
  if (ri !== -1) {
    const ent = process.argv[ri + 1] as Entity;
    const id = process.argv[ri + 2];
    const token = await rampToken(ent, 'receipts:read');
    const meta = await rampGet<Record<string, unknown>>(ent, `/receipts/${id}`, token);
    const body = meta.body as { receipt_url?: string; user_id?: string; created_at?: string; transaction_id?: string };
    console.log(`receipt ${id}: user_id=${body.user_id} created_at=${body.created_at} txn=${body.transaction_id}`);
    if (body.receipt_url) {
      const buf = Buffer.from(await (await fetch(body.receipt_url)).arrayBuffer());
      console.log(`  bytes=${buf.length} magic=${JSON.stringify(buf.subarray(0, 8).toString('latin1'))}`);
      const t = await textOf(buf);
      console.log(`  chars=${t.chars} head=${t.head}`);
    }
    return;
  }

  // Every receipt returned 200 with no download_url, which is more likely a field-name assumption
  // than 21 genuinely fileless receipts. Dump the real object before drawing any conclusion.
  if (process.argv.includes('--raw')) {
    const r = rows[0];
    const token = await rampToken(r.entity, 'receipts:read transactions:read');
    const meta = await rampGet<Record<string, unknown>>(r.entity, `/receipts/${r.receiptId}`, token);
    console.log(`GET /receipts/${r.receiptId} -> HTTP ${meta.status}`);
    console.log(JSON.stringify(meta.body, null, 2));
    return;
  }

  const tokens = new Map<Entity, string>();
  for (const r of rows) {
    if (!tokens.has(r.entity)) tokens.set(r.entity, await rampToken(r.entity, 'receipts:read transactions:read'));
    const token = tokens.get(r.entity) as string;

    const meta = await rampGet<RampReceipt>(r.entity, `/receipts/${r.receiptId}`, token);
    if (meta.status !== 200) {
      console.log(`[${r.entity}] ${r.invoiceKey} receipt ${r.receiptId}: GET /receipts -> HTTP ${meta.status}`);
      continue;
    }
    // Ramp calls it receipt_url, not download_url — verified against the raw object.
    const url = meta.body.receipt_url ?? '';
    if (url === '') {
      console.log(`[${r.entity}] ${r.invoiceKey}: no receipt_url on receipt ${r.receiptId}`);
      continue;
    }
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const isPdf = buf.subarray(0, 4).toString('latin1') === '%PDF';
    const remote = await textOf(buf);

    const localPath = localPdfFor(r.entity, r.invoiceKey);
    const local = localPath ? await textOf(readFileSync(localPath)) : { chars: -2, head: '(no local cache file)' };
    const localBytes = localPath ? readFileSync(localPath).length : 0;

    const verdict = !isPdf ? 'NOT-A-PDF'
      : remote.chars < 200 ? 'REMOTE-EMPTY'
      : localPath === null ? 'no-local-compare'
      : buf.length === localBytes ? 'IDENTICAL'
      : 'DIFFERENT-BYTES';
    console.log(
      `[${r.entity}] ${r.invoiceKey.padEnd(10)} ramp=${String(buf.length).padStart(7)}B/${String(remote.chars).padStart(5)}ch ` +
      `local=${String(localBytes).padStart(7)}B/${String(local.chars).padStart(5)}ch  ${verdict}`,
    );
    if (verdict !== 'IDENTICAL') console.log(`      ramp text: ${remote.head}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
