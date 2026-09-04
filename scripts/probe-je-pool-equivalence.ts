/**
 * READ-ONLY: does routing the close through the pool change any number?
 *
 * The acceptance test for `ds-one-inventory-je-2026-09-03.md` build step 2. The
 * restructure is meant to change the SHAPE of the page, not a single posted figure,
 * so this runs the real close for a month and compares the pool's assembled lines
 * against the exact mapping the generator used before — same inputs, both
 * algorithms, line by line.
 *
 * Comparing against the STORED drafts instead would confuse a code regression with
 * ledger drift: the nightly has run since those were generated, so their figures
 * can legitimately differ. Holding the inputs fixed is what isolates the code.
 *
 * Run from web/:  npx tsx scripts/probe-je-pool-equivalence.ts [YYYY-MM]
 */
import './lib/load-env';
import {
  computeClose,
  fifoCategoryContribution,
  monthEndDate,
} from '../src/lib/inventory/close-server';
import { categoryJournalEntryLinesWithSources } from '../src/lib/inventory/monthly-close';
import { assemblePool } from '../src/lib/inventory/je-pool';
import type { JournalLine } from '../src/lib/payroll/types';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The mapping the generator used before the pool — kept here verbatim as the oracle. */
function legacyLines(je: Parameters<typeof categoryJournalEntryLinesWithSources>[0], monthEnd: string): JournalLine[] {
  return categoryJournalEntryLinesWithSources(je, monthEnd).map((l) => ({
    postingType: l.debit !== null ? ('Debit' as const) : ('Credit' as const),
    amount: round2(l.debit ?? l.credit ?? 0),
    accountName: l.account,
    departmentName: null,
    className: null,
    memo: l.memo,
    creditBucket: null,
    origin: 'generated' as const,
    sourceRowKeys: l.receiptIds,
  }));
}

function fingerprint(l: JournalLine): string {
  return [
    l.postingType,
    l.amount.toFixed(2),
    l.accountName,
    l.memo,
    l.departmentName ?? '',
    l.className ?? '',
    l.origin,
    [...l.sourceRowKeys].sort().join(','),
  ].join('|');
}

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const monthEnd = monthEndDate(month);
  if (!monthEnd) throw new Error(`bad month ${month}`);

  const close = await computeClose(month, 'floor', monthEnd);
  if (close.categoryUnavailable !== null) {
    throw new Error(`category detail unavailable: ${close.categoryUnavailable}`);
  }

  let mismatches = 0;
  for (const je of close.categoryJournalEntries) {
    const legacy = je.bookAvailable ? legacyLines(je, monthEnd) : [];
    const pool = assemblePool([fifoCategoryContribution(je, monthEnd)]);

    const a = legacy.map(fingerprint);
    const b = pool.lines.map(fingerprint);
    const same = a.length === b.length && a.every((x, i) => x === b[i]);

    const legacyDr = round2(legacy.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const legacyCr = round2(legacy.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));

    console.log(
      `${je.location.padEnd(20)} bookAvailable=${String(je.bookAvailable).padEnd(5)} ` +
        `lines ${String(legacy.length).padStart(3)} -> ${String(pool.lines.length).padStart(3)}  ` +
        `Dr ${legacyDr.toFixed(2).padStart(12)} -> ${pool.totalDebits.toFixed(2).padStart(12)}  ` +
        `Cr ${legacyCr.toFixed(2).padStart(12)} -> ${pool.totalCredits.toFixed(2).padStart(12)}  ` +
        `${same ? 'IDENTICAL' : 'DIFFERS'}`,
    );

    if (!same) {
      mismatches += 1;
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) console.log(`    [${i}] legacy: ${a[i] ?? '(none)'}\n        pool:   ${b[i] ?? '(none)'}`);
      }
    }
    if (legacyDr !== pool.totalDebits || legacyCr !== pool.totalCredits) {
      mismatches += 1;
      console.log('    TOTALS DIFFER');
    }
  }

  console.log(
    `\n${close.categoryJournalEntries.length} location entr${close.categoryJournalEntries.length === 1 ? 'y' : 'ies'} compared for ${month}: ` +
      `${mismatches === 0 ? 'the pool is byte-identical to the legacy mapping' : `${mismatches} MISMATCH(ES)`}`,
  );
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
