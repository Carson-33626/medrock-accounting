/** READ-ONLY: how is each department's labor distributed across the three pharmacies?
 *
 *  Barbara (2026-08-25): "If we consider including customer service in the allocation,
 *  should we also consider including data entry and shipping?"
 *
 *  The test Chris applied to CS is whether the team SERVES all three locations. A proxy that
 *  the books can answer: is the department's payroll concentrated in one entity (a central
 *  team working for everyone, so the employing entity carries a cost it does not solely
 *  benefit from), or spread roughly in line with revenue (each site staffing its own)?
 *
 *  Pulls March QB payroll JEs, buckets wage lines by department account, and shows each
 *  entity's share next to its revenue share. A department whose split already tracks revenue
 *  needs no allocation; one concentrated in a single entity is a candidate.
 *
 *  No writes. Untracked scratch.
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { fetchRevenuePresence, sharesFromRevenue, EOM_ENTITIES, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { normalizeAccountName, type RawJournalEntry } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Department buckets, matched on the wage account name. */
const BUCKETS: Array<{ label: string; re: RegExp }> = [
  { label: 'Customer Service', re: /customer service/i },
  { label: 'Data Entry',       re: /data entry|\bde wages/i },
  { label: 'Shipping',         re: /shipping/i },
  { label: 'Administrative',   re: /administrative/i },
  { label: 'Marketing',        re: /marketing/i },
  { label: 'Lab',              re: /lab wages|lab - ot/i },
  { label: 'Pharmacists',      re: /pharmacist/i },
  { label: 'R & D',            re: /r ?& ?d/i },
];

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const [y, mo] = month.split('-');
  const lastDay = new Date(Number(y), Number(mo), 0).getDate();
  const where = `WHERE TxnDate >= '${y}-${mo}-01' AND TxnDate <= '${y}-${mo}-${lastDay}'`;

  // entity -> bucket -> net dollars (debits positive)
  const totals = new Map<EomEntity, Map<string, number>>();
  const unmatched = new Map<string, number>();
  for (const e of EOM_ENTITIES) totals.set(e, new Map());

  for (const entity of EOM_ENTITIES) {
    const jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
    for (const je of jes) {
      // Payroll entries only — PR 2026.03.13, PR Accru 2026.03, PR Accru 2026.02R, ...
      if (!/^PR /i.test(je.DocNumber ?? '')) continue;
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const acct = d?.AccountRef?.name;
        if (!acct) continue;
        const name = normalizeAccountName(acct);
        if (!/wages/i.test(name)) continue; // wage accounts only: taxes/401k ride along per person
        const signed = (d?.PostingType === 'Credit' ? -1 : 1) * (l.Amount ?? 0);
        const hit = BUCKETS.find((b) => b.re.test(name));
        if (!hit) { unmatched.set(name, (unmatched.get(name) ?? 0) + signed); continue; }
        const m = totals.get(entity);
        if (m) m.set(hit.label, (m.get(hit.label) ?? 0) + signed);
      }
    }
  }

  const rev = await fetchRevenuePresence({ year: Number(y), month: Number(mo) });
  const shares = sharesFromRevenue(rev);
  console.log(`\n=== ${month} revenue shares ===`);
  for (const e of EOM_ENTITIES) console.log(`  ${e.padEnd(12)} ${money(rev.income[e]).padStart(16)}  ${(shares?.[e] ?? 0).toFixed(2).padStart(6)}%`);

  console.log(`\n=== ${month} wage cost by department, and how it is distributed ===`);
  console.log(`  (a department already spread like revenue needs no allocation;`);
  console.log(`   one concentrated in a single entity is the case for pooling)\n`);
  console.log(`  ${'Department'.padEnd(18)} ${'Total'.padStart(14)}   ${'FL'.padStart(18)} ${'TN'.padStart(18)} ${'TX'.padStart(18)}`);
  for (const b of BUCKETS) {
    const vals = EOM_ENTITIES.map((e) => totals.get(e)?.get(b.label) ?? 0);
    const total = vals.reduce((a, c) => a + c, 0);
    if (Math.abs(total) < 0.005) continue;
    const cells = vals.map((v) => `${money(v)} ${((v / total) * 100).toFixed(1).padStart(5)}%`);
    console.log(`  ${b.label.padEnd(18)} ${money(total).padStart(14)}   ${cells.map((c) => c.padStart(18)).join(' ')}`);
  }
  if (unmatched.size > 0) {
    console.log(`\n  wage accounts not bucketed:`);
    for (const [k, v] of [...unmatched].sort((a, b) => b[1] - a[1])) console.log(`      ${money(v).padStart(14)}  ${k}`);
  }

  console.log(`\n=== revenue-share benchmark for comparison ===`);
  console.log(`  ${'(revenue)'.padEnd(18)} ${''.padStart(14)}   ${EOM_ENTITIES.map((e) => `${(shares?.[e] ?? 0).toFixed(1)}%`.padStart(18)).join(' ')}`);

  process.exit(0);
}

void main();
