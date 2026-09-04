/** READ-ONLY: why is Shipping labor carrying an Allocate flag?
 *
 *  probe-cs-allocation-basis.ts found Shipping wages/OT/401k/taxes/WC inside the March
 *  `Allocate - %` pool, yet NO employee-map row sits in the SHIP cost center (bucketed by
 *  each person's LATEST home_department). Carson: shipping is location-owned labor and
 *  should never be split. Hypothesis: a tagged person's home_department DRIFTED between
 *  the month being allocated and today, so the tag follows the person while the memo
 *  follows the department they were in that month.
 *
 *  [1] every Allocate-flagged position, with its department AS OF the target month vs today
 *  [2] the month's Shipping-memo Allocate lines, and what they total
 *  [3] department drift across 2026 for the flagged cohort
 *
 *  No writes. Untracked scratch.
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import { costCenterFor } from '../../src/lib/payroll/cost-center';

interface FlaggedRow {
  entity: string;
  position_id: string;
  class_name: string | null;
  department_name: string | null;
  dept_in_month: string | null;
  dept_today: string | null;
  name: string | null;
}
interface LineRow {
  entity: string;
  account_name: string;
  memo: string | null;
  posting_type: string;
  total: string;
}
interface DriftRow {
  position_id: string;
  name: string;
  depts: string;
}

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '2026-03';
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(arg);
  if (!match) {
    console.error('usage: npx tsx scripts/payroll/probe-shipping-in-pool.ts YYYY-MM');
    process.exit(1);
  }
  const year = Number(match[1]);
  const mm = match[2];
  const pool = getRdsPool();

  // ── [1] flagged positions: department in the target month vs today ──────────
  const flagged = await pool.query<FlaggedRow>(
    `SELECT m.entity, m.position_id, m.class_name, m.department_name,
            (SELECT h.home_department FROM source.payroll_history h
              WHERE h.position_id = m.position_id
                AND to_date(h.pay_date, 'MM/DD/YYYY')
                    BETWEEN DATE '${year}-${mm}-01'
                        AND (DATE '${year}-${mm}-01' + INTERVAL '1 month - 1 day')
              ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC LIMIT 1) AS dept_in_month,
            (SELECT h.home_department FROM source.payroll_history h
              WHERE h.position_id = m.position_id
              ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC LIMIT 1) AS dept_today,
            (SELECT h.name FROM source.payroll_history h
              WHERE h.position_id = m.position_id
              ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC LIMIT 1) AS name
       FROM accounting.payroll_employee_map m
      WHERE m.class_name LIKE 'Allocate%' OR m.department_name = '% Allocation'
      ORDER BY m.entity, m.position_id`,
  );
  console.log(`\n=== [1] Allocate-flagged positions: dept in ${arg} vs today ===`);
  let drifted = 0;
  for (const r of flagged.rows) {
    const ccMonth = costCenterFor(r.dept_in_month);
    const ccToday = costCenterFor(r.dept_today);
    const flag = ccMonth !== ccToday ? '  <-- DRIFTED' : '';
    if (ccMonth !== ccToday) drifted++;
    const paidThisMonth = r.dept_in_month === null ? '  (no pay this month)' : '';
    console.log(
      `  ${r.entity.padEnd(12)} ${r.position_id} ${(r.name ?? '').padEnd(32)} ` +
      `${arg}=${ccMonth.padEnd(7)} today=${ccToday.padEnd(7)} class=${r.class_name ?? `(dept ${r.department_name})`}${flag}${paidThisMonth}`,
    );
  }
  console.log(`  >>> ${drifted} of ${flagged.rows.length} flagged positions changed cost center since ${arg}`);

  const shipMonth = flagged.rows.filter((r) => costCenterFor(r.dept_in_month) === 'SHIP');
  console.log(`\n  >>> flagged positions sitting in SHIP during ${arg}: ${shipMonth.length}`);
  for (const r of shipMonth) {
    console.log(`      ${r.entity} ${r.position_id} ${r.name} | dept_in_month=${r.dept_in_month} | class=${r.class_name ?? `(dept ${r.department_name})`}`);
  }

  // ── [2] the month's Shipping-memo Allocate lines ────────────────────────────
  const lines = await pool.query<LineRow>(
    `SELECT h.entity, l.account_name, l.memo, l.posting_type, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.kind <> 'allocation'
        AND to_date(h.pay_date, 'MM/DD/YYYY') BETWEEN DATE '${year}-${mm}-01'
            AND (DATE '${year}-${mm}-01' + INTERVAL '1 month - 1 day')
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
        AND l.memo ILIKE '%Shipping%'
      GROUP BY h.entity, l.account_name, l.memo, l.posting_type
      ORDER BY h.entity, l.account_name, l.memo`,
  );
  console.log(`\n=== [2] ${arg} Allocate-flagged lines with a Shipping memo: ${lines.rows.length} groups ===`);
  let shipTotal = 0;
  for (const r of lines.rows) {
    const amt = Number(r.total);
    shipTotal += r.posting_type === 'Credit' ? -amt : amt;
    console.log(`  ${r.entity.padEnd(12)} ${r.posting_type.padEnd(6)} ${money(amt).padStart(12)}  ${r.account_name}  | ${r.memo ?? ''}`);
  }
  console.log(`  >>> net shipping labor being split: ${money(shipTotal)}`);
  console.log(`      at 1/3 each, the two non-employing entities absorb ${money((shipTotal * 2) / 3)}`);

  // ── [3] department drift across 2026 for the flagged cohort ─────────────────
  const ids = flagged.rows.map((r) => r.position_id);
  const drift = await pool.query<DriftRow>(
    `SELECT position_id, MAX(name) AS name,
            string_agg(DISTINCT home_department, ' | ' ORDER BY home_department) AS depts
       FROM source.payroll_history
      WHERE position_id = ANY($1) AND pay_date LIKE '%/${year}'
      GROUP BY position_id
     HAVING COUNT(DISTINCT home_department) > 1
      ORDER BY position_id`,
    [ids],
  );
  console.log(`\n=== [3] flagged positions with MORE THAN ONE home_department in ${year}: ${drift.rows.length} ===`);
  for (const r of drift.rows) console.log(`  ${r.position_id} ${r.name}: ${r.depts}`);

  await pool.end();
  process.exit(0);
}

void main();
