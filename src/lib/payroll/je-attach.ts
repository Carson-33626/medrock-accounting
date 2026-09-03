/**
 * Attach a posted journal entry's own workbook — the entry plus everything it was computed
 * from — to the entry in QuickBooks.
 *
 * THE FAILURE POLICY IS THE WHOLE DESIGN (DS §3.3). By the time this runs the JE is already
 * live in QuickBooks: a 500 from `/upload` cannot unpost it, and code that tries corrupts the
 * audit trail. So nothing here throws. Every path returns an outcome, the outcome is written
 * to `accounting.payroll_post_audit`, and the caller reports the post as the success it is.
 * A failed attachment leaves a posted JE with no file and an audit row saying so — visible,
 * retryable, honest.
 *
 * IDEMPOTENT (DS §3.4). The file name is deterministic, so a retry checks for it first — in
 * our audit table (the authority; see `hasAttachedFile`) and then, best-effort, against
 * QuickBooks' own `Attachable` list. Either hit skips the upload.
 *
 * NO BACKFILL. This runs on new posts only. DS §6: the ADP source rows behind the 112 already
 * posted 2026 entries are not retained, ADP restates, and a re-pull would attach a
 * reconstruction that reads as the original.
 */
import { buildXlsxBuffer, XLSX_CONTENT_TYPE } from '@/lib/inventory-export';
import { qbUpload, qbQueryAll, type QbAttachable } from '@/lib/quickbooks-multi';
import { buildJeSourceWorkbook } from './je-workbook';
import { insertAudit, hasAttachedFile, type PayrollHeader } from './store';
import type { Entity, JournalLine } from './types';

export type AttachStatus = 'attached' | 'skipped' | 'failed';

export interface AttachOutcome {
  status: AttachStatus;
  fileName: string;
  /** Set on 'attached'. */
  attachableId?: string;
  /** Sheet names that went into the file, so the audit row records WHAT was attached. */
  sheets?: string[];
  /** Set on 'skipped' / 'failed'. */
  reason?: string;
}

/** Injectable so a test can force an upload failure without touching QuickBooks. */
export interface AttachDeps {
  upload: (entity: Entity, file: { fileName: string; contentType: string; bytes: Buffer; entityRef: { type: string; value: string } }) => Promise<QbAttachable>;
  listAttachables: (entity: Entity, fileName: string) => Promise<Array<{ Id?: string }>>;
}

const defaultDeps: AttachDeps = {
  upload: (entity, file) => qbUpload(entity, file),
  // FileName is the deterministic key, so this is a string comparison rather than a content
  // hash. Best-effort only: the query surface for Attachable is unverified, and its failure
  // must not stop an attachment the audit table says has never been made.
  listAttachables: (entity, fileName) =>
    qbQueryAll<{ Id?: string }>(entity, 'Attachable', `WHERE FileName = '${fileName.replace(/'/g, "\\'")}'`),
};

/** `JE_MedRock_FL_PR_2026.07.01_source.xlsx` — stable for the life of the entry. */
export function jeAttachmentFileName(workbookFilename: string): string {
  return `${workbookFilename}_source.xlsx`;
}

export async function attachJeWorkbook(
  header: PayrollHeader,
  lines: readonly JournalLine[],
  qb: { entryId: string; docNumber?: string },
  deps: AttachDeps = defaultDeps,
): Promise<AttachOutcome> {
  let fileName = `JE_${header.entity}_${header.id}_source.xlsx`.replace(/[^A-Za-z0-9._-]+/g, '_');
  try {
    const workbook = await buildJeSourceWorkbook(header, lines, {
      overrides: qb.docNumber === undefined ? undefined : { docNumber: qb.docNumber, txnDate: header.txn_date ?? '' },
    });
    fileName = jeAttachmentFileName(workbook.filename);

    if (await hasAttachedFile(header.id, fileName)) {
      return { status: 'skipped', fileName, reason: 'already attached' };
    }
    if (await alreadyInQuickBooks(deps, header.entity, fileName)) {
      return { status: 'skipped', fileName, reason: 'already attached in QuickBooks' };
    }

    const bytes = await buildXlsxBuffer(workbook.sheets, workbook.note);
    const attachable = await deps.upload(header.entity, {
      fileName,
      contentType: XLSX_CONTENT_TYPE,
      bytes,
      entityRef: { type: 'JournalEntry', value: qb.entryId },
    });

    const outcome: AttachOutcome = {
      status: 'attached',
      fileName,
      attachableId: attachable.Id,
      sheets: workbook.sheets.map((s) => s.name),
    };
    await audit(header, qb, outcome);
    return outcome;
  } catch (error) {
    const outcome: AttachOutcome = {
      status: 'failed',
      fileName,
      reason: error instanceof Error ? error.message : 'attachment failed',
    };
    await audit(header, qb, outcome);
    return outcome;
  }
}

async function alreadyInQuickBooks(deps: AttachDeps, entity: Entity, fileName: string): Promise<boolean> {
  try {
    return (await deps.listAttachables(entity, fileName)).length > 0;
  } catch (error) {
    console.warn('[je-attach] Attachable lookup skipped:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Records the outcome and swallows its own failure. The audit row is the point of this whole
 * step, but an audit-write error still must not surface to a caller whose JE posted fine.
 */
async function audit(
  header: PayrollHeader,
  qb: { entryId: string; docNumber?: string },
  outcome: AttachOutcome,
): Promise<void> {
  if (outcome.status === 'skipped') return;
  try {
    await insertAudit({
      headerId: header.id,
      mode: 'live',
      entity: header.entity,
      qbEntryId: qb.entryId,
      qbDocNumber: qb.docNumber,
      outcome: outcome.status === 'attached' ? 'attached' : 'attach_error',
      responseBody: {
        fileName: outcome.fileName,
        attachableId: outcome.attachableId ?? null,
        sheets: outcome.sheets ?? [],
      },
      reason: outcome.reason,
    });
  } catch (error) {
    console.error('[je-attach] failed to write attachment audit row', error);
  }
}
