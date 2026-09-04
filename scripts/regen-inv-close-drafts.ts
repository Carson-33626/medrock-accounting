/**
 * Regenerate the inventory-close drafts for the months given.
 *
 * CARSON'S STANDING RULE, 2026-09-04: *"Regenerate all of these every time we make
 * changes that would impact these numbers."* So this is the tool for doing that
 * without clicking Generate once per month in the UI — same code path, same gate.
 *
 * WHY IT NEEDS ONE. Stale drafts on screen are worse than no drafts, because Ash
 * and Barbara cannot tell a current figure from an August one. The 2026-01 and
 * 2026-08 drafts sat at the 2026-08-13 vintage for three weeks: two lines each,
 * posting to `1220 Inventory Asset`, which resolves to nothing in QuickBooks and
 * makes them literally unpostable.
 *
 * SAFETY. `generateInvCloseDrafts` refuses any month that already has a POSTED
 * entry and says so; this reports that as a skip rather than forcing past it.
 * Everything it writes is a `needs_review` draft — nothing reaches QuickBooks.
 * It is a write to our own draft store, so it requires --confirm.
 *
 *   npx tsx scripts/regen-inv-close-drafts.ts 2026-01 2026-03 2026-08          (dry run)
 *   npx tsx scripts/regen-inv-close-drafts.ts 2026-01 2026-03 2026-08 --confirm
 */
import './lib/load-env';
import { generateInvCloseDrafts, loadStoredDrafts, monthEndDate } from '../src/lib/inventory/close-server';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const months = args.filter((a) => /^\d{4}-\d{2}$/.test(a));

  if (months.length === 0) {
    console.error('give at least one month as YYYY-MM');
    process.exit(1);
  }

  if (!confirm) {
    console.log('DRY RUN — nothing written. Re-run with --confirm to regenerate.\n');
    console.log(`would regenerate: ${months.join(', ')}`);
    for (const month of months) {
      const monthEnd = monthEndDate(month);
      if (!monthEnd) {
        console.log(`  ${month}  INVALID`);
        continue;
      }
      const stored = await loadStoredDrafts(monthEnd);
      console.log(`  ${month}  currently ${stored.headers.length} stored header(s)`);
    }
    return;
  }

  for (const month of months) {
    const monthEnd = monthEndDate(month);
    if (!monthEnd) {
      console.log(`${month}: INVALID month, skipped`);
      continue;
    }
    // 'floor' is the basis the close runs on; 'full' is the diagnostic alternative.
    const result = await generateInvCloseDrafts(month, 'floor', monthEnd);
    if ('locked' in result) {
      console.log(`${month}: SKIPPED — ${result.locked}`);
      continue;
    }
    console.log(`${month}: regenerated ${result.savedEntities.length} entities`);
    for (const w of result.warnings) console.log(`    warning: ${w}`);

    const stored = await loadStoredDrafts(monthEnd);
    for (const h of stored.headers) {
      console.log(
        `    ${h.entity.padEnd(12)} #${h.id}  Dr ${Number(h.total_debits).toFixed(2).padStart(12)}  ` +
          `var ${Number(h.variance).toFixed(2)}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
