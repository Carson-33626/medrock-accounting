// web/scripts/payroll/regen-drafts.ts
// Regenerate persisted payroll drafts for a date range, applying the month-split.
// Mirrors POST /api/payroll/runs exactly. Writes DRAFTS ONLY — never QuickBooks.
// Usage: npx tsx scripts/payroll/regen-drafts.ts 2026-01-01 2026-12-31
import '../lib/load-env';
import { selectSource } from '../../src/lib/payroll/source-select';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { splitStraddle } from '../../src/lib/payroll/split';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import {
  getAccountMap, getEmployeeMap, saveDraft, sourceSnapshotHash, deleteStaleSiblings,
} from '../../src/lib/payroll/store';
import type { AccountMapRule, EmployeeMapRule } from '../../src/lib/payroll/types';

async function main(): Promise<void> {
  const [start, end] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) {
    console.error('usage: tsx scripts/payroll/regen-drafts.ts <start YYYY-MM-DD> <end YYYY-MM-DD>');
    process.exit(1);
  }
  const rows = await selectSource().fetchRange(start, end);
  const snapshot = sourceSnapshotHash(rows);
  const accountMapLists: AccountMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getAccountMap));
  const employeeMapLists: EmployeeMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getEmployeeMap));
  const { drafts } = buildJournal(rows, accountMapLists.flat(), employeeMapLists.flat());

  let splitRuns = 0;
  // One bad run must not abort the batch. This used to throw out of the loop mid-write, leaving
  // part of a year regenerated and the rest stale — a far worse state than a single skipped run,
  // and hard to notice because the process simply exited. Failures are collected and reported at
  // the end so they are impossible to miss.
  const failures: Array<{ entity: string; payDate: string; payGroup: string; reason: string }> = [];
  for (const draft of drafts) {
    try {
      const pieces = splitStraddle(draft);
      if (pieces.length > 1) splitRuns += 1;
      for (const piece of pieces) {
        const id = await saveDraft(piece, snapshot);
        console.log(
          `saved #${id} ${piece.entity} ${piece.payDate} ${piece.payGroup || '(no group)'}` +
          `${piece.periodSegment ? ` [${piece.periodSegment} ${piece.docNumber} @ ${piece.txnDate}]` : ''}` +
          ` D=${piece.totalDebits} C=${piece.totalCredits}`,
        );
      }
      const removed = await deleteStaleSiblings(
        draft.entity, draft.payDate, draft.payGroup, pieces.map((p) => p.periodSegment ?? ''),
      );
      if (removed > 0) console.log(`  cleaned ${removed} stale sibling header(s)`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.push({ entity: draft.entity, payDate: draft.payDate, payGroup: draft.payGroup, reason });
      console.log(`  SKIPPED ${draft.entity} ${draft.payDate} ${draft.payGroup || '(no group)'}: ${reason}`);
    }
  }
  console.log(`\n${drafts.length} run(s) processed, ${splitRuns} split into month pieces.`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} run(s) FAILED and were left as-is:`);
    for (const f of failures) console.log(`  ${f.entity} ${f.payDate} ${f.payGroup || '(no group)'} — ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
