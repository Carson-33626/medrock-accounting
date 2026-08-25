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
import { EOM_ENTITIES, type EomEntity } from './revenue-rule';

// entity: Entity (not EomEntity) because eomDocNumber is also called from eom/post/route.ts
// with header.entity, which is a plain DB column typed Entity — the route can't statically
// prove a posted allocation header's entity excludes FOCAS. FOCAS key satisfies the
// exhaustive Record; EOM generation itself stays trio-only via EOM_ENTITIES/EomEntity below,
// so the FOCAS entry is never actually looked up by buildMonthEndAllocation.
const SHORT_ENT: Record<Entity, string> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX', 'FOCAS': 'FOCAS' };
const RULE_LABEL: Record<string, string> = { revenue: 'revenue %', thirds: '1/3', fifty: '50/50', passthrough: '100%' };

export function eomDocNumber(entity: Entity, m: Month): string {
  return `${SHORT_ENT[entity]} % Allo ${monthTag(m)}`;
}

/** Hard rule cutoff (Ash via Carson, 2026-08-25): the CS revenue split applies from
 *  April 2026 forward. Before that, EVERYTHING pooled splits 1/3 — which is also what the
 *  posted pre-April history actually did, so regenerated early months tie to the books. */
export const CS_REVENUE_FROM: Month = { year: 2026, month: 4 };
export function usesRevenueRule(m: Month): boolean {
  return m.year > CS_REVENUE_FROM.year ||
    (m.year === CS_REVENUE_FROM.year && m.month >= CS_REVENUE_FROM.month);
}
/** Names the basis on the entry itself. The old text said "Revenue rule: FL 33.33% / TN
 *  33.33% / TX 33.33%" every single month — the presence rule always returned thirds, so
 *  the note asserted a revenue split that was never performed. It now prints the real
 *  revenue weights, and says which pool they applied to (per Ash 2026-08-25: CS by
 *  revenue, Admin/Accounting a third each, marketing stays with its employer). */
export function eomPrivateNote(
  shares: Record<EomEntity, number>, m: Month, csAlloDocs?: readonly string[],
): string {
  // When the month's Customer Service is already allocated by posted CS Allo entries, this
  // entry deliberately excludes it — say so on the entry, naming the docs that carry it.
  const csSuffix = csAlloDocs !== undefined && csAlloDocs.length > 0
    ? ` Customer Service labor is EXCLUDED here — already allocated by ${csAlloDocs.join(', ')}.`
    : '';
  if (!usesRevenueRule(m)) {
    return (
      `Month-end allocation — ${longMonthName(m)} ${m.year}. ` +
      `Pooled shared labor and costs split 1/3 each (pre-April 2026 rule; the CS revenue ` +
      `split begins April 2026). Directed costs (50/50 and passthrough) follow their class tag.` +
      csSuffix
    );
  }
  const pct = EOM_ENTITIES.map((e) => `${SHORT_ENT[e]} ${shares[e].toFixed(2)}%`).join(' / ');
  return (
    `Month-end allocation — ${longMonthName(m)} ${m.year}. ` +
    `Customer Service labor allocated as a % of revenue: ${pct}. ` +
    `Admin and Accounting labor split 1/3 each. ` +
    `Directed costs (50/50 and passthrough) follow their class tag.` +
    csSuffix
  );
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
  pool: PoolLine[], shares: Record<EomEntity, number>, m: Month,
  opts?: { csAlloDocs?: readonly string[] },
): JournalDraft[] {
  // 1-2. Net cents per (entity, account, rule, counterparty)
  const groups = new Map<string, { entity: Entity; accountName: string; rule: string; counterparty: Entity | null; cents: number }>();
  for (const l of pool) {
    // passthrough reaches here for Deposit/JournalEntry/DraftJE lines (qb-pool.isPooledLine) —
    // Bill/Purchase/VendorCredit passthrough is auto-booked by QBO Intercompany and must never re-move.
    if (l.rule !== 'revenue' && l.rule !== 'thirds' && l.rule !== 'fifty' && l.rule !== 'passthrough') continue;
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
    // The hard cutoff: before April 2026 the revenue rule did not exist — every pooled
    // cost (CS included, and Barbara's mixed 'Allocate - %' tags on posted early months)
    // splits 1/3, matching what the books did all along.
    const rule = g.rule === 'revenue' && !usesRevenueRule(m) ? 'thirds' : g.rule;
    const weights = EOM_ENTITIES.map((e) => {
      if (rule === 'revenue') return shares[e];
      if (rule === 'thirds') return 1;
      if (rule === 'passthrough') return e === g.counterparty ? 1 : 0; // 100% to the named entity
      return e === g.entity || e === g.counterparty ? 1 : 0; // fifty
    });
    const sign = g.cents >= 0 ? 1 : -1;
    const split = largestRemainderCents(Math.abs(g.cents), weights);
    const memo = `Allocation of ${leaf(g.accountName)} — ${RULE_LABEL[rule]} split`;
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
      privateNote: eomPrivateNote(shares, m, opts?.csAlloDocs),
      lines, totalDebits: dr, totalCredits: cr, variance, rowKeys: [],
    });
  }
  return drafts;
}
