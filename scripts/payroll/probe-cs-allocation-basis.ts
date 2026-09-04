/** READ-ONLY probe: is Customer Service labor actually in the month-end allocation pool?
 *
 *  Opened 2026-08-24 for the Kristi/Chris allocation revamp (CS labor -> revenue %, all
 *  other shared cost -> 1/3). Memory says the 2026-08-18 seeding tagged 11 ADMIN+ACCOUN
 *  employees `Allocate - %` and nothing else, yet a 7/29 note says "CSR stays in pool" —
 *  those don't agree, and the whole design turns on which is true.
 *
 *  [1] every Allocate-flagged employee-map row, bucketed by cost center
 *  [2] the 2026 CS roster and how much of it is tagged
 *  [3] CS wage dollars in the target month (tagged or not)
 *  [4] pool dollars by rule, from local draft lines (the DB half of fetchAllocationPool)
 *  [5] revenue test: presence shares (today) vs true revenue shares (proposed)
 *
 *  No writes of any kind. Untracked scratch.
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import { costCenterFor, deptLabelFor } from '../../src/lib/payroll/cost-center';
import { fetchRevenuePresence, sharesFromRevenue, EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';

interface EmpMapRow {
  entity: string;
  position_id: string;
  department_name: string | null;
  class_name: string | null;
  active: boolean;
}
interface RosterRow {
  position_id: string;
  name: string;
  home_department: string;
  pay_group: string;
  status: string;
}
interface WageRow {
  entity: string;
  account_name: string;
  posting_type: string;
  lines: string;
  total: string;
}
interface DraftLineRow {
  entity: string;
  class_name: string | null;
  department_name: string | null;
  account_name: string;
  memo: string | null;
  posting_type: string;
  total: string;
}

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '2026-03';
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(arg);
  if (!match) {
    console.error('usage: npx tsx scripts/payroll/probe-cs-allocation-basis.ts YYYY-MM');
    process.exit(1);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const mm = String(month).padStart(2, '0');
  const pool = getRdsPool();

  // ── [1] Allocate-flagged employee-map rows, by cost center ──────────────────
  const flagged = await pool.query<EmpMapRow & { home_department: string | null }>(
    `SELECT m.entity, m.position_id, m.department_name, m.class_name, m.active,
            (SELECT h.home_department FROM source.payroll_history h
              WHERE h.position_id = m.position_id
              ORDER BY to_date(h.pay_date, 'MM/DD/YYYY') DESC LIMIT 1) AS home_department
       FROM accounting.payroll_employee_map m
      WHERE m.class_name LIKE 'Allocate%' OR m.department_name = '% Allocation'
      ORDER BY m.entity, m.position_id`,
  );
  console.log(`\n=== [1] Allocate-flagged employee-map rows: ${flagged.rows.length} ===`);
  const byCc = new Map<string, { tag: string; n: number }[]>();
  for (const r of flagged.rows) {
    const cc = costCenterFor(r.home_department);
    const tag = r.class_name ?? `(dept-only: ${r.department_name})`;
    const arr = byCc.get(cc) ?? [];
    const hit = arr.find((a) => a.tag === tag);
    if (hit) hit.n++;
    else arr.push({ tag, n: 1 });
    byCc.set(cc, arr);
  }
  for (const [cc, tags] of [...byCc].sort()) {
    console.log(`  ${cc.padEnd(7)} (${deptLabelFor(cc) ?? '—'})`);
    for (const t of tags.sort((a, b) => b.n - a.n)) console.log(`      ${String(t.n).padStart(3)} × ${t.tag}`);
  }
  const csFlagged = flagged.rows.filter((r) => costCenterFor(r.home_department) === 'CS');
  console.log(`\n  >>> CS cost-center rows carrying an Allocate flag: ${csFlagged.length}`);
  for (const r of csFlagged) console.log(`      ${r.entity} ${r.position_id} class=${r.class_name} dept=${r.department_name} active=${r.active}`);

  // ── [2] the 2026 CS roster, and how much of it is tagged ────────────────────
  const roster = await pool.query<RosterRow>(
    `SELECT DISTINCT ON (position_id, pay_group) position_id, name, home_department, pay_group, status
       FROM source.payroll_history
      WHERE pay_date LIKE '%/${year}' AND UPPER(home_department) LIKE 'CS%'
      ORDER BY position_id, pay_group, to_date(pay_date, 'MM/DD/YYYY') DESC`,
  );
  const taggedIds = new Set(flagged.rows.map((r) => r.position_id));
  const untagged = roster.rows.filter((r) => !taggedIds.has(r.position_id));
  console.log(`\n=== [2] CS roster ${year}: ${roster.rows.length} position/pay_group rows, ${untagged.length} NOT Allocate-flagged ===`);
  for (const r of roster.rows) {
    console.log(`  ${taggedIds.has(r.position_id) ? 'TAGGED  ' : 'untagged'} ${r.position_id} ${r.name} | ${r.home_department} | ${r.pay_group} | ${r.status}`);
  }

  // ── [3] CS labor dollars in the target month, from the generated JE lines ───
  // source.payroll_history keeps wages in `sensitive_encrypted` (not a plaintext column),
  // so the dollar read comes from the built lines, whose memos carry the DEPT_LABEL 'CSR'.
  const wages = await pool.query<WageRow>(
    `SELECT h.entity, l.account_name, l.posting_type,
            COUNT(*)::text AS lines, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.kind <> 'allocation'
        AND to_date(h.pay_date, 'MM/DD/YYYY') BETWEEN DATE '${year}-${mm}-01'
            AND (DATE '${year}-${mm}-01' + INTERVAL '1 month - 1 day')
        AND l.memo ILIKE '%CSR%'
      GROUP BY h.entity, l.account_name, l.posting_type
      ORDER BY h.entity, l.account_name`,
  );
  console.log(`\n=== [3] ${arg} JE lines memo-tagged CSR: ${wages.rows.length} groups ===`);
  let csDebits = 0;
  for (const r of wages.rows) {
    const amt = Number(r.total);
    if (r.posting_type === 'Debit') csDebits += amt;
    console.log(`  ${r.entity.padEnd(12)} ${r.posting_type.padEnd(6)} ${String(r.lines).padStart(4)} ln  ${money(amt).padStart(14)}  ${r.account_name}`);
  }
  console.log(`  >>> CSR debit total for ${arg}: ${money(csDebits)}`);

  // ── [4] pool dollars from local draft lines (DB half of fetchAllocationPool) ─
  const draft = await pool.query<DraftLineRow>(
    `SELECT h.entity, l.class_name, l.department_name, l.account_name, l.memo, l.posting_type,
            SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.status <> 'posted'
        AND h.kind <> 'allocation'
        AND to_date(h.pay_date, 'MM/DD/YYYY') BETWEEN DATE '${year}-${mm}-01'
            AND (DATE '${year}-${mm}-01' + INTERVAL '1 month - 1 day')
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
      GROUP BY h.entity, l.class_name, l.department_name, l.account_name, l.memo, l.posting_type
      ORDER BY h.entity, l.class_name, l.account_name`,
  );
  console.log(`\n=== [4] unposted draft lines carrying an Allocate flag in ${arg}: ${draft.rows.length} groups ===`);
  const byTag = new Map<string, number>();
  for (const r of draft.rows) {
    const tag = r.class_name ?? `(dept-only: ${r.department_name})`;
    const signed = (r.posting_type === 'Credit' ? -1 : 1) * Number(r.total);
    byTag.set(tag, (byTag.get(tag) ?? 0) + signed);
    const isCsMemo = /CSR/i.test(r.memo ?? '');
    console.log(`  ${r.entity.padEnd(12)} ${tag.padEnd(24)} ${r.posting_type.padEnd(6)} ${money(Number(r.total)).padStart(14)}  ${r.account_name}${isCsMemo ? '   <-- CSR memo' : ''}  | ${r.memo ?? ''}`);
  }
  console.log(`\n  net by tag:`);
  for (const [t, v] of [...byTag].sort()) console.log(`      ${t.padEnd(24)} ${money(v).padStart(14)}`);

  // ── [5] presence shares (today) vs true revenue shares (proposed) ───────────
  console.log(`\n=== [5] revenue test ${arg} ===`);
  try {
    const rev = await fetchRevenuePresence({ year, month });
    const presence = sharesFromRevenue(rev);
    const total = EOM_ENTITIES.reduce((s, e) => s + Math.max(0, rev.income[e]), 0);
    for (const e of EOM_ENTITIES) {
      const nowPct = presence?.[e] ?? 0;
      const newPct = total > 0 ? (Math.max(0, rev.income[e]) / total) * 100 : 0;
      console.log(`  ${e.padEnd(12)} income ${money(rev.income[e]).padStart(16)}   presence ${nowPct.toFixed(2).padStart(6)}%   revenue ${newPct.toFixed(2).padStart(6)}%`);
    }
  } catch (err) {
    console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
  }

  await pool.end();
  process.exit(0);
}

void main();
