/** READ-ONLY: is the allocation pool double-counting local drafts against posted QB entries?
 *
 *  fetchAllocationPool merges QB posted transactions with LOCAL unposted payroll drafts, and
 *  guards against overlap by skipping any draft whose derived DocNumber is already live in QB.
 *  March is the risky month: Barbara posted the payroll herself, so our local drafts for the
 *  same pay dates still sit unposted. If the guard misses any of them, their wages enter the
 *  pool twice and the allocation is overstated.
 *
 *  Lists every DraftJE line the pool picked up, the header it came from, and whether a QB
 *  JournalEntry with that DocNumber already exists.
 *
 *  No writes. Untracked scratch.
 */
import './load-env-vercel-first';
import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { EOM_ENTITIES, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import type { RawJournalEntry } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '2026-03';
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(arg);
  if (!match) { console.error('usage: probe-draft-vs-posted-overlap.ts YYYY-MM'); process.exit(1); }
  const m = { year: Number(match[1]), month: Number(match[2]) };
  const lastDay = new Date(m.year, m.month, 0).getDate();
  const mm = String(m.month).padStart(2, '0');
  const where = `WHERE TxnDate >= '${m.year}-${mm}-01' AND TxnDate <= '${m.year}-${mm}-${lastDay}'`;

  // Every DocNumber live in QuickBooks this month, per entity.
  const qbDocs = new Map<EomEntity, Set<string>>();
  for (const e of EOM_ENTITIES) {
    const jes = await qbQueryAll<RawJournalEntry>(e, 'JournalEntry', where);
    qbDocs.set(e, new Set(jes.map((j) => (j.DocNumber ?? '').trim()).filter(Boolean)));
    console.log(`  ${e}: ${jes.length} QB JEs in ${arg}`);
  }

  const { pool } = await fetchAllocationPool(m);
  const drafts = pool.filter((l) => l.txnType === 'DraftJE');
  console.log(`\n=== ${arg}: ${pool.length} pool lines, ${drafts.length} from local unposted drafts ===`);

  const byDoc = new Map<string, { entity: EomEntity; n: number; total: number }>();
  for (const l of drafts) {
    const key = `${l.entity}¦${l.docNumber ?? '(no doc#)'}`;
    const cur = byDoc.get(key) ?? { entity: l.entity as EomEntity, n: 0, total: 0 };
    cur.n++; cur.total += l.amount;
    byDoc.set(key, cur);
  }

  let overlapLines = 0;
  let overlapDollars = 0;
  console.log(`\n  ${'entity'.padEnd(13)} ${'draft DocNumber'.padEnd(26)} ${'lines'.padStart(5)} ${'amount'.padStart(14)}   in QB already?`);
  for (const [key, v] of [...byDoc].sort()) {
    const doc = key.split('¦')[1];
    const live = qbDocs.get(v.entity)?.has(doc) ?? false;
    if (live) { overlapLines += v.n; overlapDollars += v.total; }
    console.log(`  ${v.entity.padEnd(13)} ${doc.padEnd(26)} ${String(v.n).padStart(5)} ${money(v.total).padStart(14)}   ${live ? '*** YES — DOUBLE COUNT ***' : 'no'}`);
  }

  console.log(`\n=== ${overlapLines} overlapping line(s), ${money(overlapDollars)} counted twice ===`);
  if (overlapLines === 0) console.log('  Guard is holding: no local draft duplicates a posted QB entry.');

  // Cross-check the other way: posted QB payroll whose pay date has an unposted local twin
  // under a DIFFERENT DocNumber would slip past a name-based guard entirely.
  console.log(`\n  note: the guard matches on DocNumber. A local draft whose derived DocNumber`);
  console.log(`  differs from the posted one (renamed, or an A/B split suffix) would not be caught.`);

  process.exit(0);
}

void main();
