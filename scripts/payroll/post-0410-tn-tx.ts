/**
 * ONE-OFF (Barbara via Carson, 2026-08-19): live-post the 04/10/2026 payroll JEs for the
 * remaining two of the three locations. FL's pieces (PR 2026.04.10A/B → QB 53227/53228)
 * are already live; this posts TN (#1450/#1451) and TX (#651/#652). FOCAS is skipped —
 * non-postable by design (empty account map).
 *
 * Mirrors POST /api/payroll/post EXACTLY (same gates: decrypt key, no-double-post,
 * split-pair approval atomicity, reconcile postability over the COMBINED run, source
 * drift hash, full audit trail). The only addition: headers still at needs_review are
 * approved first — the same state transition the Approve button performs.
 *
 *   npx tsx scripts/payroll/post-0410-tn-tx.ts --live
 *   (without --live every header runs mode=dry_run and nothing posts)
 */
// MUST be the first import: quickbooks-multi captures its OAuth creds into module-level
// constants, and tsx hoists imports above inline statements.
import './load-env-vercel-first';
import { selectSource } from '../../src/lib/payroll/source-select';
import { reconcile } from '../../src/lib/payroll/reconcile';
import { postJournalEntry } from '../../src/lib/payroll/qb-journal';
import { buildJournal } from '../../src/lib/payroll/build-je';
import {
  loadDraft, insertAudit, setHeaderStatus, listSiblings, getAccountMap, getEmployeeMap, sourceSnapshotHash,
} from '../../src/lib/payroll/store';
import { decidePost } from '../../src/lib/payroll/post-guard';
import { adpDateToIso } from '../../src/lib/payroll/dates';
import { pieceDocNumber } from '../../src/lib/payroll/split';
import type { JournalDraft, JournalLine } from '../../src/lib/payroll/types';
import type { JsonValue } from '../../src/lib/payroll/store';

const HEADER_IDS = [1450, 1451, 651, 652]; // TN A, TN B, TX A, TX B
const live = process.argv.includes('--live');
const mode: 'dry_run' | 'live' = live ? 'live' : 'dry_run';
const round2 = (n: number): number => Math.round(n * 100) / 100;

async function postHeader(headerId: number): Promise<void> {
  const loaded = await loadDraft(headerId);
  if (!loaded) throw new Error(`header ${headerId} not found`);
  const { header, lines } = loaded;

  const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
  const isSplit = siblings.length > 1;
  const segmentIndex = Math.max(0, siblings.findIndex((s) => s.id === headerId));
  const doc = isSplit ? pieceDocNumber(header.pay_date, siblings.length, segmentIndex) : `PR ${header.pay_date}`;
  console.log(`\n== #${headerId} ${header.entity} ${doc} (txn ${header.txn_date}, status ${header.status}) ==`);

  if (header.qb_entry_id || header.status === 'posted') {
    console.log(`   SKIP: already posted (qbId ${header.qb_entry_id ?? '?'})`);
    return;
  }

  const hasKey = !!process.env.PAYROLL_ENC_KEY;
  if (mode === 'live' && !hasKey) throw new Error('decrypt key not configured for live post');

  // Pair-atomicity: refuse to live-post one half of a split unless every sibling is
  // approved or posted (identical to the route).
  if (mode === 'live' && isSplit) {
    const fresh = await listSiblings(header.entity, header.pay_date, header.pay_group);
    const unapproved = fresh.filter((s) => s.id !== headerId && s.status !== 'approved' && s.status !== 'posted');
    if (unapproved.length > 0) {
      await insertAudit({ headerId, mode, entity: header.entity, outcome: 'blocked', reason: 'split sibling not approved' });
      throw new Error(`split sibling not approved for #${headerId}`);
    }
  }

  const draft: JournalDraft = {
    entity: header.entity,
    payDate: header.pay_date,
    payGroup: header.pay_group,
    periodStart: header.period_start ?? '',
    periodEnd: header.period_end ?? '',
    lines,
    totalDebits: header.total_debits,
    totalCredits: header.total_credits,
    variance: header.variance,
    rowKeys: [...new Set(lines.flatMap((l) => l.sourceRowKeys))],
    ...(isSplit
      ? {
          kind: 'pay_date' as const,
          periodSegment: header.period_segment,
          docNumber: pieceDocNumber(header.pay_date, siblings.length, segmentIndex),
          txnDate: header.txn_date ?? undefined,
          privateNote: `Split ${segmentIndex + 1}/${siblings.length} of ${pieceDocNumber(header.pay_date, 1, 0)} — period ${header.period_start ?? ''}–${header.period_end ?? ''}`,
        }
      : {}),
  };

  const dayIso = adpDateToIso(header.pay_date);
  const dayRows = await selectSource().fetchRange(dayIso, dayIso);
  const runRows = dayRows.filter((r) => r.pay_group === header.pay_group);

  const [accountMap, employeeMap] = await Promise.all([getAccountMap(header.entity), getEmployeeMap(header.entity)]);
  const built = buildJournal(runRows, accountMap, employeeMap);

  let reconcileLines: JournalLine[] = lines;
  let reconcileTotals = { totalDebits: header.total_debits, totalCredits: header.total_credits, variance: header.variance };
  if (isSplit) {
    const loads = await Promise.all(
      siblings.map((s) => (s.id === headerId ? Promise.resolve({ header, lines }) : loadDraft(s.id))),
    );
    reconcileLines = loads.flatMap((l) => l?.lines ?? []);
    const d = round2(reconcileLines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const c = round2(reconcileLines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    reconcileTotals = { totalDebits: d, totalCredits: c, variance: round2(d - c) };
  }

  const reconcileDraft: JournalDraft = {
    entity: header.entity,
    payDate: header.pay_date,
    payGroup: header.pay_group,
    periodStart: header.period_start ?? '',
    periodEnd: header.period_end ?? '',
    lines: reconcileLines,
    ...reconcileTotals,
    rowKeys: [...new Set(reconcileLines.flatMap((l) => l.sourceRowKeys))],
  };

  const reconcileResult = reconcile(reconcileDraft, runRows, {
    unmappedColumns: built.unmappedColumns,
    unmappedPositions: built.unmappedPositions,
  });

  const currentHash = sourceSnapshotHash(runRows);
  const hasDrift = !!header.source_snapshot_hash && currentHash !== header.source_snapshot_hash;

  const decision = decidePost({ mode, reconcile: reconcileResult, headerStatus: header.status, hasKey, hasDrift });
  if (!decision.allowed) {
    if (mode === 'live') {
      await insertAudit({ headerId, mode, entity: header.entity, outcome: 'blocked', reason: decision.error ?? 'not postable' });
    }
    throw new Error(`#${headerId} blocked: ${decision.error ?? 'not postable'} (postable=${reconcileResult.postable})`);
  }

  const result = await postJournalEntry(header.entity, draft, { mode });

  await insertAudit({
    headerId,
    mode,
    entity: header.entity,
    qbDocNumber: result.qbDocNumber,
    qbEntryId: result.qbEntryId,
    outcome: mode === 'dry_run' ? 'preview' : 'posted',
    requestPayload: result.payload as unknown as JsonValue,
    responseBody: result.response ?? null,
  });

  if (mode === 'live') {
    await setHeaderStatus(headerId, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    console.log(`   ✅ POSTED: ${result.qbDocNumber} — QB JE Id ${result.qbEntryId}`);
  } else {
    console.log(`   dry-run OK: ${draft.docNumber ?? doc} — ${draft.lines.length} lines, Dr=${header.total_debits} Cr=${header.total_credits}`);
  }
}

async function main(): Promise<void> {
  console.log(`mode=${mode.toUpperCase()} — headers: ${HEADER_IDS.join(', ')}`);
  // Approve-first pass across ALL headers (live only): the pair-atomicity gate requires
  // every split sibling approved before the FIRST piece posts. Same transition the
  // Approve button performs.
  if (mode === 'live') {
    for (const id of HEADER_IDS) {
      const l = await loadDraft(id);
      if (l && l.header.status !== 'approved' && l.header.status !== 'posted') {
        await setHeaderStatus(id, 'approved');
        console.log(`approved #${id} (${l.header.entity}, was ${l.header.status})`);
      }
    }
  }
  for (const id of HEADER_IDS) {
    await postHeader(id);
  }
  console.log('\ndone');
}
void main().then(() => process.exit(0)).catch((e) => { console.error('\nFATAL:', e instanceof Error ? e.message : e); process.exit(1); });
