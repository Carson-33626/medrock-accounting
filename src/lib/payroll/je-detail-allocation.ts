/**
 * The allocation basis behind a posted month-end (`allocation`) journal entry, shaped as an
 * extra sheet of the entry's own workbook.
 *
 * What the accountants cannot see today is WHY a number came out the way it did: the entry
 * carries `Allocation of Administrative Wages — revenue % split $12,431.02` and nothing about
 * the pool it came from or the weight applied. This sheet puts the three together on one row —
 * the pooled cost as netted across every QB line that carried it, the driver weight, and this
 * entity's resulting share — so the split can be re-derived by hand from the file.
 *
 * Computed from `allocationBasis`, the same function `buildMonthEndAllocation` splits with, so
 * the sheet is a view of the entry rather than a second opinion about it. The stored pool
 * snapshot (`payroll_eom_runs.pool`) is what the draft was built from, so re-reading it is not
 * a re-pull: it is the actual source, retained.
 *
 * FOOTING IS THE CONTRACT (DS §7 acceptance 2): the sheet's Debit/Credit totals equal the
 * entry's, or the builder returns nothing at all.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { DetailSheet } from '@/lib/inventory/je-detail';
import type { AllocationBasisGroup } from './month-end';
import { ieAccountFor } from './inter-entity';
import { EOM_ENTITIES, type EomEntity } from './revenue-rule';
import type { Entity, JournalLine } from './types';

const COLUMNS: ExportColumn[] = [
  { header: 'Role', key: 'role' },
  { header: 'Account', key: 'account' },
  { header: 'Rule', key: 'rule' },
  { header: 'Held By', key: 'heldBy' },
  { header: 'Counterparty', key: 'counterparty' },
  { header: 'Pool Lines', key: 'poolLines' },
  { header: 'Pooled Cost', key: 'pooled', currency: true },
  { header: 'Weight %', key: 'weight' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
];

const SHORT: Record<Entity, string> = {
  'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX', 'FOCAS': 'FOCAS',
};

const isEomEntity = (e: Entity): e is EomEntity => (EOM_ENTITIES as Entity[]).includes(e);

export interface AllocationDetailInput {
  entity: Entity;
  /** The lines as PERSISTED on the header being posted. */
  storedLines: readonly JournalLine[];
  /** `allocationBasis(pool, shares, month)` over the run's stored pool snapshot. */
  basis: readonly AllocationBasisGroup[];
  /** Revenue weights the month was split on, for the note. */
  shares: Record<EomEntity, number>;
  /** One-line banner: entity, month, doc number. */
  label: string;
}

/**
 * @returns the single `Allocation basis` sheet, or `[]` when the basis and the stored entry do
 *   not reproduce each other exactly — a pool snapshot from a different generation, an entity
 *   outside the FL/TN/TX trio the rule covers, or an entry edited by hand after generation.
 */
export function buildAllocationJeDetailSheets(input: AllocationDetailInput): DetailSheet[] {
  const { entity, storedLines, basis } = input;
  if (!isEomEntity(entity)) return [];

  const rows: Record<string, CellValue>[] = [];
  // Rebuilt cents per (account, side) so the sheet can be checked against the stored entry
  // before it ships. Debits positive, credits negative — one signed number per account.
  const rebuilt = new Map<string, number>();
  const addRebuilt = (account: string, cents: number): void => {
    rebuilt.set(account, (rebuilt.get(account) ?? 0) + cents);
  };

  const ieNet = new Map<Entity, number>(); // counterparty -> signed cents (+ = this entity is owed)

  for (const g of basis) {
    const isHolder = g.entity === entity;
    const received = g.moved[entity];

    if (isHolder) {
      // Accumulated even when the group nets to no source line: two receivers' moves can
      // cancel (a +$100 to TN against a −$100 to TX), and the inter-entity balances they
      // create are real either way.
      for (const cp of EOM_ENTITIES) {
        if (g.moved[cp] === 0) continue;
        ieNet.set(cp, (ieNet.get(cp) ?? 0) + g.moved[cp]);
      }
      if (g.sourceMovedCents === 0) continue;
      // The holder sheds a positive cost as a Credit; a pooled refund flips both sides.
      rows.push(row({
        role: 'Shed (this entity held the cost)',
        g,
        weight: g.weights[entity],
        cents: -g.sourceMovedCents,
      }));
      addRebuilt(g.accountName, -g.sourceMovedCents);
      continue;
    }

    if (received === 0) continue;
    rows.push(row({
      role: `Received from ${SHORT[g.entity]}`,
      g,
      weight: g.weights[entity],
      cents: received,
    }));
    addRebuilt(g.accountName, received);
    ieNet.set(g.entity, (ieNet.get(g.entity) ?? 0) - received);
  }

  for (const [cp, cents] of ieNet) {
    if (cents === 0) continue;
    const account = ieAccountFor(entity, cp);
    rows.push({
      role: `Inter-entity net with ${SHORT[cp]}`,
      account,
      rule: '',
      heldBy: '',
      counterparty: SHORT[cp],
      poolLines: null,
      pooled: null,
      weight: null,
      ...sides(cents),
    });
    addRebuilt(account, cents);
  }

  if (rows.length === 0) return [];

  // The tie: every account the basis produces must match the stored entry to the cent, and no
  // account may appear on one side only. A mismatch means the snapshot no longer explains the
  // entry, and an approximate basis sheet is worse than none.
  const storedByAccount = new Map<string, number>();
  for (const l of storedLines) {
    const cents = Math.round(l.amount * 100) * (l.postingType === 'Debit' ? 1 : -1);
    storedByAccount.set(l.accountName, (storedByAccount.get(l.accountName) ?? 0) + cents);
  }
  if (storedByAccount.size !== rebuilt.size) return [];
  for (const [account, cents] of storedByAccount) {
    if (rebuilt.get(account) !== cents) return [];
  }

  const totalDebits = sumCol(rows, 'debit');
  const totalCredits = sumCol(rows, 'credit');
  rows.push({
    role: 'TOTAL', account: '', rule: '', heldBy: '', counterparty: '',
    poolLines: null, pooled: null, weight: null, debit: totalDebits, credit: totalCredits,
  });

  const pct = EOM_ENTITIES.map((e) => `${SHORT[e]} ${input.shares[e].toFixed(2)}%`).join(' / ');
  return [
    {
      name: 'Allocation basis',
      columns: COLUMNS,
      rows,
      note:
        `${input.label} — every pooled cost this entry moves, the weight applied, and the resulting share. ` +
        `Pooled Cost is the NET of all QB lines in the group as held by the source entity, before the split; ` +
        `Weight % is this entity's driver (revenue share ${pct} where the rule is revenue %, otherwise an equal or directed share). ` +
        `Debit/Credit total ${totalDebits.toFixed(2)} / ${totalCredits.toFixed(2)}, footing to the journal entry.`,
    },
  ];
}

function row(args: { role: string; g: AllocationBasisGroup; weight: number; cents: number }): Record<string, CellValue> {
  const { role, g, weight, cents } = args;
  const weightTotal = EOM_ENTITIES.reduce((s, e) => s + g.weights[e], 0);
  return {
    role,
    account: g.accountName,
    rule: g.ruleLabel,
    heldBy: SHORT[g.entity],
    counterparty: g.counterparty === null ? '' : SHORT[g.counterparty],
    poolLines: g.poolLines,
    pooled: g.poolCents / 100,
    // Revenue is a percentage already; the other rules are share counts, so print them as the
    // percentage of the group they represent rather than a bare 1 that reads as 1%.
    weight: g.appliedRule === 'revenue'
      ? Number(weight.toFixed(2))
      : weightTotal === 0 ? 0 : Number(((weight / weightTotal) * 100).toFixed(2)),
    ...sides(cents),
  };
}

/** Signed cents to a Debit/Credit pair: positive debits, negative credits. */
function sides(cents: number): { debit: number | null; credit: number | null } {
  return cents >= 0 ? { debit: cents / 100, credit: null } : { debit: null, credit: -cents / 100 };
}

function sumCol(rows: readonly Record<string, CellValue>[], key: 'debit' | 'credit'): number {
  let cents = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === 'number') cents += Math.round(v * 100);
  }
  return cents / 100;
}
