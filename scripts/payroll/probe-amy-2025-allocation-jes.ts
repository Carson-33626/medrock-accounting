/** READ-ONLY: what basis did Amy actually use for the 2025 allocation JEs?
 *
 *  Chris (2026-08-24) says Admin AND CS wages were both allocated as a percentage of
 *  revenue, and pointed at a budget-vs-actual screenshot where Amy annotated
 *  `6500.05 Administrative Wages` and `6500.20 Customer Service Wages` with
 *  "% of combined rev for TN and FL". That tells us her STATED basis; it does not prove
 *  the JE arithmetic matched. This pulls the entries themselves.
 *
 *  [1] every 2025 JournalEntry line hitting an Administrative/Customer Service Wages
 *      account, per entity, with DocNumber + memo
 *  [2] the same lines rolled up per (DocNumber, account) so a split is readable at a glance
 *  [3] monthly QB revenue per entity, and what each month's implied revenue shares were
 *  [4] for each candidate allocation JE, the actual per-entity percentages it booked vs
 *      the revenue shares for that month -- the test of whether basis == arithmetic
 *
 *  No writes. Untracked scratch.
 */
import '../lib/load-env';
import { qbQueryAll, getMonthlyProfitAndLoss } from '../../src/lib/quickbooks-multi';
import { EOM_ENTITIES, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { normalizeAccountName, type RawJournalEntry } from '../../src/lib/payroll/qb-pool';

interface FlatLine {
  entity: EomEntity;
  txnId: string;
  docNumber: string;
  txnDate: string;
  account: string;
  posting: 'Debit' | 'Credit';
  amount: number;
  memo: string;
  className: string | null;
  deptName: string | null;
}

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The two accounts Amy annotated, matched loosely so a number prefix or a parent path
 *  ("Payroll Expense -:Administrative Wages") still hits. */
const WAGE_RE = /(administrative wages|customer service wages|6500\.05|6500\.20)/i;

async function main(): Promise<void> {
  const year = Number(process.argv[2] ?? '2025');
  const where = `WHERE TxnDate >= '${year}-01-01' AND TxnDate <= '${year}-12-31'`;

  // ── [1] pull every JE line on those accounts ────────────────────────────────
  const lines: FlatLine[] = [];
  for (const entity of EOM_ENTITIES) {
    let jes: RawJournalEntry[];
    try {
      jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
    } catch (err) {
      console.log(`  !! ${entity}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const je of jes) {
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const acct = d?.AccountRef?.name;
        if (!acct || !WAGE_RE.test(acct)) continue;
        lines.push({
          entity,
          txnId: je.Id,
          docNumber: je.DocNumber ?? '(no doc#)',
          txnDate: je.TxnDate ?? '',
          account: normalizeAccountName(acct),
          posting: d?.PostingType === 'Credit' ? 'Credit' : 'Debit',
          amount: l.Amount ?? 0,
          memo: l.Description ?? '',
          className: d?.ClassRef?.name ?? null,
          deptName: d?.DepartmentRef?.name ?? null,
        });
      }
    }
    console.log(`  ${entity}: ${jes.length} JEs scanned`);
  }
  console.log(`\n=== [1] ${year} JE lines on Admin / CS Wages accounts: ${lines.length} ===`);
  for (const l of lines.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.docNumber.localeCompare(b.docNumber))) {
    console.log(
      `  ${l.txnDate} ${l.entity.padEnd(12)} ${l.docNumber.padEnd(22)} ${l.posting.padEnd(6)} ` +
      `${money(l.amount).padStart(13)}  ${l.account}  | cls=${l.className ?? '-'} dept=${l.deptName ?? '-'} | ${l.memo}`,
    );
  }

  // ── [2] roll up per (month, docNumber, account) ─────────────────────────────
  console.log(`\n=== [2] rolled up per DocNumber ===`);
  const byDoc = new Map<string, FlatLine[]>();
  for (const l of lines) {
    const key = `${l.txnDate.slice(0, 7)}¦${l.docNumber}`;
    byDoc.set(key, [...(byDoc.get(key) ?? []), l]);
  }

  // ── [3] monthly revenue + implied shares ────────────────────────────────────
  const revByMonth = new Map<string, Record<EomEntity, number>>();
  for (const entity of EOM_ENTITIES) {
    let rows: Array<{ month: string; revenue: number }>;
    try {
      rows = await getMonthlyProfitAndLoss({
        location: entity, startDate: `${year}-01-01`, endDate: `${year}-12-31`, accounting_method: 'Accrual',
      });
    } catch (err) {
      console.log(`  !! revenue ${entity}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const r of rows) {
      const cur = revByMonth.get(r.month) ?? ({ 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 } as Record<EomEntity, number>);
      cur[entity] = r.revenue;
      revByMonth.set(r.month, cur);
    }
  }
  console.log(`\n=== [3] ${year} monthly revenue and implied shares ===`);
  for (const [month, inc] of [...revByMonth].sort()) {
    const total = EOM_ENTITIES.reduce((s, e) => s + Math.max(0, inc[e]), 0);
    const pct = EOM_ENTITIES.map((e) => `${e.replace('MedRock ', '')} ${total > 0 ? ((Math.max(0, inc[e]) / total) * 100).toFixed(2) : '0.00'}%`).join(' / ');
    console.log(`  ${month}  total ${money(total).padStart(16)}   ${pct}`);
  }

  // ── [4] booked percentages vs revenue shares, per candidate JE ──────────────
  console.log(`\n=== [4] booked split vs revenue share, per DocNumber ===`);
  for (const [key, group] of [...byDoc].sort()) {
    const [month, doc] = key.split('¦');
    // Net cost landing in each entity from this doc (debits positive, credits negative).
    const net = {} as Record<EomEntity, number>;
    for (const e of EOM_ENTITIES) net[e] = 0;
    for (const l of group) net[l.entity] += (l.posting === 'Credit' ? -1 : 1) * l.amount;
    const totalNet = EOM_ENTITIES.reduce((s, e) => s + net[e], 0);
    if (Math.abs(totalNet) < 0.005) continue; // pure reclass within one entity — nothing to compare

    const inc = revByMonth.get(month);
    const revTotal = inc ? EOM_ENTITIES.reduce((s, e) => s + Math.max(0, inc[e]), 0) : 0;
    console.log(`\n  ${month}  ${doc}   net ${money(totalNet)}`);
    for (const e of EOM_ENTITIES) {
      const bookedPct = totalNet !== 0 ? (net[e] / totalNet) * 100 : 0;
      const revPct = inc && revTotal > 0 ? (Math.max(0, inc[e]) / revTotal) * 100 : 0;
      const thirdsGap = Math.abs(bookedPct - 100 / 3);
      const revGap = Math.abs(bookedPct - revPct);
      const verdict = bookedPct === 0 ? '' : revGap < thirdsGap ? '  <- matches REVENUE' : '  <- matches THIRDS';
      console.log(
        `      ${e.padEnd(12)} booked ${money(net[e]).padStart(13)} = ${bookedPct.toFixed(2).padStart(6)}%   ` +
        `revenue ${revPct.toFixed(2).padStart(6)}%   thirds 33.33%${verdict}`,
      );
    }
  }

  process.exit(0);
}

void main();
