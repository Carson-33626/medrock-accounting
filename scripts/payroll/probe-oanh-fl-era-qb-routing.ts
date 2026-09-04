/**
 * READ-ONLY (Carson, 2026-08-25, part 2 of the Oanh Nguyen review): her FL era is
 * 2025-07-18 .. 2026-03-27 — months whose FL payroll JEs were posted to QuickBooks BY HAND
 * (our tool's first live posts were 2026-08-19, and its FL drafts for her era are still
 * needs_review). Question: did those manual FL payroll JEs route her Texas-belonging cost
 * out of Florida — i.e. do they carry `Allocate - TX`-classed lines big enough to include
 * her — or did her cost stay on FL's books?
 *
 * Scans MedRock FL JournalEntries 2025-07-01..2026-03-31, keeps docs that look like payroll
 * (PR-prefixed or payroll-named accounts), and reports per month: total Dr, and the Dr
 * dollars on lines classed 'Allocate - TX', by account. Her per-month loaded cost (from the
 * source rebuild) is printed alongside for comparison.
 *
 *   npx tsx scripts/payroll/probe-oanh-fl-era-qb-routing.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Her fully-loaded Dr cost per month, from probe-oanh-nguyen-posted-impact.ts section 3.
const HER_COST: Record<string, number> = {
  '2025-07': 755.51, '2025-08': 7978.87, '2025-09': 5254.12, '2025-10': 5728.57,
  '2025-11': 8180.26, '2025-12': 5485.78, '2026-01': 8336.41, '2026-02': 8215.50, '2026-03': 5545.22,
};

interface QbJeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; Line?: QbJeLine[] }

async function main(): Promise<void> {
  const jes = await qbQueryAll<QbJe>(
    'MedRock FL', 'JournalEntry', `WHERE TxnDate >= '2025-07-01' AND TxnDate <= '2026-03-31'`,
  );

  const isPayrollJe = (j: QbJe): boolean => {
    const doc = (j.DocNumber ?? '').trim();
    if (/^PR[\s.]/i.test(doc) || /^FL PR/i.test(doc)) return true;
    return (j.Line ?? []).some((l) => /payroll|wages/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
  };

  interface MonthAgg {
    docs: Set<string>;
    totalDr: number;
    allocTxDr: Map<string, number>; // account -> Dr classed Allocate - TX
    allocTxCr: Map<string, number>;
    marketingWagesUnclassedDr: number;
    marketingClasses: Set<string>;
  }
  const byMonth = new Map<string, MonthAgg>();

  for (const j of jes) {
    if (!isPayrollJe(j)) continue;
    const mo = (j.TxnDate ?? '').slice(0, 7);
    if (!mo) continue;
    let m = byMonth.get(mo);
    if (!m) {
      m = { docs: new Set(), totalDr: 0, allocTxDr: new Map(), allocTxCr: new Map(), marketingWagesUnclassedDr: 0, marketingClasses: new Set() };
      byMonth.set(mo, m);
    }
    m.docs.add((j.DocNumber ?? `(id ${j.Id})`).trim());
    for (const l of j.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (!d || typeof l.Amount !== 'number') continue;
      const acct = d.AccountRef?.name ?? '(no account)';
      const cls = (d.ClassRef?.name ?? '').trim();
      if (d.PostingType === 'Debit') m.totalDr += l.Amount;
      if (/allocate\s*-\s*tx/i.test(cls)) {
        const tgt = d.PostingType === 'Debit' ? m.allocTxDr : m.allocTxCr;
        tgt.set(acct, (tgt.get(acct) ?? 0) + l.Amount);
      }
      if (/marketing/i.test(acct)) {
        m.marketingClasses.add(cls === '' ? '(none)' : cls);
        if (cls === '' && d.PostingType === 'Debit') m.marketingWagesUnclassedDr += l.Amount;
      }
    }
  }

  console.log('=== MedRock FL payroll-looking JEs, 2025-07 .. 2026-03 ===');
  for (const [mo, m] of [...byMonth].sort()) {
    const txDr = [...m.allocTxDr.values()].reduce((s, v) => s + v, 0);
    const txCr = [...m.allocTxCr.values()].reduce((s, v) => s + v, 0);
    const hers = HER_COST[mo];
    console.log(`\n  ${mo}: ${m.docs.size} JEs  total Dr ${money(m.totalDr)}  |  'Allocate - TX' classed: Dr ${money(txDr)} Cr ${money(txCr)}  |  her loaded cost ${hers === undefined ? 'n/a' : money(hers)}`);
    console.log(`    docs: ${[...m.docs].sort().join(', ')}`);
    if (m.allocTxDr.size > 0) {
      for (const [acct, v] of [...m.allocTxDr].sort((a, b) => b[1] - a[1])) {
        console.log(`      TX-classed Dr ${money(v).padStart(12)}  ${acct}`);
      }
    } else {
      console.log('      (NO Allocate - TX classed lines in these JEs)');
    }
    console.log(`    marketing-account classes seen: ${[...m.marketingClasses].sort().join(', ') || '(no marketing lines)'}  ·  unclassed marketing Dr ${money(m.marketingWagesUnclassedDr)}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
