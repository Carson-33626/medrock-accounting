/**
 * READ-ONLY: prove the invented 'Opening Balance' bucket is gone from the close.
 *
 * Calls the real `fetchCategoryLedgerValues` the close uses, not a hand-written
 * twin, so this proves the APP path rather than a query that merely resembles it.
 * Before the switch, Florida 2026-03 carried an 'Opening Balance' cell of
 * $4,212.00 that the close posted as an uncodeable residual against the parent
 * account, with a warning asking the accountant to code stock that has no
 * product record.
 *
 * Run from web/:  npx tsx scripts/_probe-residual-gone.ts [YYYY-MM]
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import { fetchCategoryLedgerValues } from '../src/lib/inventory/ledger-values';
import { accountsForCategory } from '../src/lib/inventory/category-accounts';

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const pool = getRdsPool();
  const cells = await fetchCategoryLedgerValues(pool, month);

  const byLocation = new Map<string, typeof cells>();
  for (const c of cells) {
    const list = byLocation.get(c.location) ?? [];
    list.push(c);
    byLocation.set(c.location, list);
  }

  console.log(`${month} — categories the close sees, and whether each maps to a QB account:\n`);
  let unmapped = 0;
  for (const [location, list] of [...byLocation].sort()) {
    console.log(`  ${location}`);
    for (const c of [...list].sort((a, b) => b.endingValue - a.endingValue)) {
      const acct = accountsForCategory(c.qbCategory);
      const mapped = acct.mapped ? 'ok' : 'UNMAPPED';
      if (!acct.mapped && c.endingValue !== 0) unmapped += 1;
      console.log(
        `    ${c.qbCategory.padEnd(34)} ${('$' + c.endingValue.toLocaleString(undefined, { minimumFractionDigits: 2 })).padStart(16)}  ${mapped}`,
      );
    }
  }
  console.log(
    `\n  non-zero cells with no QB account: ${unmapped}` +
      (unmapped === 0 ? '  <- residual line is gone' : '  <- still producing a residual'),
  );

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
