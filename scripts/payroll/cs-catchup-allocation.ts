/**
 * CS-ONLY CATCH-UP (Barbara via Carson, 2026-08-25): generate + post journal entries that
 * split ONLY Customer-Service labor by revenue %, April..August 2026. Barbara is not ready
 * for the full month-end allocation; this catches CS up without touching anything else.
 * (March is handled separately: full corrected reissue — see march-allo-kill-regen-repost.ts.
 * The CS revenue rule starts April 2026 per Ash's hard cutoff, so this starts at April.)
 *
 * CS pool, three sources with different trust levels:
 *   1. ownedPayroll lines (our posted payroll, re-derived from source rows): rule='revenue'
 *      IS Customer Service after the 2026-08-25 rule change (admin derives SplitX3,
 *      marketing never pools). Full loaded CS cost — wages, OT, taxes, 401K, WC, bonus.
 *   2. DraftJE lines (unposted payroll drafts, current-rule tags): same property.
 *   3. External QB JEs (Barbara's postings — she tags EVERYTHING 'Allocate - %', admin
 *      included, and her recurring re-class JEs carry 'PR'-prefixed docs): accept ONLY
 *      Customer-Service-named accounts. Her loaded-cost lines are not cc-attributable.
 * Non-payroll 'Allocate - %' lines (bills, Aetna JEs, ADP purchases) are EXCLUDED — not CS.
 *
 * Doc number: '<ST> CS Allo 2026.MM', pay_group 'CS ALLO' (invisible to listEomHeaders, so
 * a future full-EOM regen is not blocked — but the full EOM for one of these months MUST
 * supersede its CS Allo entry first or CS double-moves; the private note says so).
 *
 *   npx tsx scripts/payroll/cs-catchup-allocation.ts               (dry-run, prints all JEs)
 *   npx tsx scripts/payroll/cs-catchup-allocation.ts --live        (saves headers + posts to QB)
 */
import './load-env-vercel-first';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { fetchAllocationPool, type PoolLine } from '../../src/lib/payroll/qb-pool';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';
import { longMonthName, monthTag, type Month } from '../../src/lib/payroll/month';
import { postJournalEntry } from '../../src/lib/payroll/qb-journal';
import { insertAudit, saveDraft, setHeaderStatus, type JsonValue } from '../../src/lib/payroll/store';
import type { Entity } from '../../src/lib/payroll/types';

const MONTHS: Month[] = [4, 5, 6, 7, 8].map((month) => ({ year: 2026, month }));
const SHORT: Partial<Record<Entity, string>> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const live = process.argv.includes('--live');
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function isCsPayrollLine(l: PoolLine): boolean {
  if (l.rule !== 'revenue') return false;
  if (l.ownedPayroll === true || l.txnType === 'DraftJE') return true;
  return l.txnType === 'JournalEntry' && /^PR /.test(l.docNumber ?? '') && /customer service/i.test(l.accountName);
}

async function runMonth(m: Month): Promise<void> {
  const tag = monthTag(m);
  console.log(`\n===== ${tag} =====`);
  const { pool } = await fetchAllocationPool(m);
  const cs = pool.filter(isCsPayrollLine);
  const byEntity = new Map<Entity, number>();
  for (const l of cs) byEntity.set(l.entity, (byEntity.get(l.entity) ?? 0) + l.amount);
  console.log(`  CS payroll pool: ${cs.length} lines`);
  for (const [e, amt] of [...byEntity].sort()) console.log(`    ${e}: ${money(amt)}`);
  if (cs.length === 0) { console.log('  nothing to allocate'); return; }

  const shares = sharesFromRevenue(await fetchRevenuePresence(m));
  if (shares === null) throw new Error(`${tag}: no location has revenue — cannot run the revenue rule`);
  const shareTxt = EOM_ENTITIES.map((e: EomEntity) => `${SHORT[e]} ${shares[e].toFixed(2)}%`).join(' / ');
  console.log(`  revenue shares: ${shareTxt}`);

  const drafts = buildMonthEndAllocation(cs, shares, m);
  for (const d of drafts) {
    d.docNumber = `${SHORT[d.entity]} CS Allo ${tag}`;
    d.payGroup = 'CS ALLO';
    d.privateNote =
      `Customer Service labor allocation — ${longMonthName(m)} ${m.year} (catch-up). ` +
      `CS-attributed payroll lines only, allocated as a % of revenue: ${shareTxt}. ` +
      `Admin/Accounting, marketing and all other costs are NOT in this entry. ` +
      `If a full month-end allocation is ever posted for this month, supersede this entry first.`;
    console.log(`  ${d.docNumber}: Dr ${money(d.totalDebits)} Cr ${money(d.totalCredits)} var=${d.variance}`);
    for (const l of d.lines) {
      console.log(`    ${l.postingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.amount).padStart(13)}  ${l.accountName}  ${l.memo ?? ''}`);
    }
  }

  if (!live) return;
  for (const d of drafts) {
    const id = await saveDraft(d, `cs-catchup-${tag}`);
    const result = await postJournalEntry(d.entity, d, { mode: 'live' });
    await setHeaderStatus(id, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    await insertAudit({
      headerId: id, mode: 'live', entity: d.entity,
      qbDocNumber: result.qbDocNumber, qbEntryId: result.qbEntryId, outcome: 'posted',
      requestPayload: JSON.parse(JSON.stringify(result.payload)) as JsonValue,
      responseBody: result.response ?? null,
    });
    console.log(`  ✅ POSTED ${d.entity}: ${result.qbDocNumber} — QB JE Id ${result.qbEntryId} (header #${id})`);
  }
}

async function main(): Promise<void> {
  console.log(`mode=${live ? 'LIVE' : 'DRY-RUN'} — CS catch-up ${MONTHS[0].year}-04..08`);
  for (const m of MONTHS) await runMonth(m);
  if (!live) console.log('\nDRY-RUN — nothing saved or posted. Re-run with --live.');
  else console.log('\nNOTE: August is month-to-date; if more August payroll posts before 8/31, a top-up CS entry will be needed.');
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
