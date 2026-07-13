/**
 * Reusable derivation: marketer (position_id) -> QB Department/Class employee-map overlay.
 *
 * The account-map (account-map-seed-data.ts) already derives the marketing WAGE ACCOUNT from
 * cost_center (MARKET -> 'Payroll Expense -:Marketing Wages - Base'). This module supplies only
 * the DIMENSION overlay on top of that: which QB Department (region) + Class each marketer's
 * position_id should carry. Non-marketers are simply absent from the returned array — their
 * employee-map lookup in resolveLine() (src/lib/payroll/mapping.ts) misses and departmentName/
 * className resolve to null, which is correct (no override needed).
 *
 * Join chain: payroll `name` (plaintext, NOT decrypted) -> scripts/payroll/territory-snapshot.json
 * (rep_name -> market, latest period per rep) -> MARKET_TO_QB_DEPT -> QB Department string.
 * The name-normalization (`norm`/`nameKeys`) and MARKET_TO_QB_DEPT translation table below are an
 * EXACT copy of the validated logic in scripts/payroll/probe-region-join.ts — keep both in sync if
 * either changes.
 *
 * NO decryption of sensitive_encrypted. Only plaintext payroll_history columns are read
 * (position_id, name, pay_group, sui_sdi_tax_code). `name` is read only to join against the
 * territory snapshot and is never persisted or printed except in the unmatched-marketer
 * diagnostic list (that's the one place PII is intentionally surfaced, per Carson's guardrail --
 * it's actionable: someone has to go add a territory_mapping entry or fix a name).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRdsPool } from '../../src/lib/rds';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { EmployeeMapRule } from '../../src/lib/payroll/types';

const SNAPSHOT_FILE = resolve(__dirname, 'territory-snapshot.json');

interface SnapshotRep { repName: string; market: string; period: number }
interface Snapshot { generatedFrom: string; note: string; reps: SnapshotRep[] }

// Salesforce "market" -> Amy's QB Department string (from PR 2026.03.27 marketing lines).
// EXACT copy of scripts/payroll/probe-region-join.ts's MARKET_TO_QB_DEPT -- do not drift.
const MARKET_TO_QB_DEPT: Record<string, string> = {
  'Miami Region': 'Miami Region',
  'Orlando Region': 'Orlando Region',
  'Tampa Region': 'Tampa Region',
  'Naples Region': 'Tampa Region', // notes: merge Naples into Tampa
  'Jacksonville Region': 'Jax @ S GA Region',
  'South Georgia': 'Jax @ S GA Region',
  Remote: 'Puerto Rico Region', // Eileen Hernandez: merged from Puerto Rico into Remote
  Arizona: 'AZ Region',
  'North Georgia': 'N GA Region',
  'New England': 'NE Region',
  'Carolina Region': 'NC/SC Region',
  Michigan: 'Detroit Region',
  Tennessee: 'TN Region',
  Maryland: 'MD/DC/VA Region',
  'Colorado Region': 'CO Region',
  Illinois: 'IL Region',
  'Ohio Region': 'Ohio Region',
  Pennslyvania: 'PA Region',
  'Dallas Region': 'Dallas Region',
  'Houston Region': 'Houston Region',
  'Austin Region': 'Austin Region', // overridden below for the historical 03/27 validation
};

// EXACT copy of scripts/payroll/probe-region-join.ts's norm()/nameKeys().
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(jr|sr|ii|iii)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// ADP `name` is often "Last, First [Middle]" -- produce a "first last" normalized key too.
function nameKeys(raw: string): string[] {
  const keys = new Set<string>();
  const n = norm(raw);
  keys.add(n);
  if (raw.includes(',')) {
    const [last, rest] = raw.split(',');
    const first = (rest ?? '').trim().split(/\s+/)[0] ?? '';
    keys.add(norm(`${first} ${last}`));
  }
  const toks = n.split(' ');
  if (toks.length >= 2) keys.add(`${toks[0]} ${toks[toks.length - 1]}`);
  return [...keys];
}

/**
 * CONFIRMED name-alias overrides (Carson): payroll `name` spellings that don't match the
 * territory_mapping rep_name via nameKeys() at all (maiden/married-name or reordering gaps),
 * consulted BEFORE the snapshot lookup so the fix is explicit and auditable rather than a
 * silent fuzzy-match guess. Key = normalized payroll name (norm(row.name)); value = the
 * territory_mapping rep_name to look up instead.
 *   'Wilhoit, Robert' -> Rob Wilhoit (Carolina Region -> NC/SC Region)
 *   'Snyder, Antoneta' -> Antoneta Cici's market (Jacksonville Region -> Jax @ S GA Region)
 */
const NAME_ALIASES: Record<string, string> = {
  [norm('Wilhoit, Robert')]: 'Rob Wilhoit',
  [norm('Snyder, Antoneta')]: 'Antoneta Cici',
};

function loadRepMarket(): Map<string, { market: string; period: number }> {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf-8')) as Snapshot;
  const repMarket = new Map<string, { market: string; period: number }>();
  for (const rep of snapshot.reps) {
    for (const k of nameKeys(rep.repName)) {
      const cur = repMarket.get(k);
      if (!cur || rep.period > cur.period) repMarket.set(k, { market: rep.market, period: rep.period });
    }
  }
  return repMarket;
}

function resolveMarket(
  payrollName: string,
  repMarket: Map<string, { market: string; period: number }>,
): { market: string; period: number } | undefined {
  const aliasRep = NAME_ALIASES[norm(payrollName)];
  if (aliasRep) {
    for (const k of nameKeys(aliasRep)) {
      const hit = repMarket.get(k);
      if (hit) return hit;
    }
  }
  for (const k of nameKeys(payrollName)) {
    const hit = repMarket.get(k);
    if (hit) return hit;
  }
  return undefined;
}

export interface UnmatchedMarketer { payGroup: string; name: string; sui: string }

/**
 * Populated as a side effect of the most recent buildMarketerEmployeeMap() call -- lets callers
 * (the seeder CLI preview, the dry-run report) surface the actionable "no rep found" list without
 * changing the function's required Promise<EmployeeMapRule[]> return type. Reset at the start of
 * each call.
 */
export const lastUnmatchedMarketers: UnmatchedMarketer[] = [];

interface MarketerRow { position_id: string; name: string; pay_group: string; sui_sdi_tax_code: string | null }

export async function buildMarketerEmployeeMap(): Promise<EmployeeMapRule[]> {
  lastUnmatchedMarketers.length = 0;
  const repMarket = loadRepMarket();

  const { rows } = await getRdsPool().query<MarketerRow>(
    `SELECT DISTINCT ON (position_id) position_id, name, pay_group, sui_sdi_tax_code
     FROM source.payroll_history
     WHERE home_department ILIKE 'MARKET%'
     ORDER BY position_id, to_date(pay_date,'MM/DD/YYYY') DESC`,
  );

  const rules: EmployeeMapRule[] = [];
  for (const row of rows) {
    let entity = entityForPayGroup(row.pay_group);
    if (entity === 'FOCS_EXCLUDED' || entity === null) continue; // FOCS/1099/unknown pay group -- skip

    const hit = resolveMarket(row.name, repMarket);
    if (!hit) {
      // No territory_mapping entry for this name at all -- e.g. Luke Lockwood (offboarded, no
      // territory). Still recorded as a diagnostic (lastUnmatchedMarketers) so someone can see who
      // defaulted, but per Carson's decision (2026-07-13) this now emits a '% Allocation' Department
      // employee-map row rather than being dropped -- this matches Amy's actual treatment, who folds
      // every marketer she can't tie to a live territory into the inter-entity '% Allocation'
      // catch-all Department rather than leaving the wage un-split. This default is overridable: the
      // Mappings employee-map editor / Review marketer worklist in the UI lets someone reassign a
      // real region once a territory is known.
      // Tradeoff: a brand-new marketer not yet present in territory-snapshot.json will silently
      // default to '% Allocation' until reassigned -- this is exactly why the UI must surface the
      // lastUnmatchedMarketers diagnostic list for review rather than treating it as a dead end.
      lastUnmatchedMarketers.push({ payGroup: row.pay_group, name: row.name, sui: row.sui_sdi_tax_code ?? '?' });
      rules.push({
        entity,
        positionId: row.position_id,
        departmentName: '% Allocation',
        className: null,
        cogsOverride: null,
        active: true,
      });
      continue;
    }

    let departmentName: string | null = MARKET_TO_QB_DEPT[hit.market] ?? null;
    let className: string | null = null;

    // Austin Region marketer: Austin has since moved to the TX entity (this position's LATEST
    // payroll row -- the one the query above selects via DISTINCT ON -- is now pay_group MRTX),
    // but on 03/27/2026 specifically she was still paid under MRFL (confirmed: position 000717 /
    // Nguyen, Oanh has pay_group='MRFL' through 03/27/2026 and 'MRTX' from 04/10/2026 on). For
    // the 03/27 HISTORICAL validation we must reproduce Amy's actual treatment -- she tagged this
    // rep's marketing wages with her inter-entity '% Allocation' Department / 'Allocate - TX'
    // Class tag, with the JE itself booked under MedRock FL. So we force entity back to
    // 'MedRock FL' here rather than trusting the (now-stale-for-this-date) latest-row pay_group.
    // TODO(go-forward): once Austin books natively to the TX entity via a future inter-entity
    // rule, this override (both the forced entity and the % Allocation/Allocate-TX tag) should
    // be replaced by a real MedRock TX employee-map rule with a normal region department.
    if (hit.market === 'Austin Region') {
      entity = 'MedRock FL';
      departmentName = '% Allocation';
      className = 'Allocate - TX';
    }

    if (!departmentName) {
      // Defensive: every market in territory-snapshot.json should have a MARKET_TO_QB_DEPT
      // translation. If a new market appears without one, surface it as unmatched rather than
      // silently guessing.
      lastUnmatchedMarketers.push({ payGroup: row.pay_group, name: row.name, sui: row.sui_sdi_tax_code ?? '?' });
      continue;
    }

    rules.push({
      entity,
      positionId: row.position_id,
      departmentName,
      className,
      cogsOverride: null,
      active: true,
    });
  }

  if (lastUnmatchedMarketers.length > 0) {
    console.log(`\nbuildMarketerEmployeeMap: ${lastUnmatchedMarketers.length} UNMATCHED marketer name(s) (no territory_mapping rep found):`);
    for (const u of lastUnmatchedMarketers) console.log(`  [${u.payGroup}] ${u.name}  (sui=${u.sui})`);
  }

  return rules;
}
