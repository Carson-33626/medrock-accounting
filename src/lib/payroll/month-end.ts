/**
 * Month-end allocation JE generator. Turns the Allocate pool + the month's revenue
 * shares into (up to) one balanced draft per company, mirroring Amy's real JEs
 * (PR ALLO 2025.10 pattern): source credits its pooled accounts and debits the
 * inter-entity account per receiver; receivers debit the same account names and
 * credit their due-to. Pure — no I/O. See spec §4.3.
 */
import type { Entity, JournalDraft, JournalLine, PostingType } from './types';
import type { PoolLine } from './qb-pool';
import { largestRemainderCents } from './allocation';
import { ieAccountFor } from './inter-entity';
import { monthTag, monthEndIso, monthEndAdp, longMonthName, type Month } from './month';
import { EOM_ENTITIES } from './revenue-rule';

const SHORT_ENT: Record<Entity, string> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const RULE_LABEL: Record<string, string> = { revenue: 'revenue %', thirds: '1/3', fifty: '50/50' };

export function eomDocNumber(entity: Entity, m: Month): string {
  return `${SHORT_ENT[entity]} % Allo ${monthTag(m)}`;
}
export function eomPrivateNote(shares: Record<Entity, number>, m: Month): string {
  const pct = EOM_ENTITIES.map((e) => `${SHORT_ENT[e]} ${shares[e].toFixed(2)}%`).join(' / ');
  return `Month-end allocation — ${longMonthName(m)} ${m.year}. Revenue rule: ${pct}`;
}

const leaf = (account: string): string => account.split(':').pop()?.trim() ?? account;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function line(posting: PostingType, amountCents: number, accountName: string, memo: string): JournalLine {
  return {
    postingType: posting, amount: round2(amountCents / 100), accountName,
    departmentName: null, className: null, memo, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
  };
}

/** Signed cents `c` on account `acct`: positive cost sheds as a Credit at the source and
 *  lands as a Debit at the receiver; negative flips both. `dir` +1 = source side. */
function signedLine(c: number, acct: string, memo: string, side: 'source' | 'receiver'): JournalLine {
  const positive = c >= 0;
  const posting: PostingType =
    side === 'source' ? (positive ? 'Credit' : 'Debit') : (positive ? 'Debit' : 'Credit');
  return line(posting, Math.abs(c), acct, memo);
}

export function buildMonthEndAllocation(
  pool: PoolLine[], shares: Record<Entity, number>, m: Month,
): JournalDraft[] {
  // 1-2. Net cents per (entity, account, rule, counterparty)
  const groups = new Map<string, { entity: Entity; accountName: string; rule: string; counterparty: Entity | null; cents: number }>();
  for (const l of pool) {
    if (l.rule !== 'revenue' && l.rule !== 'thirds' && l.rule !== 'fifty') continue;
    const key = [l.entity, l.accountName, l.rule, l.counterparty ?? ''].join('¦');
    const g = groups.get(key) ?? { entity: l.entity, accountName: l.accountName, rule: l.rule, counterparty: l.counterparty, cents: 0 };
    g.cents += Math.round(l.amount * 100);
    groups.set(key, g);
  }

  // Per-entity accumulators: expense lines + net IE cents per counterparty
  const expenseLines = new Map<Entity, JournalLine[]>();
  const ieCents = new Map<Entity, Map<Entity, number>>(); // holder -> counterparty -> signed cents (+ = holder is owed)
  const addIe = (holder: Entity, cp: Entity, cents: number): void => {
    const inner = ieCents.get(holder) ?? new Map<Entity, number>();
    inner.set(cp, (inner.get(cp) ?? 0) + cents);
    ieCents.set(holder, inner);
  };
  const addLine = (e: Entity, l: JournalLine): void => {
    const arr = expenseLines.get(e) ?? [];
    arr.push(l);
    expenseLines.set(e, arr);
  };

  for (const g of groups.values()) {
    if (g.cents === 0) continue;
    const weights = EOM_ENTITIES.map((e) => {
      if (g.rule === 'revenue') return shares[e];
      if (g.rule === 'thirds') return 1;
      return e === g.entity || e === g.counterparty ? 1 : 0; // fifty
    });
    const sign = g.cents >= 0 ? 1 : -1;
    const split = largestRemainderCents(Math.abs(g.cents), weights);
    const memo = `Allocation of ${leaf(g.accountName)} — ${RULE_LABEL[g.rule]} split`;
    let sourceMoved = 0; // net cents shed by the holder across all receivers -> one source line
    EOM_ENTITIES.forEach((receiver, i) => {
      if (receiver === g.entity) return;
      const moved = sign * split[i];
      if (moved === 0) return;
      sourceMoved += moved;
      addLine(receiver, signedLine(moved, g.accountName, memo, 'receiver'));
      // Source is owed `moved` by receiver; receiver owes `moved` to source.
      addIe(g.entity, receiver, moved);
      addIe(receiver, g.entity, -moved);
    });
    if (sourceMoved !== 0) addLine(g.entity, signedLine(sourceMoved, g.accountName, memo, 'source'));
  }

  const drafts: JournalDraft[] = [];
  for (const entity of EOM_ENTITIES) {
    const lines = [...(expenseLines.get(entity) ?? [])];
    const ie = ieCents.get(entity);
    if (ie) {
      for (const [cp, cents] of ie) {
        if (cents === 0) continue;
        // + = this entity is owed by cp -> Debit its IE account; - = it owes -> Credit.
        lines.push(line(cents > 0 ? 'Debit' : 'Credit', Math.abs(cents), ieAccountFor(entity, cp), `Month-end allocation — net with ${SHORT_ENT[cp]}`));
      }
    }
    if (lines.length === 0) continue;
    const dr = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const cr = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    const variance = round2(dr - cr);
    if (variance !== 0) throw new Error(`month-end draft unbalanced: ${entity} ${variance}`);
    drafts.push({
      entity, kind: 'allocation', payDate: monthEndAdp(m), payGroup: 'EOM',
      periodStart: `${String(m.month).padStart(2, '0')}/01/${m.year}`, periodEnd: monthEndAdp(m),
      periodSegment: '', docNumber: eomDocNumber(entity, m), txnDate: monthEndIso(m),
      privateNote: eomPrivateNote(shares, m),
      lines, totalDebits: dr, totalCredits: cr, variance, rowKeys: [],
    });
  }
  return drafts;
}
