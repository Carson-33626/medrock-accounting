/**
 * ONE-OFF (Barbara via Carson, 2026-08-19): month-end allocation JE covering ONLY the
 * Allocate-tagged lines of the 04/10/2026 payroll's March pieces (txn 2026-03-31:
 * FL #1134 / TN #1450 / TX #651, posted today as PR 2026.04.10A → QB 53227/20555/1889).
 *
 * March's EOM allocation is already posted and March can never regenerate (it would
 * re-pool everything accounting already booked). This runs the SAME engine
 * (buildMonthEndAllocation, current rules incl. pooled passthrough) over just these
 * three drafts' tagged lines, with March's revenue shares, under a distinct doc number
 * '<ST> % Allo 2026.03-2' so it can never collide with the posted 'FL % Allo 2026.03'.
 * FOCAS is not an EOM entity and its 4/10 pieces are excluded by construction.
 *
 *   npx tsx scripts/payroll/post-march-0410-allocation.ts [--live]
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { poolLineFromLocalDraftRow, isPooledLine, type LocalDraftLineRow, type PoolLine } from '../../src/lib/payroll/qb-pool';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';
import { postJournalEntry } from '../../src/lib/payroll/qb-journal';
import type { Entity } from '../../src/lib/payroll/types';

const HEADER_IDS = [1134, 1450, 651]; // the 2026-03-31 A-pieces: FL / TN / TX
const MARCH = { year: 2026, month: 3 };
const SHORT: Partial<Record<Entity, string>> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const live = process.argv.includes('--live');
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  console.log(`mode=${live ? 'LIVE' : 'DRY-RUN'} — allocation over headers ${HEADER_IDS.join(', ')} (txn 2026-03-31)`);

  const rds = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  let pool: PoolLine[] = [];
  try {
    const { rows } = await rds.query<LocalDraftLineRow & { header_id: string }>(
      `SELECT h.id::text AS header_id, h.entity, h.pay_date, h.txn_date::text AS txn_date,
              l.posting_type, l.amount::text AS amount, l.account_name, l.department_name, l.class_name, l.memo
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE h.id = ANY($1::int[])
          AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')`,
      [HEADER_IDS],
    );
    for (const r of rows) {
      const pl = poolLineFromLocalDraftRow(r);
      if (pl && isPooledLine(pl)) pool.push(pl);
    }
  } finally {
    await rds.end();
  }
  const byEntity = new Map<string, number>();
  for (const l of pool) byEntity.set(l.entity, (byEntity.get(l.entity) ?? 0) + l.amount);
  console.log(`pooled lines: ${pool.length}`);
  for (const [e, amt] of byEntity) console.log(`  ${e}: ${money(amt)}`);
  if (pool.length === 0) throw new Error('no Allocate-tagged lines found — nothing to allocate');

  const revenueTest = await fetchRevenuePresence(MARCH);
  let shares = sharesFromRevenue(revenueTest);
  if (shares === null) {
    if (pool.some((l) => l.rule === 'revenue')) throw new Error('no location has March revenue — cannot run the revenue rule');
    shares = Object.fromEntries(EOM_ENTITIES.map((e: EomEntity) => [e, 0])) as Record<EomEntity, number>;
  }
  console.log(`March shares: ${EOM_ENTITIES.map((e) => `${SHORT[e]} ${shares[e].toFixed(2)}%`).join(' / ')}`);

  const drafts = buildMonthEndAllocation(pool, shares, MARCH);
  for (const d of drafts) {
    // Distinct identity: never collide with the posted 'FL % Allo 2026.03'.
    d.docNumber = `${SHORT[d.entity]} % Allo 2026.03-2`;
    d.txnDate = '2026-03-31';
    d.privateNote =
      'Month-end allocation — March 2026, SUPPLEMENT #2: covers ONLY the Allocate-tagged lines of the ' +
      '04/10/2026 payroll March pieces (PR 2026.04.10A, posted 2026-08-19 after the March close ran). ' +
      `Revenue rule: ${EOM_ENTITIES.map((e) => `${SHORT[e]} ${shares[e].toFixed(2)}%`).join(' / ')}. ` +
      'The main March allocation JE is separate and untouched.';
    console.log(`\n===== ${d.entity} — ${d.docNumber} (Dr=${money(d.totalDebits)} Cr=${money(d.totalCredits)} var=${d.variance}) =====`);
    for (const l of d.lines) {
      console.log(`  ${l.postingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.amount).padStart(13)}  ${l.accountName}  ${l.memo ?? ''}`);
    }
  }

  if (!live) {
    console.log('\nDRY-RUN — nothing posted. Re-run with --live to post.');
    return;
  }
  for (const d of drafts) {
    const result = await postJournalEntry(d.entity, d, { mode: 'live' });
    console.log(`✅ POSTED ${d.entity}: ${result.qbDocNumber} — QB JE Id ${result.qbEntryId}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
