/**
 * CS-ONLY CATCH-UP (Barbara via Carson, 2026-08-25): generate + post journal entries that
 * split ONLY Customer-Service labor by revenue %, April..August 2026. Barbara is not ready
 * for the full month-end allocation; this catches CS up without touching anything else.
 * (March is handled separately: full corrected reissue — see march-allo-kill-regen-repost.ts.
 * The CS revenue rule starts April 2026 per Ash's hard cutoff, so this starts at April.)
 *
 * DELTA-AWARE (2026-08-25, second pass): re-running is safe and is HOW the top-ups happen.
 * Each run builds the full-month CS allocation fresh, nets out what the posted CS Allo
 * entries for that month already moved (cs-catchup.csRemainderLines), and posts only the
 * remainder as `<ST> CS Allo YYYY.MM-2` (-3, ...). A month that is fully covered prints
 * "up to date". Run it again after the last August payroll posts to catch the month end.
 *
 * The CS pool is `isCsPoolLine` (qb-pool): ownedPayroll + DraftJE lines by derived rule,
 * external QB JEs by Customer-Service-named accounts only. Non-payroll 'Allocate - %'
 * lines (bills, Aetna JEs, ADP purchases) are deliberately EXCLUDED — they are not CS.
 *
 * pay_group 'CS ALLO' / 'CS ALLO 2' / ... — listPostedCsAlloHeaders keys on the prefix, and
 * the full month-end's hard rule (eom generate + regen-eom-months) excludes the CS pool
 * slice for any month with posted CS ALLO headers, so the two can never double-move CS.
 *
 *   npx tsx scripts/payroll/cs-catchup-allocation.ts               (dry-run, prints all JEs)
 *   npx tsx scripts/payroll/cs-catchup-allocation.ts --live        (saves headers + posts to QB)
 */
import './load-env-vercel-first';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { fetchAllocationPool, isCsPoolLine } from '../../src/lib/payroll/qb-pool';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';
import { csRemainderLines } from '../../src/lib/payroll/cs-catchup';
import { listPostedCsAlloHeaders } from '../../src/lib/payroll/eom-store';
import { longMonthName, monthTag, type Month } from '../../src/lib/payroll/month';
import { postJournalEntry } from '../../src/lib/payroll/qb-journal';
import { insertAudit, loadDraft, saveDraft, setHeaderStatus, type JsonValue } from '../../src/lib/payroll/store';
import type { Entity, JournalDraft, JournalLine } from '../../src/lib/payroll/types';

const MONTHS: Month[] = [4, 5, 6, 7, 8].map((month) => ({ year: 2026, month }));
const SHORT: Partial<Record<Entity, string>> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const live = process.argv.includes('--live');
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

function sideTotal(lines: JournalLine[], side: 'Debit' | 'Credit'): number {
  return round2(lines.filter((l) => l.postingType === side).reduce((s, l) => s + l.amount, 0));
}

async function runMonth(m: Month): Promise<void> {
  const tag = monthTag(m);
  console.log(`\n===== ${tag} =====`);
  const { pool } = await fetchAllocationPool(m);
  const cs = pool.filter(isCsPoolLine);
  const byEntity = new Map<Entity, number>();
  for (const l of cs) byEntity.set(l.entity, (byEntity.get(l.entity) ?? 0) + l.amount);
  console.log(`  CS pool: ${cs.length} lines`);
  for (const [e, amt] of [...byEntity].sort()) console.log(`    ${e}: ${money(amt)}`);
  if (cs.length === 0) { console.log('  nothing to allocate'); return; }

  const shares = sharesFromRevenue(await fetchRevenuePresence(m));
  if (shares === null) throw new Error(`${tag}: no location has revenue — cannot run the revenue rule`);
  const shareTxt = EOM_ENTITIES.map((e: EomEntity) => `${SHORT[e]} ${shares[e].toFixed(2)}%`).join(' / ');
  console.log(`  revenue shares: ${shareTxt}`);

  // Full-month target, then net out what the posted CS Allo entries already moved.
  const target = buildMonthEndAllocation(cs, shares, m);
  const postedHeaders = await listPostedCsAlloHeaders(m);
  const postedByEntity = new Map<Entity, JournalLine[][]>();
  for (const h of postedHeaders) {
    const loaded = await loadDraft(h.id);
    if (!loaded) throw new Error(`posted CS Allo header #${h.id} has no lines`);
    const sets = postedByEntity.get(h.entity) ?? [];
    sets.push(loaded.lines);
    postedByEntity.set(h.entity, sets);
  }
  const issue = Math.max(0, ...[...postedByEntity.values()].map((s) => s.length)) + 1;

  for (const d of target) {
    const postedSets = postedByEntity.get(d.entity) ?? [];
    const remainder = csRemainderLines(d.lines, postedSets);
    if (remainder.length === 0) {
      console.log(`  ${d.entity}: up to date (${postedSets.length} posted CS Allo entr${postedSets.length === 1 ? 'y' : 'ies'} cover the month)`);
      continue;
    }
    const dr = sideTotal(remainder, 'Debit');
    const cr = sideTotal(remainder, 'Credit');
    const variance = round2(dr - cr);
    if (variance !== 0) throw new Error(`${d.entity} ${tag}: remainder unbalanced (var=${variance}) — refusing`);

    const suffix = issue === 1 ? '' : `-${issue}`;
    const draft: JournalDraft = {
      ...d,
      docNumber: `${SHORT[d.entity]} CS Allo ${tag}${suffix}`,
      payGroup: issue === 1 ? 'CS ALLO' : `CS ALLO ${issue}`,
      privateNote:
        `Customer Service labor allocation — ${longMonthName(m)} ${m.year}` +
        (issue === 1 ? ' (catch-up). ' : ` (top-up #${issue}: CS activity posted after the previous CS Allo entries). `) +
        `CS-attributed payroll lines only, allocated as a % of revenue: ${shareTxt}. ` +
        `Admin/Accounting, marketing and all other costs are NOT in this entry. ` +
        `The automated month-end allocation excludes CS for this month because these entries carry it.`,
      lines: remainder, totalDebits: dr, totalCredits: cr, variance,
    };
    console.log(`  ${draft.docNumber}: Dr ${money(dr)} Cr ${money(cr)} var=${variance}${postedSets.length > 0 ? ` (delta over ${postedSets.length} posted set(s))` : ''}`);
    for (const l of draft.lines) {
      console.log(`    ${l.postingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.amount).padStart(13)}  ${l.accountName}  ${l.memo}`);
    }

    if (!live) continue;
    const id = await saveDraft(draft, `cs-catchup-${tag}-${issue}`);
    const result = await postJournalEntry(draft.entity, draft, { mode: 'live' });
    await setHeaderStatus(id, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    await insertAudit({
      headerId: id, mode: 'live', entity: draft.entity,
      qbDocNumber: result.qbDocNumber, qbEntryId: result.qbEntryId, outcome: 'posted',
      requestPayload: JSON.parse(JSON.stringify(result.payload)) as JsonValue,
      responseBody: result.response ?? null,
    });
    console.log(`  ✅ POSTED ${draft.entity}: ${result.qbDocNumber} — QB JE Id ${result.qbEntryId} (header #${id})`);
  }
}

async function main(): Promise<void> {
  console.log(`mode=${live ? 'LIVE' : 'DRY-RUN'} — CS catch-up/top-up ${MONTHS[0].year}-04..08`);
  for (const m of MONTHS) await runMonth(m);
  if (!live) console.log('\nDRY-RUN — nothing saved or posted. Re-run with --live.');
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
