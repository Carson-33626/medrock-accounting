// web/scripts/payroll/regen-drafts.ts
// Regenerate persisted payroll drafts for a date range, applying the month-split.
// Mirrors POST /api/payroll/runs exactly. Writes DRAFTS ONLY — never QuickBooks.
// Usage: npx tsx scripts/payroll/regen-drafts.ts 2026-01-01 2026-12-31
import '../ramp-split-push/load-env';
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
  for (const draft of drafts) {
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
  }
  console.log(`\n${drafts.length} run(s) processed, ${splitRuns} split into month pieces.`);
  process.exit(0);
}

void main();
