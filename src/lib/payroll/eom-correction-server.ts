/**
 * Draft a month-end allocation CORRECTION for one entity (DS 2026-09-25 §4.2): the month's
 * allocation as generated now, minus everything posted (parent + posted corrections).
 * Always recomputed fresh — never from the stored daily check.
 */
import { getRdsPool } from '../rds';
import { computeEomTarget } from './eom-target';
import { listEomHeaders, listEomCorrectionHeaders } from './eom-store';
import {
  remainderLines, deltaDebits, eomCorrectionSegment, eomCorrectionIndex, eomCorrectionDocNumber, eomCorrectionNote,
  eomPostedSetFingerprint, DELTA_MEMO,
} from './eom-correction';
import { saveDraft, insertAudit, loadDraft } from './store';
import { fetchDimensions } from './qb-journal';
import { monthEndAdp, monthEndIso, type Month } from './month';
import type { EomEntity } from './revenue-rule';
import type { JournalDraft, JournalLine } from './types';

/** Lines cascade via FK (create_payroll_tables.sql) — only the status-guarded header delete. */
async function deleteDraft(id: number): Promise<void> {
  await getRdsPool().query(`DELETE FROM accounting.payroll_journal_headers WHERE id = $1 AND status <> 'posted'`, [id]);
}

export async function generateEomCorrection(
  month: string, entity: EomEntity, todayIso: string,
): Promise<{ headerId: number; docNumber: string; warnings: string[] } | { nothingToCorrect: true } | { locked: string; status: 409 | 422 | 502 }> {
  const m: Month = { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
  const parent = (await listEomHeaders(m)).find((h) => h.entity === entity);
  if (!parent || parent.status !== 'posted') {
    return { locked: `${entity}: no posted ${month} month-end allocation to correct`, status: 409 };
  }
  const corrections = (await listEomCorrectionHeaders(m)).filter((h) => h.entity === entity);
  const posted = corrections.filter((h) => h.status === 'posted');
  const openDrafts = corrections.filter((h) => h.status !== 'posted');
  // Next index after the HIGHEST posted one — a pulled-back C1 under a posted C2 must not
  // make the next correction collide with C2 (final review I2).
  const index = posted.reduce((max, h) => Math.max(max, eomCorrectionIndex(h.period_segment) ?? 0), 0) + 1;

  const target = await computeEomTarget(m);
  if (!target.ok) return { locked: target.error, status: target.status };

  const postedSets: JournalLine[][] = [];
  for (const h of [parent, ...posted]) {
    const loaded = await loadDraft(h.id);
    // Never silently skip a posted entry — netting without it would re-book its dollars.
    if (!loaded || loaded.lines.length === 0) {
      const doc = h.qb_doc_number ?? `#${h.id}`;
      return { locked: `${entity}: posted entry ${doc} has no stored lines — cannot compute the correction`, status: 409 };
    }
    postedSets.push(loaded.lines);
  }
  const targetLines = target.drafts.find((d) => d.entity === entity)?.lines ?? [];
  const lines = remainderLines(targetLines, postedSets, DELTA_MEMO);

  if (lines.length === 0) {
    for (const d of openDrafts) await deleteDraft(d.id);
    return { nothingToCorrect: true };
  }
  for (const d of openDrafts) if (eomCorrectionIndex(d.period_segment) !== index) await deleteDraft(d.id);

  const total = deltaDebits(lines);
  const docNumber = eomCorrectionDocNumber(entity, m, index);
  const draft: JournalDraft = {
    entity, kind: 'allocation', payDate: monthEndAdp(m), payGroup: 'EOM',
    periodStart: `${String(m.month).padStart(2, '0')}/01/${m.year}`, periodEnd: monthEndAdp(m),
    periodSegment: eomCorrectionSegment(index), docNumber, txnDate: monthEndIso(m),
    privateNote: eomCorrectionNote(entity, m, index, todayIso),
    lines, totalDebits: total, totalCredits: total, variance: 0, rowKeys: [],
  };
  // The header's source_snapshot_hash holds the fingerprint of the posted set this correction
  // was netted against; the post route refuses a live post when it no longer matches (I1).
  const headerId = await saveDraft(draft, eomPostedSetFingerprint([parent, ...posted]));
  if (headerId === parent.id || posted.some((h) => h.id === headerId)) {
    throw new Error(`${entity}: correction C${index} collided with posted entry #${headerId} — nothing was saved`);
  }
  await insertAudit({
    headerId, mode: 'dry_run', entity, outcome: 'generated',
    reason: `correction ${index} to ${parent.qb_doc_number ?? `#${parent.id}`} generated for ${month}`,
  });

  const warnings: string[] = [];
  try {
    const refs = await fetchDimensions(entity);
    for (const l of lines) if (!refs.accounts[l.accountName]) warnings.push(`${entity}: account not found: ${l.accountName}`);
  } catch {
    warnings.push(`${entity}: could not verify accounts (QuickBooks fetch failed)`);
  }
  return { headerId, docNumber, warnings };
}
