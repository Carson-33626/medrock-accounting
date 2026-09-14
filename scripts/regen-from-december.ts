/**
 * Regenerate everything from the 2025-12 year-end correction through the current
 * month, in one run — Carson, 2026-09-14: *"trigger a regeneration for december to
 * current so we don't have to click it each time."*
 *
 * WHAT IT DOES, IN ORDER
 *   1. Gate: refuses to run unless the 2025-12 lot ledger is COUNT-ANCHORED. Until
 *      the loader's anchor start is pinned at 2025-12, December is the unanchored
 *      roll-forward (FL $813,880 / TN $1,449,620 on 2026-09-14) and a correction
 *      drafted from it would raise book and push $2.09M into January — the exact
 *      opposite of the ruling. See ds-year-end-correction-2025-12.md.
 *   2. The one-time correction dated 2025-12-31 (pay_group INV OPEN), FL/TN/TX.
 *   3. The monthly inventory close for every month 2026-01 .. --through (default:
 *      the current month), 'floor' basis — same code path as the Generate button.
 *   4. (Since 2026-09-14 the lab-supplies accrual is pooled INTO each close entry,
 *      so it regenerates with step 3; the retired LAB ACCRUAL drafts are cleared.)
 *
 * SAFETY. Every generator refuses a month with a POSTED entry and reports it as a
 * skip. Everything written is a `needs_review` draft in our own store — nothing
 * reaches QuickBooks. Requires --confirm.
 *
 *   npx tsx scripts/regen-from-december.ts                       (dry run: gate + what would run)
 *   npx tsx scripts/regen-from-december.ts --confirm
 *   npx tsx scripts/regen-from-december.ts --through 2026-08 --confirm
 *   npx tsx scripts/regen-from-december.ts --skip-gate --confirm  (NOT for the first run)
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import {
  CORRECTION_MONTH,
  CUTOVER_MONTH,
  computeOpeningCorrection,
  generateInvCloseDrafts,
  generateOpeningCorrectionDrafts,
  loadStoredDrafts,
  monthEndDate,
} from '../src/lib/inventory/close-server';

interface AnchorRow {
  as_of_month: string;
  location: string;
  anchored: number;
  lots: number;
  ending: number;
  consumed: number;
}

function monthsBetween(from: string, through: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = through.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const usd = (n: number): string => n.toFixed(2).padStart(14);

async function gate(): Promise<boolean> {
  const pool = getRdsPool();
  const { rows } = await pool.query<AnchorRow>(
    `SELECT l.as_of_month, l.location,
            count(*) FILTER (WHERE l.lot_anchored)::int AS anchored,
            count(*)::int AS lots,
            sum(l.remaining_value)::float8 AS ending,
            sum(l.qty_consumed * COALESCE(p.unit_cost, 0))::float8 AS consumed
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month IN ($1, $2) AND COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [CORRECTION_MONTH, CUTOVER_MONTH],
  );
  console.log('Ledger state at the correction month and the first close month:');
  let decemberAnchored = 0;
  for (const r of rows) {
    console.log(
      `  ${r.as_of_month} ${r.location.padEnd(18)} ending ${usd(r.ending)}  consumed ${usd(r.consumed)}  anchored ${String(r.anchored).padStart(5)}/${r.lots}`,
    );
    if (r.as_of_month === CORRECTION_MONTH) decemberAnchored += r.anchored;
  }
  if (decemberAnchored === 0) {
    console.log(
      `\nGATE CLOSED: ${CORRECTION_MONTH} has no anchored lots — the loader's anchor start is not yet ` +
        'pinned at 2025-12 (or the run has not landed). A correction drafted now would be wrong. ' +
        'Nothing generated.',
    );
    return false;
  }
  console.log(`\nGATE OPEN: ${CORRECTION_MONTH} carries ${decemberAnchored} anchored lots.`);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const skipGate = args.includes('--skip-gate');
  const throughIdx = args.indexOf('--through');
  const through =
    throughIdx >= 0 && /^\d{4}-\d{2}$/.test(args[throughIdx + 1] ?? '')
      ? args[throughIdx + 1]
      : new Date().toISOString().slice(0, 7);
  const months = monthsBetween(CUTOVER_MONTH, through);

  const open = skipGate ? true : await gate();
  if (!open) {
    process.exit(2);
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Would generate:\n  ${CORRECTION_MONTH} correction (dated ${CORRECTION_MONTH}-31)`);
    for (const month of months) {
      const monthEnd = monthEndDate(month);
      const stored = monthEnd ? await loadStoredDrafts(monthEnd) : { headers: [] };
      console.log(`  ${month}  close incl. lab supplies (currently ${stored.headers.length} header(s))`);
    }
    console.log('\nRe-run with --confirm.');
    return;
  }

  // 2. The year-end correction.
  console.log(`\n== ${CORRECTION_MONTH} correction ==`);
  const corr = await generateOpeningCorrectionDrafts();
  if ('locked' in corr) {
    console.log(`  SKIPPED — ${corr.locked}`);
  } else {
    console.log(`  generated ${corr.savedEntities.length} entities: ${corr.savedEntities.join(', ')}`);
    for (const w of corr.warnings) console.log(`    warning: ${w}`);
    const view = await computeOpeningCorrection();
    for (const loc of view.locations) {
      console.log(`  ${loc.location.padEnd(18)} net ${usd(loc.netAdjustment)}  book ${loc.bookAvailable ? 'ok' : 'UNAVAILABLE'}  offset ${loc.offsetFound ? 'ok' : 'MISSING'}`);
      for (const row of loc.rows) {
        console.log(`      ${(row.qbCategory ?? row.account).padEnd(34)} book ${usd(row.book)} fifo ${usd(row.fifo)} adj ${usd(row.adjustment)}`);
      }
    }
  }

  // 3. Monthly closes (lab supplies pooled inside), in month order.
  for (const month of months) {
    const monthEnd = monthEndDate(month);
    if (!monthEnd) continue;
    console.log(`\n== ${month} close ==`);
    const result = await generateInvCloseDrafts(month, 'floor', monthEnd);
    if ('locked' in result) {
      console.log(`  SKIPPED — ${result.locked}`);
    } else {
      console.log(`  regenerated ${result.savedEntities.length} entities`);
      for (const w of result.warnings) console.log(`    warning: ${w}`);
      const stored = await loadStoredDrafts(monthEnd);
      for (const h of stored.headers) {
        console.log(`    ${h.entity.padEnd(12)} #${h.id}  Dr ${usd(Number(h.total_debits))}  var ${Number(h.variance).toFixed(2)}`);
      }
    }

  }

  // The lab-supplies accrual is pooled INTO the close entry since 2026-09-14, so the
  // separate LAB ACCRUAL drafts (accrual + reversal pairs) are obsolete. None ever
  // posted; unposted ones are cleared so nobody approves a duplicate of what the
  // close entry now carries. Posted rows are never touched.
  const { rowCount } = await getRdsPool().query(
    `DELETE FROM accounting.payroll_journal_headers WHERE pay_group = 'LAB ACCRUAL' AND status <> 'posted'`,
  );
  console.log(`\n== retired LAB ACCRUAL drafts ==\n  removed ${rowCount ?? 0} unposted header(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
