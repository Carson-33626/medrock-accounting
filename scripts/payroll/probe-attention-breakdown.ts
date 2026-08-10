/**
 * READ-ONLY: break the End of Month "Needs attention" list into what actually needs a human and
 * what does not.
 *
 * WHY: Carson, 2026-08-10 — "Needs attention — 86 lines (not in the drafts below) ... this part
 * makes no sense." The card counts EVERY line `fetchAllocationPool` held back from the drafts,
 * but those fall into two completely different categories:
 *
 *   - `passthrough` — an "Allocate - FL/TN/TX" class, meaning 100% of the cost belongs to that one
 *     company. QuickBooks' own Intercompany allocation already booked that move on the transaction
 *     itself, so month-end deliberately skips it. NOTHING TO DO. This is usually most of the list.
 *   - `unknown` — a self-referential class, an item-based line with no expense account, or a class
 *     that matches no split rule. These DO need a fix in QuickBooks.
 *
 * Lumping them under one "needs attention" heading is what makes the panel unreadable. This probe
 * quantifies the split per month so the fix can be aimed at the real number.
 *
 * Prints counts, dollars, classes, accounts and doc numbers. No employee data. No writes.
 *   npx tsx scripts/payroll/probe-attention-breakdown.ts 2026-05 2026-06 2026-07
 */
// MUST be the first import. quickbooks-multi.ts reads QUICKBOOKS_CLIENT_ID/SECRET at MODULE
// scope, and imports are hoisted — a hand-rolled env loader in the script body runs too late, so
// the client id is `undefined` and every token refresh fails `invalid_client`, which reads as a
// broken QuickBooks connection when nothing is wrong with it. This side-effect module also layers
// .env.vercel over .env.local, which matters because .env.local's QB client id is a different
// (localhost) Intuit app from the one that minted the live tokens.
import '../lib/load-env';

import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';
import type { PoolLine } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ITEM_BASED_ACCOUNT = '(item-based line)';

/** Mirrors AttentionCard.attentionReason in EndOfMonthTab.tsx. */
function bucket(l: PoolLine): 'passthrough' | 'item_line' | 'self_class' | 'unrecognized_class' | 'other' {
  if (l.accountName === ITEM_BASED_ACCOUNT) return 'item_line';
  if (l.rule === 'passthrough') return 'passthrough';
  const cls = l.className;
  if (cls) {
    const named = /^Allocate - Split (FL|TN|TX)50$/.exec(cls) ?? /^Allocate - (FL|TN|TX)$/.exec(cls);
    const short: Record<string, string> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
    if (named && short[named[1]] === l.entity) return 'self_class';
    if (cls.startsWith('Allocate')) return 'unrecognized_class';
  }
  return 'other';
}

async function main(): Promise<void> {
  const months = process.argv.slice(2);
  if (months.length === 0) {
    console.error('usage: tsx scripts/payroll/probe-attention-breakdown.ts 2026-07 [2026-06 ...]');
    process.exit(1);
  }

  for (const tag of months) {
    const m = /^(\d{4})-(\d{2})$/.exec(tag);
    if (!m) { console.error(`skipping malformed month ${tag}`); continue; }
    const month = { year: Number(m[1]), month: Number(m[2]) };

    console.log(`\n${'='.repeat(78)}\n${tag}\n${'='.repeat(78)}`);
    const { pool, attention } = await fetchAllocationPool(month);
    console.log(`  in the drafts (splittable): ${pool.length} line(s)`);
    console.log(`  held back ("needs attention"): ${attention.length} line(s)`);

    const groups = new Map<string, { n: number; total: number; samples: PoolLine[] }>();
    for (const l of attention) {
      const k = bucket(l);
      const g = groups.get(k) ?? { n: 0, total: 0, samples: [] };
      g.n += 1;
      g.total = Math.round((g.total + l.amount) * 100) / 100;
      if (g.samples.length < 5) g.samples.push(l);
      groups.set(k, g);
    }

    const noAction = groups.get('passthrough')?.n ?? 0;
    const actionable = attention.length - noAction;
    console.log(`\n  --> NO ACTION NEEDED: ${noAction}`);
    console.log(`  --> ACTUALLY NEEDS A FIX: ${actionable}`);

    for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`\n  [${k}] ${g.n} line(s), ${money(g.total)}`);
      for (const s of g.samples) {
        console.log(
          `     ${s.entity} ${s.txnDate} ${s.txnType} ${s.docNumber ?? `#${s.txnId}`}` +
          ` class=${JSON.stringify(s.className)} acct=${s.accountName} ${money(s.amount)}`,
        );
      }
      if (g.n > g.samples.length) console.log(`     … +${g.n - g.samples.length} more`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
