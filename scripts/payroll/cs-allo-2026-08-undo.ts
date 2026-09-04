/**
 * ONE-OFF (Carson, 2026-08-25): UNDO the August CS catch-up allocation. The
 * `<ST> CS Allo 2026.08` trio was posted 2026-08-25 month-to-date (QB FL 53419 /
 * TN 20696 / TX 1923, Dr $10,621.97 / $10,004.85 / $5,581.74) — August isn't over,
 * so instead of carrying a mid-month entry plus a `-2` top-up, kill it now and let
 * the month-end re-run of cs-catchup-allocation.ts --live build the full month as
 * a single clean entry.
 *
 * What --live does, per entity:
 *   1. Deletes the QB journal entry (operation=delete, same as the March kill).
 *   2. Flips the local header posted -> needs_review and CLEARS qb_entry_id /
 *      qb_doc_number (setHeaderStatus COALESCEs, so this is direct SQL). With no
 *      'posted' CS ALLO header for August, listPostedCsAlloHeaders returns nothing:
 *      the EOM hard rule stops excluding CS for August, and the next catch-up run
 *      computes a full-month remainder and upserts onto these same header rows
 *      (saveDraft conflict key entity+pay_date+pay_group+segment) with no suffix.
 *   3. Writes a payroll_post_audit row (outcome 'unposted') so the trail shows the
 *      deletion, not a vanished post.
 *
 *   npx tsx scripts/payroll/cs-allo-2026-08-undo.ts          (dry-run: show the kill list)
 *   npx tsx scripts/payroll/cs-allo-2026-08-undo.ts --live   (delete in QB + reset headers)
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { qbPost, qbQueryAll } from '../../src/lib/quickbooks-multi';
import { listPostedCsAlloHeaders } from '../../src/lib/payroll/eom-store';
import { insertAudit, type JsonValue, type PayrollHeader } from '../../src/lib/payroll/store';
import type { Entity } from '../../src/lib/payroll/types';
import type { Month } from '../../src/lib/payroll/month';

const AUGUST: Month = { year: 2026, month: 8 };
const SHORT: Partial<Record<Entity, string>> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const live = process.argv.includes('--live');
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbJeWithSync {
  Id: string;
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: { Amount?: number; JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit' } }[];
}

interface UndoTarget {
  header: PayrollHeader;
  je: QbJeWithSync;
}

async function findTargets(): Promise<UndoTarget[]> {
  const headers = await listPostedCsAlloHeaders(AUGUST);
  if (headers.length === 0) {
    console.log('No posted CS ALLO headers for 2026-08 — nothing to undo.');
    return [];
  }
  const targets: UndoTarget[] = [];
  for (const h of headers) {
    const expectDoc = h.qb_doc_number ?? `${SHORT[h.entity]} CS Allo 2026.08`;
    const jes = await qbQueryAll<QbJeWithSync>(h.entity, 'JournalEntry', `WHERE DocNumber LIKE '%CS Allo 2026.08%'`);
    const hit = jes.find((j) => (j.DocNumber ?? '').trim() === expectDoc);
    if (!hit) {
      throw new Error(`${h.entity}: header #${h.id} says '${expectDoc}' is posted (QB Id ${h.qb_entry_id ?? '?'}) but QB has no JE with that DocNumber — books and local state disagree. Stop and review.`);
    }
    if (h.qb_entry_id && h.qb_entry_id !== hit.Id) {
      throw new Error(`${h.entity}: header #${h.id} stores QB Id ${h.qb_entry_id} but '${expectDoc}' resolved to QB Id ${hit.Id} — stop and review.`);
    }
    const dr = (hit.Line ?? []).reduce(
      (s, l) => s + (l.JournalEntryLineDetail?.PostingType === 'Debit' ? (l.Amount ?? 0) : 0),
      0,
    );
    const drift = Math.abs(dr - h.total_debits) >= 0.005 ? `  ⚠️ header Dr ${money(h.total_debits)}` : '';
    console.log(`  ${h.entity}: header #${h.id} (${h.pay_group}) ↔ QB Id ${hit.Id}  ${hit.DocNumber}  ${hit.TxnDate}  Dr ${money(dr)}  SyncToken=${hit.SyncToken ?? '?'}${drift}`);
    targets.push({ header: h, je: hit });
  }
  return targets;
}

async function undo(targets: UndoTarget[]): Promise<void> {
  for (const { header, je } of targets) {
    const res = await qbPost<{ JournalEntry?: { Id?: string; status?: string } }>(
      header.entity,
      'journalentry?operation=delete&minorversion=75',
      { Id: je.Id, SyncToken: je.SyncToken ?? '0' } as unknown as JsonValue,
    );
    console.log(`  🗑️  DELETED ${header.entity} ${je.DocNumber} (QB Id ${je.Id}) — status=${res.JournalEntry?.status ?? 'Deleted'}`);

    await getRdsPool().query(
      `UPDATE accounting.payroll_journal_headers
       SET status = 'needs_review', qb_entry_id = NULL, qb_doc_number = NULL, updated_at = now()
       WHERE id = $1 AND status = 'posted'`,
      [header.id],
    );
    await insertAudit({
      headerId: header.id,
      mode: 'live',
      entity: header.entity,
      qbDocNumber: je.DocNumber,
      qbEntryId: je.Id,
      outcome: 'unposted',
      reason:
        'August CS Allo undone (Carson 2026-08-25): the 08-25 month-to-date entry is withdrawn; ' +
        'the month-end cs-catchup-allocation.ts --live run will post the full month as one entry.',
    });
    console.log(`  ↩️  header #${header.id} → needs_review, QB refs cleared, audit row written`);
  }
}

async function main(): Promise<void> {
  console.log(`mode=${live ? 'LIVE' : 'DRY-RUN'} — undo the CS Allo 2026.08 trio`);
  const targets = await findTargets();
  if (targets.length === 0) return;
  if (!live) {
    console.log('\nDRY-RUN — nothing deleted. Re-run with --live to delete the QB entries and reset the headers above.');
    return;
  }
  await undo(targets);
  console.log('\nDone. August CS is un-allocated; re-run cs-catchup-allocation.ts --live after the last August payroll posts.');
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
