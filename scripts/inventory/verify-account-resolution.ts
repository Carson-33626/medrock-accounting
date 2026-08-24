/**
 * Read-only proof that every account name the category close would post resolves
 * in QuickBooks.
 *
 * This is the check the pre-existing `'1220 Inventory Asset'` bug would have
 * failed: `buildJePayload` looks each line's `accountName` up in `refs.accounts`
 * (keyed by the Account entity's FullyQualifiedName) and THROWS
 * `unresolved account: <name>` on a miss — at dry-run time as well as post time.
 *
 * Deliberately does NOT generate drafts or run a dry run: both write to the
 * accounting database (drafts rows / an audit row). This asks the same question
 * without any write.
 *
 * Usage: npx tsx --env-file=.env.local scripts/inventory/verify-account-resolution.ts 2026-03
 */
import { computeClose, monthEndDate } from '../../src/lib/inventory/close-server';
import { categoryJournalEntryLinesWithSources } from '../../src/lib/inventory/monthly-close';
import { fetchDimensions } from '../../src/lib/payroll/qb-journal';
import { QB_LOCATIONS, QB_TO_RDS_LOCATION } from '../../src/lib/qb-links';

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const monthEnd = monthEndDate(month);
  if (!monthEnd) throw new Error(`bad month: ${month}`);

  const close = await computeClose(month, 'full', monthEnd);
  let checked = 0;
  let unresolved = 0;

  for (const je of close.categoryJournalEntries) {
    const entity = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === je.location);
    if (entity === undefined) {
      console.log(`${je.location}: no QB entity mapping — skipped`);
      continue;
    }
    const refs = await fetchDimensions(entity);
    const lines = categoryJournalEntryLinesWithSources(je, monthEnd);
    console.log(`\n${je.location} (${entity}) — ${lines.length} lines`);
    for (const l of lines) {
      const id = refs.accounts[l.account];
      checked += 1;
      if (!id) unresolved += 1;
      console.log(
        `  ${id ? 'OK  ' : 'FAIL'} ${String(id ?? 'UNRESOLVED').padStart(10)}  ${l.account}`,
      );
    }
  }

  console.log(`\n=== ${checked} lines checked, ${unresolved} unresolved ===`);
  console.log(unresolved === 0 ? 'PASS — every account resolves' : 'FAIL — see UNRESOLVED above');
}

// Explicit both ways: `void main().then(() => process.exit(0))` turns a throw
// into an unhandled rejection and leaves the exit code to chance, which makes
// this unusable from a check script.
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
