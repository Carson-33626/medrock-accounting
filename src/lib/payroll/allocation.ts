import type { Entity, AllocationRule, JournalDraft, JournalLine } from './types';
import { ieAccountFor } from './inter-entity';
import { monthTag, monthEndIso, monthEndAdp, longMonthName, type Month } from './month';

/** Throws unless the percents sum to 100.0000 (4dp tolerance). No silent normalisation. */
export function assertSharesSumTo100(percents: number[]): void {
  const sum = percents.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.0001) {
    throw new Error(`allocation percents must sum to 100, got ${sum.toFixed(4)}`);
  }
}

/**
 * Split `totalCents` across `weights` (percentages) by the largest-remainder method: floor each
 * proportional share, then hand the leftover cents one at a time to the largest fractional
 * remainders. The result sums to `totalCents` EXACTLY, so 33.3333 × 3 never leaves a stray cent.
 */
export function largestRemainderCents(totalCents: number, weights: number[]): number[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (totalCents === 0 || wsum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / wsum);
  const floors = exact.map((x) => Math.floor(x));
  let remaining = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < order.length && remaining > 0; k++) { out[order[k].i]++; remaining--; }
  return out;
}

const ADMIN_WAGE_ACCOUNT = 'Payroll Expense -:Administrative Wages';
const ALLOC_DEPT = '% Allocation';
const ALLOC_CLASS = 'Allocate - %';
const ALLOC_MEMO = '% Allocation - Admin Wages';
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const SHORT_ENT: Record<Entity, string> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };

/** Latest active rule per entity effective on or before month start; null if the month precedes
 *  every rule or the three FL/TN/TX shares aren't all present. */
export function resolveEffectiveShares(
  rules: AllocationRule[], costCenter: string, m: Month,
): Record<Entity, number> | null {
  const startIso = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
  const out: Partial<Record<Entity, number>> = {};
  for (const e of ENTITIES) {
    const eligible = rules
      .filter((r) => r.active && r.costCenter === costCenter && r.targetEntity === e && r.effectiveFrom <= startIso)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    if (eligible.length > 0) out[e] = eligible[0].percent;
  }
  if (ENTITIES.some((e) => out[e] === undefined)) return null;
  return out as Record<Entity, number>;
}

function wageLine(posting: 'Debit' | 'Credit', amount: number): JournalLine {
  return { postingType: posting, amount, accountName: ADMIN_WAGE_ACCOUNT, departmentName: ALLOC_DEPT, className: ALLOC_CLASS, memo: ALLOC_MEMO, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [] };
}
function ieLine(account: string, posting: 'Debit' | 'Credit', amount: number): JournalLine {
  return { postingType: posting, amount, accountName: account, departmentName: ALLOC_DEPT, className: ALLOC_CLASS, memo: ALLOC_MEMO, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [] };
}
function draftShell(entity: Entity, m: Month, lines: JournalLine[]): JournalDraft {
  const dr = Math.round(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const cr = Math.round(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return {
    entity, kind: 'allocation', payDate: monthEndAdp(m), payGroup: '', periodStart: monthEndAdp(m), periodEnd: monthEndAdp(m),
    docNumber: `${SHORT_ENT[entity]} % Allo ${monthTag(m)}`, txnDate: monthEndIso(m),
    privateNote: `Admin wage % allocation — ${longMonthName(m)} ${m.year}`,
    lines, totalDebits: dr, totalCredits: cr, variance: Math.round((dr - cr) * 100) / 100, rowKeys: [],
  };
}

/**
 * Standalone month-end inter-entity JEs that redistribute ADMIN regular wages to the target split,
 * hubbed through FL. Δ_e = target_e − actual_e; Σ Δ = 0 by largest-remainder. Δ>0 → the entity picks
 * up cost (debit Admin Wages, credit its Due-to-FL account); Δ<0 → it sheds cost (credit Admin Wages,
 * debit its Due-to-FL account). FL's draft books its own Δ plus the Due-from-TN / Due-from-TX legs.
 * Returns [] when no rule is effective for `m` or every Δ is zero.
 */
export function buildAllocation(
  adminTotalsByEntity: Record<Entity, number>, rules: AllocationRule[], m: Month,
): JournalDraft[] {
  const shares = resolveEffectiveShares(rules, 'ADMIN', m);
  if (!shares) return [];
  assertSharesSumTo100(ENTITIES.map((e) => shares[e]));

  const actualCents = ENTITIES.map((e) => Math.round((adminTotalsByEntity[e] ?? 0) * 100));
  const totalCents = actualCents.reduce((a, b) => a + b, 0);
  const targetCents = largestRemainderCents(totalCents, ENTITIES.map((e) => shares[e]));
  const delta: Record<Entity, number> = { 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 };
  ENTITIES.forEach((e, i) => { delta[e] = (targetCents[i] - actualCents[i]) / 100; });

  const drafts: JournalDraft[] = [];

  for (const e of ['MedRock TN', 'MedRock TX'] as Entity[]) {
    const d = delta[e];
    if (d === 0) continue;
    const ie = ieAccountFor(e, 'MedRock FL');
    const lines = d > 0
      ? [wageLine('Debit', d), ieLine(ie, 'Credit', d)]
      : [wageLine('Credit', -d), ieLine(ie, 'Debit', -d)];
    drafts.push(draftShell(e, m, lines));
  }

  const dFl = delta['MedRock FL'];
  const flLegs: JournalLine[] = [];
  if (dFl !== 0) flLegs.push(dFl > 0 ? wageLine('Debit', dFl) : wageLine('Credit', -dFl));
  for (const e of ['MedRock TN', 'MedRock TX'] as Entity[]) {
    const d = delta[e];
    if (d === 0) continue;
    // FL's receivable rises when the counterparty picks up cost (Δ>0) → debit Due from.
    flLegs.push(ieLine(ieAccountFor('MedRock FL', e), d > 0 ? 'Debit' : 'Credit', Math.abs(d)));
  }
  if (flLegs.length > 0) drafts.push(draftShell('MedRock FL', m, flLegs));

  return drafts;
}
