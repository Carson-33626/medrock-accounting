/**
 * Draft a month-end allocation CORRECTION for one entity (DS 2026-09-25 §4.2): the month's
 * allocation as generated now, minus everything posted (parent + posted corrections).
 * Always recomputed fresh — never from the stored daily check.
 */
import { createHash } from 'node:crypto';
import { getRdsPool } from '../rds';
import { computeEomTarget } from './eom-target';
import { listEomHeaders, listEomCorrectionHeaders } from './eom-store';
import {
  remainderLines, deltaDebits, eomCorrectionSegment, eomCorrectionIndex, eomCorrectionDocNumber, eomCorrectionNote, DELTA_MEMO,
} from './eom-correction';
import { saveDraft, insertAudit, loadDraft } from './store';
import { fetchDimensions } from './qb-journal';
import { monthEndAdp, monthEndIso, type Month } from './month';
import type { EomEntity } from './revenue-rule';
import type { JournalDraft, JournalLine } from './types';

async function deleteDraft(id: number): Promise<void> {
  await getRdsPool().query(`DELETE FROM accounting.payroll_journal_lines WHERE header_id = $1`, [id]);
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
  const openDraft = corrections.find((h) => h.status !== 'posted');
  const index = posted.length + 1;

  const target = await computeEomTarget(m);
  if (!target.ok) return { locked: target.error, status: target.status };

  const postedSets: JournalLine[][] = [];
  for (const h of [parent, ...posted]) {
    const loaded = await loadDraft(h.id);
    if (loaded) postedSets.push(loaded.lines);
  }
  const targetLines = target.drafts.find((d) => d.entity === entity)?.lines ?? [];
  const lines = remainderLines(targetLines, postedSets, DELTA_MEMO);

  if (lines.length === 0) {
    if (openDraft) await deleteDraft(openDraft.id);
    return { nothingToCorrect: true };
  }
  if (openDraft && eomCorrectionIndex(openDraft.period_segment) !== index) await deleteDraft(openDraft.id);

  const total = deltaDebits(lines);
  const docNumber = eomCorrectionDocNumber(entity, m, index);
  const draft: JournalDraft = {
    entity, kind: 'allocation', payDate: monthEndAdp(m), payGroup: 'EOM',
    periodStart: `${String(m.month).padStart(2, '0')}/01/${m.year}`, periodEnd: monthEndAdp(m),
    periodSegment: eomCorrectionSegment(index), docNumber, txnDate: monthEndIso(m),
    privateNote: eomCorrectionNote(entity, m, index, todayIso),
    lines, totalDebits: total, totalCredits: total, variance: 0, rowKeys: [],
  };
  const hash = createHash('sha256').update(JSON.stringify({ correctionOf: parent.qb_doc_number, index, lines })).digest('hex');
  const headerId = await saveDraft(draft, hash);
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
