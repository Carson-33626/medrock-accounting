/**
 * READ-ONLY — Books Sweep lane L1. Per-employee running balance AND a per-entity, per-month
 * roll-forward (opening + activity = closing, worked backward from today's live QBO balance)
 * on 1215 Employee Advances, FL/TN/TX. Default window 2024-01-01 -> today; pass --since=YYYY-MM-DD
 * to widen it (used once with --since=2020-01-01 --refresh to hunt the pre-2024 opening balance
 * gap — see docs/books-sweep/findings/L1-00-summary.md "Roll-forward" section for the result).
 * Attribution is by regex name-match against a roster of names seen in ADP loan/advance deduction
 * columns (JE lines on 1215 rarely carry a structured Entity ref — the name lives in the free-text
 * memo), falling back to the transaction-level EntityRef (set on Purchase/Bill/Deposit) when no
 * roster name matches the memo. Caches the raw pull as JSON in scratch so re-runs don't re-hit QBO.
 *
 *   npx tsx scripts/payroll/sweep-L1-1215-running-balance.ts [--refresh] [--since=YYYY-MM-DD]
 */
import './load-env-vercel-first';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const SCRATCH = 'C:/Users/Carson.D/AppData/Local/Temp/claude/C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics/6a486b3c-fdc7-4fb1-b5d1-161814adc246/scratchpad/L1';
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// Live balance snapshot from probe-1215-balances.ts, run immediately before this script each time —
// QBO exposes no point-in-time historical balance, so every monthly closing figure below is derived
// by walking this live anchor backward through the ledger, not read from QBO directly.
type ThreeEntity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
const CURRENT_BALANCE: Record<ThreeEntity, number> = { 'MedRock FL': 0.0, 'MedRock TN': 2902.15, 'MedRock TX': -196.4 };

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: QbLineDetail;
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
  DepositLineDetail?: { AccountRef?: { name?: string } };
}
interface QbTxn { Id: string; DocNumber?: string; TxnDate?: string; EntityRef?: { name?: string }; Line?: QbLine[] }

interface LedgerLine {
  entity: Entity; type: string; docNumber: string; date: string; side: 'Dr' | 'Cr'; amount: number;
  payee: string; memo: string;
}

const ROSTER = [
  'Webb', 'Pinchin', 'Denha', 'Dickie', 'Rogelstad', 'Mitchell', 'Pericot', 'Newton',
  'Anguiano', 'Dean', 'Hart', 'Ivey', 'Linares', 'Lowe', 'Mathis', 'Poland', 'Powell', 'Ruiz',
  'Barnes', 'Freebeck', 'Dightman', 'Browne',
];

async function fetchEntity(entity: Entity, since: string): Promise<LedgerLine[]> {
  const TYPES: { type: string; label: string }[] = [
    { type: 'JournalEntry', label: 'JE' },
    { type: 'Purchase', label: 'Purchase' },
    { type: 'Bill', label: 'Bill' },
    { type: 'Deposit', label: 'Deposit' },
    // Rule-2 completeness: also check the txn type most likely to carry a repayment credit or a
    // write-off that wouldn't show as a plain JE/Purchase/Bill/Deposit line. CreditCardCredit was
    // tried too but QBO rejects it against MedRock FL ("invalid context declaration") — dropped
    // rather than burning more rate-limit chasing a company-specific feature-enablement quirk;
    // noted as a completeness gap in the summary.
    { type: 'VendorCredit', label: 'VendorCredit' },
  ];
  const out: LedgerLine[] = [];
  for (const { type, label } of TYPES) {
    const txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '${since}'`);
    for (const t of txns) {
      for (const l of t.Line ?? []) {
        const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
        const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const depAcct = l.DepositLineDetail?.AccountRef?.name;
        const acct = jeAcct ?? expAcct ?? depAcct;
        if (!/^employee advances$/i.test(acct ?? '')) continue;
        // Purchase/Bill expense lines are debits by construction; Deposit lines are credits;
        // VendorCredit expense lines are credits (decrease) by construction — the opposite of
        // Purchase/Bill despite sharing the same AccountBasedExpenseLineDetail shape.
        const side: 'Dr' | 'Cr' = jeAcct !== undefined
          ? (l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr')
          : depAcct !== undefined ? 'Cr'
          : type === 'VendorCredit' ? 'Cr' : 'Dr';
        out.push({
          entity, type: label, docNumber: t.DocNumber ?? `(id ${t.Id})`, date: t.TxnDate ?? '',
          side, amount: l.Amount ?? 0, payee: t.EntityRef?.name ?? '', memo: l.Description ?? '',
        });
      }
    }
  }
  return out;
}

function attribute(line: LedgerLine): string {
  const hit = ROSTER.find((n) => new RegExp(n, 'i').test(line.memo) || new RegExp(n, 'i').test(line.payee));
  if (hit) return hit;
  if (line.payee) return `(payee) ${line.payee}`;
  return '(UNLABELED)';
}

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice('--since='.length) : '2024-01-01';
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
  const all: LedgerLine[] = [];
  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]) {
    const cacheFile = `${SCRATCH}/1215-ledger-${entity.replace(/\s+/g, '_')}-${since}.json`;
    let lines: LedgerLine[];
    if (!refresh && existsSync(cacheFile)) {
      lines = JSON.parse(readFileSync(cacheFile, 'utf8')) as LedgerLine[];
      console.error(`(cache) ${entity}: ${lines.length} lines since ${since}`);
    } else {
      lines = await fetchEntity(entity, since);
      writeFileSync(cacheFile, JSON.stringify(lines, null, 2));
      console.error(`(fetched) ${entity}: ${lines.length} lines since ${since}`);
    }
    all.push(...lines);
  }

  // ---- Roll-forward: opening + activity = closing, per entity per month, worked BACKWARD from
  // today's live QBO balance (QBO exposes no historical point-in-time balance API). ----
  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as ThreeEntity[]) {
    const lines = all.filter((x) => x.entity === entity).sort((a, b) => a.date.localeCompare(b.date));
    const byMonth = new Map<string, number>(); // 'YYYY-MM' -> net Dr-positive activity
    for (const l of lines) {
      const m = l.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + (l.side === 'Dr' ? l.amount : -l.amount));
    }
    const months = [...byMonth.keys()].sort();
    console.log(`\n\n========== ${entity} — 1215 monthly roll-forward (worked backward from live balance) ==========`);
    console.log(`  closing balance TODAY (live QBO): ${money(CURRENT_BALANCE[entity])}`);
    // Walk backward: closing(this month) - activity(this month) = opening(this month) = closing(prior month)
    let closing = CURRENT_BALANCE[entity];
    const rows: { month: string; opening: number; activity: number; closing: number }[] = [];
    for (let i = months.length - 1; i >= 0; i--) {
      const month = months[i];
      const activity = byMonth.get(month) ?? 0;
      const opening = closing - activity;
      rows.push({ month, opening, activity, closing });
      closing = opening;
    }
    rows.reverse();
    for (const r of rows) {
      console.log(`  ${r.month}  opening ${money(r.opening).padStart(12)}  + activity ${money(r.activity).padStart(12)}  = closing ${money(r.closing).padStart(12)}`);
    }
    const earliestMonth = months[0];
    const impliedPreWindowOpening = rows.length > 0 ? rows[0].opening : CURRENT_BALANCE[entity];
    console.log(`  implied opening balance BEFORE ${earliestMonth ?? '(no activity)'} (i.e. before ${since}): ${money(impliedPreWindowOpening)}`);
    if (Math.abs(impliedPreWindowOpening) >= 0.01) {
      console.log(`  ${since === '2024-01-01' ? '*** widen with --since=2020-01-01 --refresh to try to trace this further back ***' : '*** UNRECONCILED: this residual does not explain from data pulled back to ' + since + ' — treat as an opening-balance gap, not zero, until traced to an opening TB or earlier source ***'}`);
    } else {
      console.log('  *** reconciles to $0.00 before the window starts — no further pre-window balance to trace ***');
    }
  }

  for (const entity of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]) {
    console.log(`\n\n========== ${entity} — 1215 running balance by attributed name (2024-01-01 -> today) ==========`);
    const byName = new Map<string, LedgerLine[]>();
    for (const l of all.filter((x) => x.entity === entity).sort((a, b) => a.date.localeCompare(b.date))) {
      const who = attribute(l);
      const arr = byName.get(who) ?? [];
      arr.push(l);
      byName.set(who, arr);
    }
    const rows: { who: string; net: number; count: number; first: string; last: string }[] = [];
    for (const [who, lines] of byName) {
      const net = lines.reduce((s, l) => s + (l.side === 'Dr' ? l.amount : -l.amount), 0);
      rows.push({ who, net, count: lines.length, first: lines[0]?.date ?? '', last: lines[lines.length - 1]?.date ?? '' });
    }
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    for (const r of rows) {
      const flag = Math.abs(r.net) >= 0.01 ? '  <-- NON-ZERO' : '';
      console.log(`  ${r.who.padEnd(28)} net ${money(r.net).padStart(12)}  (${r.count} lines, ${r.first}..${r.last})${flag}`);
    }
    const total = rows.reduce((s, r) => s + r.net, 0);
    console.log(`  ${'TOTAL (since 2024-01-01, excludes any pre-2024 opening balance)'.padEnd(28)} net ${money(total).padStart(12)}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
