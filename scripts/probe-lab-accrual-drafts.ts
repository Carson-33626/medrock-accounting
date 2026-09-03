// DRY RUN, no writes anywhere: read the live accrual from QuickBooks and print the
// journal entries it WOULD generate. Nothing is saved to the draft table and nothing
// is sent to QuickBooks — buildLabAccrualDrafts is pure.
//
// Run from web/:  npx tsx scripts/probe-lab-accrual-drafts.ts [YYYY-MM]
import './lib/load-env';
import { fetchLabSuppliesAccrual } from '../src/lib/inventory/lab-supplies-server';
import { buildLabAccrualDrafts } from '../src/lib/inventory/lab-supplies-je';

const money = (n: number): string => n.toFixed(2).padStart(12);

async function main(): Promise<void> {
  const wanted = process.argv[2];
  const { asOf, months, unavailable } = await fetchLabSuppliesAccrual(6);
  console.log(`as of ${asOf}${unavailable.length > 0 ? `  |  unavailable: ${unavailable.join('; ')}` : ''}\n`);

  console.log('--- the accrual the COGS tab shows ---');
  for (const m of months) {
    console.log(
      [
        m.location.padEnd(12),
        m.month,
        `entered ${money(m.observedToDate)}`,
        `docs ${String(m.observedDocs).padStart(3)}`,
        `complete ${String(Math.round(m.completeness * 100)).padStart(3)}% (${m.boundBy})`,
        `accrual ${money(m.accrual)}`,
        m.flagged ? 'REVIEW' : '',
      ].join('  '),
    );
  }

  const targets = wanted ? months.filter((m) => m.month === wanted) : months;
  console.log(`\n--- journal entries that would generate${wanted ? ` for ${wanted}` : ''} ---`);
  let pairs = 0;
  for (const m of targets) {
    const pair = buildLabAccrualDrafts({
      location: m.location,
      month: m.month,
      accrual: m.accrual,
      completeness: m.completeness,
      boundBy: m.boundBy,
    });
    if (pair === null) {
      console.log(`${m.location.padEnd(12)} ${m.month}  — nothing to accrue, month has settled`);
      continue;
    }
    pairs += 1;
    for (const draft of [pair.accrual, pair.reversal]) {
      console.log(
        `\n${draft.entity}  ${draft.docNumber}  txn ${draft.txnDate}  pay_date ${draft.payDate}  kind ${draft.kind}`,
      );
      for (const l of draft.lines) {
        console.log(
          `    ${l.postingType.padEnd(6)} ${money(l.amount)}  ${l.accountName.padEnd(38)} ${l.memo}`,
        );
      }
      const dr = draft.lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0);
      const cr = draft.lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0);
      console.log(`    balance: Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)} ${Math.abs(dr - cr) < 0.005 ? '✓' : '✗'}`);
    }
  }
  console.log(`\n${pairs} accrual/reversal pair(s) would be generated. Nothing was written.`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
