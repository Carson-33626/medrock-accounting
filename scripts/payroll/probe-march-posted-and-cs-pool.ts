/** READ-ONLY: everything needed before the March kill/regen/repost + CS catch-up.
 *
 *  1. Every posted QB JE Mar-Aug 2026 with an allocation-looking DocNumber, with full line
 *     detail for the March ones (what exactly is coming down).
 *  2. Local kind='allocation' header statuses (which ones our tool thinks are posted).
 *  3. Per month Mar-Aug: the allocation pool under the NEW rules (CS revenue Apr+, admin
 *     thirds, marketing stay-home), split by rule and by source, with the CS (revenue-rule)
 *     lines that the CS-only catch-up would allocate.
 *
 *  No writes. Untracked scratch.
 */
import '../lib/load-env';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { getRdsPool } from '../../src/lib/rds';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue } from '../../src/lib/payroll/revenue-rule';
import { fetchAllocationPool, type RawJournalEntry } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ALLOC_DOC_RE = /(allo|allocation|rev adj)/i;

interface HeaderRow {
  id: number; entity: string; pay_date: string; doc_number: string | null; qb_entry_id: string | null;
  status: string; total_debits: string;
}

async function main(): Promise<void> {
  console.log('=== 1. Posted QB allocation JEs, 2026-03-01..2026-08-31 ===');
  const where = `WHERE TxnDate >= '2026-03-01' AND TxnDate <= '2026-08-31'`;
  for (const entity of EOM_ENTITIES) {
    const jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
    const hits = jes.filter((j) => ALLOC_DOC_RE.test(j.DocNumber ?? ''));
    console.log(`\n  ${entity}: ${hits.length} allocation-looking JEs`);
    for (const j of hits.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
      const dr = (j.Line ?? []).reduce(
        (s, l) => s + (l.JournalEntryLineDetail?.PostingType === 'Debit' ? (l.Amount ?? 0) : 0), 0);
      console.log(`    QB Id ${j.Id}  ${j.TxnDate}  ${j.DocNumber}  Dr ${money(dr)}  (${(j.Line ?? []).length} lines)`);
      if ((j.TxnDate ?? '') < '2026-04-01') {
        for (const l of j.Line ?? []) {
          const d = l.JournalEntryLineDetail;
          if (!d) continue;
          console.log(
            `        ${d.PostingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.Amount ?? 0).padStart(13)}  ` +
            `${d.AccountRef?.name ?? '?'}  [cls=${d.ClassRef?.name ?? '-'} dept=${d.DepartmentRef?.name ?? '-'}]  ${l.Description ?? ''}`);
        }
      }
    }
  }

  console.log('\n=== 2. Local allocation headers (kind=allocation, 2026) ===');
  const rds = getRdsPool();
  const { rows } = await rds.query<HeaderRow>(
    `SELECT id, entity, pay_date, qb_doc_number AS doc_number, qb_entry_id, status, COALESCE(total_debits,0)::text AS total_debits
       FROM accounting.payroll_journal_headers
      WHERE kind = 'allocation' AND pay_date LIKE '%/2026'
      ORDER BY to_date(pay_date, 'MM/DD/YYYY'), entity`);
  for (const r of rows) {
    console.log(`  #${r.id}  ${r.pay_date}  ${r.entity.padEnd(12)} ${(r.doc_number ?? '-').padEnd(22)} qbId=${r.qb_entry_id ?? '-'}  status=${r.status.padEnd(12)} Dr ${money(Number(r.total_debits))}`);
  }

  console.log('\n=== 2b. Unposted payroll drafts with Allocate-tagged lines, txn Mar-Aug (stale-tag risk) ===');
  const stale = await rds.query<{ id: number; entity: string; kind: string; txn_date: string; doc: string | null; n: string; total: string }>(
    `SELECT h.id, h.entity, h.kind, h.txn_date::text AS txn_date, h.qb_doc_number AS doc,
            count(*)::text AS n, COALESCE(sum(l.amount),0)::text AS total
       FROM accounting.payroll_journal_headers h
       JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
      WHERE h.kind IN ('pay_date','accrual','reversal') AND h.status <> 'posted'
        AND h.txn_date >= '2026-03-01' AND h.txn_date <= '2026-08-31'
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
      GROUP BY h.id, h.entity, h.kind, h.txn_date, h.qb_doc_number
      ORDER BY h.txn_date, h.entity`);
  if (stale.rows.length === 0) console.log('  (none — all tagged payroll is posted)');
  for (const r of stale.rows) {
    console.log(`  #${r.id}  ${r.txn_date}  ${r.entity.padEnd(12)} ${r.kind.padEnd(9)} ${(r.doc ?? 'draft').padEnd(22)} ${r.n} tagged lines  ${money(Number(r.total))}`);
  }

  console.log('\n=== 3. Pool under NEW rules, per month ===');
  for (let month = 3; month <= 8; month++) {
    const m = { year: 2026, month };
    const { pool, attention } = await fetchAllocationPool(m);
    const byRule = new Map<string, { n: number; total: number }>();
    for (const l of pool) {
      const cur = byRule.get(l.rule) ?? { n: 0, total: 0 };
      cur.n++; cur.total += l.amount;
      byRule.set(l.rule, cur);
    }
    const presence = await fetchRevenuePresence(m);
    const shares = sharesFromRevenue(presence);
    const shareTxt = shares === null ? 'NO REVENUE' :
      EOM_ENTITIES.map((e) => `${e.replace('MedRock ', '')} ${shares[e].toFixed(2)}%`).join(' / ');
    console.log(`\n  -- 2026-${String(month).padStart(2, '0')}  (revenue shares: ${shareTxt}) --`);
    for (const [k, v] of [...byRule].sort()) console.log(`    rule=${k.padEnd(12)} ${String(v.n).padStart(4)} ln  ${money(v.total).padStart(14)}`);
    console.log(`    attention: ${attention.length} lines`);

    const cs = pool.filter((l) => l.rule === 'revenue');
    const csByKey = new Map<string, number>();
    for (const l of cs) {
      const doc = l.docNumber ?? '-';
      const kind = /^PR /.test(doc) ? 'payroll' : `other(${l.txnType})`;
      const k = `${l.entity} | ${kind}`;
      csByKey.set(k, (csByKey.get(k) ?? 0) + l.amount);
    }
    console.log(`    revenue-rule (CS) lines: ${cs.length}`);
    for (const [k, v] of [...csByKey].sort()) console.log(`      ${k.padEnd(40)} ${money(v).padStart(14)}`);
    const nonPr = cs.filter((l) => !/^PR /.test(l.docNumber ?? ''));
    for (const l of nonPr.slice(0, 12)) {
      console.log(`      ?? non-payroll revenue line: ${l.entity} ${l.txnType} ${l.docNumber ?? '-'} ${money(l.amount)} ${l.accountName} [cls=${l.className ?? '-'} dept=${l.departmentName ?? '-'}]`);
    }
  }

  await rds.end();
  process.exit(0);
}

void main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
