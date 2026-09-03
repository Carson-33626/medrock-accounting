/**
 * ONE-SHOT, REVERSIBLE: does QuickBooks accept an .xlsx attachment on a JournalEntry?
 *
 * DS §3.1's open question. Intuit's docs are JS-rendered and could not be read
 * programmatically, and guessing at an API contract is how this ships broken. This settles it
 * with exactly ONE upload against ONE company, verifies the file is on the entry, then DELETES
 * it. Nothing else — no bulk operations, no second company, no posting of any journal entry.
 *
 * Carson approved this single reversible write on 2026-09-03. It requires --confirm and a
 * header id, and it deletes what it uploads before it exits.
 *
 *   npx tsx scripts/payroll/_probe-qb-attachment-contenttype.ts <headerId> --confirm
 */
import './load-env-vercel-first';
import { loadDraft } from '../../src/lib/payroll/store';
import { buildJeSourceWorkbook } from '../../src/lib/payroll/je-workbook';
import { buildXlsxBuffer, XLSX_CONTENT_TYPE } from '../../src/lib/inventory-export';
import { qbUpload, qbPost, qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { JsonValue } from '../../src/lib/payroll/store';

interface AttachableRow {
  Id: string;
  SyncToken?: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
  AttachableRef?: Array<{ EntityRef?: { type?: string; value?: string } }>;
}

async function main(): Promise<void> {
  const headerId = Number(process.argv[2]);
  if (!Number.isFinite(headerId) || !process.argv.includes('--confirm')) {
    console.error('usage: npx tsx scripts/payroll/_probe-qb-attachment-contenttype.ts <headerId> --confirm');
    process.exit(2);
  }

  const loaded = await loadDraft(headerId);
  if (!loaded) throw new Error(`header ${headerId} not found`);
  const { header, lines } = loaded;
  if (!header.qb_entry_id) throw new Error(`header ${headerId} has no qb_entry_id — nothing to attach to`);

  console.log(`target: ${header.entity} JournalEntry ${header.qb_entry_id} (${header.qb_doc_number ?? '—'}), header #${headerId}`);

  const workbook = await buildJeSourceWorkbook(header, lines, { skipAccountNums: true });
  const bytes = await buildXlsxBuffer(workbook.sheets, workbook.note);
  const fileName = `ZZ_CONTENT_TYPE_TEST_${workbook.filename}.xlsx`;
  console.log(`file: ${fileName} — ${bytes.length} bytes, ${workbook.sheets.length} sheets, content type ${XLSX_CONTENT_TYPE}`);

  let attachableId: string | null = null;
  try {
    const attachable = await qbUpload(header.entity, {
      fileName,
      contentType: XLSX_CONTENT_TYPE,
      bytes,
      entityRef: { type: 'JournalEntry', value: header.qb_entry_id },
    });
    attachableId = attachable.Id;
    console.log(`ACCEPTED — Attachable ${attachable.Id}, ContentType '${attachable.ContentType ?? ''}', Size ${attachable.Size ?? '?'}`);

    // Does a FileName query work? That is the idempotency check in je-attach.
    const byName = await qbQueryAll<AttachableRow>(header.entity, 'Attachable', `WHERE FileName = '${fileName}'`);
    console.log(`FileName query: ${byName.length} row(s)`);
    for (const r of byName) {
      const ref = r.AttachableRef?.[0]?.EntityRef;
      console.log(`  Id=${r.Id} FileName=${r.FileName} ContentType=${r.ContentType} -> ${ref?.type}/${ref?.value}`);
    }
  } catch (error) {
    console.error('REJECTED:', error instanceof Error ? error.message : error);
  }

  if (attachableId === null) {
    console.log('nothing uploaded — nothing to clean up');
    return;
  }

  // Clean up: this test leaves NOTHING behind.
  const current = await qbQueryAll<AttachableRow>(header.entity, 'Attachable', `WHERE Id = '${attachableId}'`);
  const syncToken = current[0]?.SyncToken ?? '0';
  const deleted = await qbPost<{ Attachable?: { Id?: string; status?: string } }>(
    header.entity,
    'attachable?operation=delete&minorversion=75',
    { Id: attachableId, SyncToken: syncToken } as unknown as JsonValue,
  );
  console.log(`DELETED Attachable ${attachableId}: status=${deleted.Attachable?.status ?? 'unknown'}`);

  const after = await qbQueryAll<AttachableRow>(header.entity, 'Attachable', `WHERE FileName = '${fileName}'`);
  console.log(`post-delete FileName query: ${after.length} row(s) — ${after.length === 0 ? 'CLEAN' : 'STILL PRESENT, remove by hand'}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
