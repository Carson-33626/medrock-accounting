/**
 * Pull a posted journal entry back out of QuickBooks so it can be regenerated and
 * reposted — the "undo" behind every posted receipt.
 *
 * Carson, 2026-09-14: *"have an undo / pull down button to delete the posted journal
 * so we can regenerate and repost it."*
 *
 * THE ORDER IS THE SAFETY. QuickBooks is the system of record, so it goes first and
 * nothing local changes until QuickBooks has confirmed the delete:
 *
 *   1. Read the entry back by Id (SyncToken, DocNumber) — a header that claims
 *      "posted" against an entry QuickBooks no longer has is a disagreement to
 *      STOP on, not paper over.
 *   2. Delete the workbook attachment(s) we recorded for it (the audit rows that
 *      say `attached`). Best-effort: an orphaned file is untidy, a lost entry is not.
 *   3. `journalentry?operation=delete` — the same call the payroll undo scripts
 *      have run live (scripts/payroll/cs-allo-2026-08-undo.ts).
 *   4. Only then: header back to `needs_review`, `qb_entry_id` and `qb_doc_number`
 *      cleared so the identity is re-derived on the next post, and an `unposted`
 *      audit row carrying who/why. Regeneration is unlocked by the status flip.
 *
 * Idempotent on the attach side: a `detached` audit row is written per file, and
 * `hasAttachedFile` reads the LATEST event, so the repost attaches a fresh file
 * instead of being skipped as "already attached".
 */
import { qbPost, qbQueryAll } from '@/lib/quickbooks-multi';
import { getRdsPool } from '@/lib/rds';
import { insertAudit, listAttachedFiles, type PayrollHeader, type JsonValue } from './store';

interface QbJournalEntryRow {
  Id?: string;
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
}

interface QbAttachableRow {
  Id?: string;
  SyncToken?: string;
  FileName?: string;
}

export interface UnpostOutcome {
  qbEntryId: string;
  qbDocNumber: string | null;
  /** Attachable ids removed from QuickBooks. */
  detached: string[];
  /** Attachments we could not remove — left in QuickBooks, named so someone can. */
  detachFailed: string[];
}

export async function unpostJournalEntry(header: PayrollHeader, reason: string): Promise<UnpostOutcome> {
  const entity = header.entity;
  const qbEntryId = header.qb_entry_id;
  if (header.status !== 'posted' || !qbEntryId) {
    throw new Error(`header #${header.id} is not posted (status ${header.status}) — nothing to pull back`);
  }

  // 1. The entry as QuickBooks holds it now.
  const found = await qbQueryAll<QbJournalEntryRow>(entity, 'JournalEntry', `WHERE Id = '${qbEntryId}'`);
  const je = found[0];
  if (!je || !je.Id) {
    await insertAudit({
      headerId: header.id,
      mode: 'live',
      entity,
      qbEntryId,
      outcome: 'blocked',
      reason: `unpost refused: QuickBooks has no JournalEntry with Id ${qbEntryId} — local state and the books disagree; review by hand`,
    });
    throw new Error(`QuickBooks has no journal entry with Id ${qbEntryId} for ${entity} — books and local state disagree, review by hand`);
  }

  // 2. The attachments we put on it.
  const detached: string[] = [];
  const detachFailed: string[] = [];
  for (const file of await listAttachedFiles(header.id)) {
    try {
      const rows = await qbQueryAll<QbAttachableRow>(entity, 'Attachable', `WHERE Id = '${file.attachableId}'`);
      const syncToken = rows[0]?.SyncToken ?? '0';
      await qbPost<{ Attachable?: { Id?: string; status?: string } }>(
        entity,
        'attachable?operation=delete&minorversion=75',
        { Id: file.attachableId, SyncToken: syncToken } as unknown as JsonValue,
      );
      await insertAudit({
        headerId: header.id,
        mode: 'live',
        entity,
        qbEntryId,
        outcome: 'detached',
        responseBody: { fileName: file.fileName, attachableId: file.attachableId },
      });
      detached.push(file.attachableId);
    } catch (error) {
      detachFailed.push(file.attachableId);
      await insertAudit({
        headerId: header.id,
        mode: 'live',
        entity,
        qbEntryId,
        outcome: 'detach_failed',
        reason: `${file.fileName} (Attachable ${file.attachableId}): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // 3. The entry itself. If this throws, nothing local has moved.
  await qbPost<{ JournalEntry?: { Id?: string; status?: string } }>(
    entity,
    'journalentry?operation=delete&minorversion=75',
    { Id: je.Id, SyncToken: je.SyncToken ?? '0' } as unknown as JsonValue,
  );

  // 4. Local state, only now.
  await getRdsPool().query(
    `UPDATE accounting.payroll_journal_headers
       SET status = 'needs_review', qb_entry_id = NULL, qb_doc_number = NULL, updated_at = now()
     WHERE id = $1 AND status = 'posted'`,
    [header.id],
  );
  await insertAudit({
    headerId: header.id,
    mode: 'live',
    entity,
    qbDocNumber: je.DocNumber,
    qbEntryId: je.Id,
    outcome: 'unposted',
    reason,
    responseBody: { detached, detachFailed },
  });

  return { qbEntryId: je.Id, qbDocNumber: je.DocNumber ?? null, detached, detachFailed };
}
