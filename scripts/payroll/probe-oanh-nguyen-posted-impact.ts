/**
 * READ-ONLY (Carson, 2026-08-25): Oanh Nguyen is paid on the FLORIDA payroll but belongs
 * to TEXAS. Review EVERY posted payroll artifact she touched:
 *
 *   1. Identity — her rows in source.payroll_history: position id(s), pay group, department,
 *      location, pay-date span (is ADP itself calling her FL, and since when?).
 *   2. Employee-map rules for her position (any directed Allocate - TX routing already?).
 *   3. Her-only rebuild — run her rows alone through the real buildJournal with the live
 *      account/employee maps: exactly which accounts/departments/classes her dollars hit,
 *      per pay date, and her fully-loaded cost (Dr side).
 *   4. Posted sweep — every POSTED payroll_journal_header whose lines' source_row_keys
 *      include any of her row keys (pay-date JEs, accruals, reversals, allocations alike),
 *      with QB doc numbers.
 *   5. If her cost center pools (e.g. CS), flag the posted CS Allo / EOM interaction.
 *
 *   npx tsx scripts/payroll/probe-oanh-nguyen-posted-impact.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { getAccountMap, getEmployeeMap } from '../../src/lib/payroll/store';
import type { Entity, PayrollRow, SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const sortDate = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
};

const PLAINTEXT_COLS = [
  'position_id', 'name', 'status', 'worker_classification', 'home_department', 'location', 'pay_date',
  'pay_num', 'pay_frequency', 'pay_group', 'pay_type', 'period_start_date', 'period_end_date',
  'processed_as', 'rate_type', 'sui_sdi_tax_code', 'row_key', 'updated_at',
] as const;

interface RawRow extends Record<string, string> { sensitive_encrypted: string }

interface PostedHit {
  header_id: string; entity: Entity; pay_date: string; pay_group: string; kind: string;
  period_segment: string; status: string; qb_doc_number: string | null; qb_entry_id: string | null;
  txn_date: string | null; total_debits: string;
  posting_type: 'Debit' | 'Credit'; amount: string; account_name: string;
  department_name: string | null; class_name: string | null; memo: string | null;
}

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();

  // ---- 1. Identity ---------------------------------------------------------
  const namePattern = `%${process.argv[2] ?? 'oanh'}%`;
  const { rows: raw } = await pool.query<RawRow>(
    `SELECT ${PLAINTEXT_COLS.join(', ')}, sensitive_encrypted
     FROM source.payroll_history
     WHERE name ILIKE $1
     ORDER BY to_date(pay_date, 'MM/DD/YYYY'), pay_group`,
    [namePattern],
  );
  if (raw.length === 0) { console.log(`No source.payroll_history rows match name ILIKE '${namePattern}'.`); return; }

  const rows: PayrollRow[] = raw.map((r) => {
    const base: Record<string, string> = {};
    for (const c of PLAINTEXT_COLS) base[c] = r[c] ?? '';
    const sensitive: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    return { ...(base as unknown as Omit<PayrollRow, 'sensitive'>), sensitive };
  });

  console.log('=== 1. Identity: her rows in source.payroll_history ===');
  const byPosition = new Map<string, PayrollRow[]>();
  for (const r of rows) byPosition.set(r.position_id, [...(byPosition.get(r.position_id) ?? []), r]);
  for (const [pos, prs] of byPosition) {
    const names = [...new Set(prs.map((r) => r.name))];
    const groups = [...new Set(prs.map((r) => r.pay_group))];
    const depts = [...new Set(prs.map((r) => `${r.home_department} (cc=${costCenterFor(r.home_department)})`))];
    const locs = [...new Set(prs.map((r) => r.location))];
    const dates = prs.map((r) => r.pay_date).sort((a, b) => sortDate(a).localeCompare(sortDate(b)));
    console.log(`  position ${pos}: ${names.join(' / ')}`);
    console.log(`    pay groups: ${groups.join(', ')} · ${prs.length} rows · ${dates[0]} .. ${dates[dates.length - 1]}`);
    console.log(`    departments: ${depts.join(' | ')}`);
    console.log(`    locations: ${locs.join(' | ')}`);
    console.log(`    statuses: ${[...new Set(prs.map((r) => r.status))].join(', ')} · processed_as: ${[...new Set(prs.map((r) => r.processed_as))].join(', ')} · sui/sdi: ${[...new Set(prs.map((r) => r.sui_sdi_tax_code))].join(', ')}`);
  }

  // ---- 2. Employee-map rules ----------------------------------------------
  console.log('\n=== 2. Employee-map rules for her position id(s) ===');
  const positions = [...byPosition.keys()];
  const { rows: empRules } = await pool.query<{ id: string; entity: Entity; position_id: string; department_name: string | null; class_name: string | null; cogs_override: boolean | null; active: boolean; reviewed: boolean }>(
    `SELECT id, entity, position_id, department_name, class_name, cogs_override, active, reviewed
     FROM accounting.payroll_employee_map WHERE position_id = ANY($1::text[]) ORDER BY entity`,
    [positions],
  );
  if (empRules.length === 0) console.log('  (no employee-map rules — she books by cost-center defaults)');
  for (const e of empRules) {
    console.log(`  #${e.id} ${e.entity}: dept=${e.department_name ?? '(none)'} class=${e.class_name ?? '(none)'} cogs_override=${String(e.cogs_override)} active=${e.active} reviewed=${e.reviewed}`);
  }

  // ---- 3. Her-only rebuild through the real builder ------------------------
  console.log('\n=== 3. Her dollars through the live builder (per pay date) ===');
  const entities = [...new Set(rows.map((r) => entityForPayGroup(r.pay_group)).filter((e): e is Entity => e !== null))];
  const accountMap = (await Promise.all(entities.map((e) => getAccountMap(e)))).flat();
  const employeeMap = (await Promise.all(entities.map((e) => getEmployeeMap(e)))).flat();
  const { drafts, unmappedColumns } = buildJournal(rows, accountMap, employeeMap);
  let grandDr = 0;
  const monthDr = new Map<string, number>();
  for (const d of drafts.sort((a, b) => sortDate(a.payDate).localeCompare(sortDate(b.payDate)))) {
    console.log(`  ${d.entity}  ${d.payDate}  (${d.payGroup})  Dr ${money(d.totalDebits)} Cr ${money(d.totalCredits)}`);
    for (const l of d.lines) {
      const dims = [l.departmentName, l.className].filter((x): x is string => x !== null && x !== '').join(' / ');
      console.log(`    ${l.postingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.amount).padStart(12)}  ${l.accountName}${dims ? `  [${dims}]` : ''}`);
    }
    grandDr += d.totalDebits;
    const mo = sortDate(d.payDate).slice(0, 7);
    monthDr.set(mo, (monthDr.get(mo) ?? 0) + d.totalDebits);
  }
  console.log(`  ---- her fully-loaded cost, all pay dates: Dr ${money(grandDr)}`);
  for (const [mo, dr] of [...monthDr].sort()) console.log(`       ${mo}: ${money(dr)}`);
  if (unmappedColumns.length > 0) console.log(`  ⚠️ unmapped columns on her rows: ${unmappedColumns.join(', ')}`);

  // ---- 4. Posted sweep by source_row_keys ----------------------------------
  console.log('\n=== 4. POSTED headers whose lines carry her row keys ===');
  const rowKeys = rows.map((r) => r.row_key);
  const { rows: hits } = await pool.query<PostedHit>(
    `SELECT h.id::text AS header_id, h.entity, h.pay_date, h.pay_group, h.kind, h.period_segment,
            h.status, h.qb_doc_number, h.qb_entry_id, to_char(h.txn_date,'YYYY-MM-DD') AS txn_date,
            h.total_debits::text AS total_debits,
            l.posting_type, l.amount::text AS amount, l.account_name, l.department_name, l.class_name, l.memo
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     WHERE h.status = 'posted' AND l.source_row_keys && $1::text[]
     ORDER BY to_date(h.pay_date,'MM/DD/YYYY'), h.entity, h.pay_group, h.period_segment, l.sort_order`,
    [rowKeys],
  );
  if (hits.length === 0) {
    console.log('  (no POSTED journal lines reference her row keys)');
  } else {
    const byHeader = new Map<string, PostedHit[]>();
    for (const hit of hits) byHeader.set(hit.header_id, [...(byHeader.get(hit.header_id) ?? []), hit]);
    console.log(`  ${byHeader.size} posted headers carry her rows (${hits.length} lines total):`);
    for (const [hid, lines] of byHeader) {
      const h = lines[0];
      console.log(`\n  header #${hid}  ${h.entity}  ${h.kind}${h.period_segment ? `/${h.period_segment}` : ''}  pay_date=${h.pay_date}  txn=${h.txn_date ?? '?'}  group=${h.pay_group}`);
      console.log(`    QB: ${h.qb_doc_number ?? '(no doc)'} (entry ${h.qb_entry_id ?? '?'})  header Dr ${money(Number(h.total_debits))}`);
      for (const l of lines) {
        const dims = [l.department_name, l.class_name].filter((x): x is string => x !== null && x !== '').join(' / ');
        console.log(`    ${l.posting_type === 'Debit' ? 'Dr' : 'Cr'} ${money(Number(l.amount)).padStart(12)}  ${l.account_name}${dims ? `  [${dims}]` : ''}  (line includes others too)`);
      }
    }
  }

  // ---- 5. Unposted headers too (context: what's still recallable) ----------
  const { rows: unposted } = await pool.query<{ header_id: string; entity: Entity; pay_date: string; pay_group: string; kind: string; status: string; n: string }>(
    `SELECT h.id::text AS header_id, h.entity, h.pay_date, h.pay_group, h.kind, h.status, count(*)::text AS n
     FROM accounting.payroll_journal_headers h
     JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
     WHERE h.status <> 'posted' AND l.source_row_keys && $1::text[]
     GROUP BY h.id, h.entity, h.pay_date, h.pay_group, h.kind, h.status
     ORDER BY to_date(h.pay_date,'MM/DD/YYYY')`,
    [rowKeys],
  );
  console.log(`\n=== 5. UNPOSTED headers carrying her rows (fixable before posting) — ${unposted.length} ===`);
  for (const u of unposted) {
    console.log(`  header #${u.header_id}  ${u.entity}  ${u.kind}  pay_date=${u.pay_date}  group=${u.pay_group}  status=${u.status}  (${u.n} lines)`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
