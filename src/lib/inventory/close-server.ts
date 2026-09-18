/**
 * Server side of the inventory monthly close: the close computation (rollback
 * roll-forward + suggested JEs vs. QB book balances) plus draft persistence in
 * the payroll journal store — kind 'inventory', pay_group 'INV CLOSE' — so the
 * close gets the same Generate → Approve → Post workflow as every other JE.
 *
 * Server-only (pulls in `pg` and the QuickBooks client). The pure derivations
 * (roll-forward math, JE lines, doc numbers) stay in ./monthly-close so client
 * components can share them.
 */
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { getRdsPool } from '../rds';
import { getBalanceSheetInventory } from '../quickbooks-multi';
import { QB_LOCATIONS, QB_TO_RDS_LOCATION } from '../qb-links';
import { fetchDimensions } from '../payroll/qb-journal';
import {
  buildRollForward,
  buildLocationJE,
  invCloseDocNumber,
  buildCategoryRollForward,
  buildCategoryJE,
  categoryJournalEntryLinesWithSources,
  buildOpeningCorrectionRows,
  openingCorrectionLines,
  openingCorrectionDocNumber,
  INV_OPEN_PAY_GROUP,
  INV_CLOSE_PAY_GROUP,
  OPENING_CORRECTION_NOTE,
  type RollbackMonthValue,
  type CategoryLedgerValue,
} from './monthly-close';
import {
  correctionOffsetAccount,
  CORRECTION_MONTH,
  CUTOVER_MONTH,
  monthlyCloseLock,
  correctionIndex,
  correctionSegment,
  invCloseCorrectionDocNumber,
  invCloseCorrectionNote,
} from './monthly-close';
import { labSuppliesContributionFor } from './lab-supplies-server';
import { shippingReliefContributionFor } from './shipping-relief-server';
import { correctionOrderLock } from './close-drift-server';
import { SHIPPING_SNAPSHOT_OUTCOME } from './je-detail-shipping-pool';
import { saveSourceSnapshot } from '../payroll/store';
import { assemblePool, type JeContribution } from './je-pool';
import {
  fetchCategoryCogsSeries,
  fetchCategoryLedgerValues,
  fetchFirstAnchoredMonth,
} from './ledger-values';
import {
  saveDraft,
  loadDraft,
  insertAudit,
  toHeader,
  type HeaderRow,
  type PayrollHeader,
} from '../payroll/store';
import type { Entity, JournalDraft, JournalLine } from '../payroll/types';
import type {
  CategoryJE,
  CategoryCogsSeriesRow,
  CategoryRollForwardRow,
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  MonthlyCloseResponse,
  OpeningCorrection,
  OpeningCorrectionLocation,
} from '@/types/inventory';

/** One draft set per month — the conflict key (entity, pay_date, INV CLOSE, '')
 *  means regenerating on the other basis REPLACES the unposted drafts rather
 *  than creating a second postable set of the same economic adjustment. */
// Canonical in monthly-close.ts (pure); re-exported so existing importers keep their site.
export { INV_CLOSE_PAY_GROUP };

/** 'YYYY-MM' → last day of that month as 'YYYY-MM-DD', or null when malformed. */
export function monthEndDate(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10); // 1..12
  if (mon < 1 || mon > 12) return null;
  const last = new Date(Date.UTC(year, mon, 0));
  return last.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'MM/DD/YYYY' — the store's pay_date convention. */
function isoToAdp(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

interface RollbackCloseRow {
  as_of_month: string;
  location: string;
  value_floor: number | null;
  value_full: number | null;
  purchases_floor: number | null;
  purchases_full: number | null;
}

function toMonthValue(r: RollbackCloseRow): RollbackMonthValue {
  return {
    location: r.location,
    valueFloor: r.value_floor,
    valueFull: r.value_full,
    purchasesFloor: r.purchases_floor,
    purchasesFull: r.purchases_full,
  };
}

const HEADER_SELECT = `SELECT id, entity, pay_date, pay_group, period_start, period_end, status,
        total_debits, total_credits, variance, row_count, source_snapshot_hash,
        qb_entry_id, qb_doc_number, kind, period_segment, to_char(txn_date,'YYYY-MM-DD') AS txn_date
 FROM accounting.payroll_journal_headers`;

export async function listInvCloseHeaders(monthEnd: string): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `${HEADER_SELECT}
     WHERE pay_group = $1 AND kind = 'inventory' AND pay_date = $2
     ORDER BY entity`,
    [INV_CLOSE_PAY_GROUP, isoToAdp(monthEnd)],
  );
  return rows.map(toHeader);
}

/** Regeneration replace-semantics (mirrors eom-store): drop unposted drafts for
 *  locations the rebuild no longer produces. Posted headers are never deleted. */
export async function deleteUnpostedInvCloseHeaders(
  monthEnd: string,
  keepEntities: Entity[],
): Promise<number> {
  const { rowCount } = await getRdsPool().query(
    `DELETE FROM accounting.payroll_journal_headers
     WHERE pay_group = $1 AND kind = 'inventory' AND pay_date = $2
       AND period_segment = ''
       AND status <> 'posted' AND NOT (entity = ANY($3::text[]))`,
    [INV_CLOSE_PAY_GROUP, isoToAdp(monthEnd), keepEntities],
  );
  return rowCount ?? 0;
}

// The ledger read moved to ./ledger-values so the close and the FIFO valuation
// page share ONE definition of the category grain rather than two queries that
// merely ought to agree. Re-exported here for existing importers.
export { fetchCategoryLedgerValues };

/** The close computation without stored drafts — shared by GET and generate. */
export async function computeClose(
  month: string,
  basis: CloseBasis,
  monthEnd: string,
): Promise<
  Pick<MonthlyCloseResponse, 'purchasesAvailable' | 'rollForward' | 'journalEntries'> & {
    categoryRollForward: CategoryRollForwardRow[];
    categoryCogsSeries: CategoryCogsSeriesRow[];
    firstAnchoredMonth: string | null;
    categoryJournalEntries: CategoryJE[];
    categoryUnavailable: string | null;
    accountNumbers: Record<string, Record<string, string>>;
  }
> {
  const pool = getRdsPool();
  // FullyQualifiedName -> AcctNum per location, captured from the dimension read
  // the category JE already needs, so the screen can label lines by number.
  const accountNumbers: Record<string, Record<string, string>> = {};

  const exists = await pool.query<{ regclass: string | null }>(
    `SELECT to_regclass('inventory.fifo_rollback_valuation')::text AS regclass`,
  );
  if (!exists.rows[0]?.regclass) {
    return {
      purchasesAvailable: false,
      rollForward: [],
      journalEntries: [],
      categoryRollForward: [],
      categoryCogsSeries: [],
      firstAnchoredMonth: null,
      categoryJournalEntries: [],
      accountNumbers: {},
      categoryUnavailable: null,
    };
  }

  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'inventory' AND table_name = 'fifo_rollback_valuation'
       AND column_name IN ('purchases_floor', 'purchases_full')`,
  );
  const colNames = new Set(cols.rows.map((c) => c.column_name));
  const purchasesAvailable = colNames.has('purchases_floor') && colNames.has('purchases_full');
  const purchasesFloorExpr = purchasesAvailable ? 'purchases_floor::float8' : 'NULL::float8';
  const purchasesFullExpr = purchasesAvailable ? 'purchases_full::float8' : 'NULL::float8';

  const priorRes = await pool.query<{ as_of_month: string }>(
    `SELECT as_of_month FROM inventory.fifo_rollback_valuation
     WHERE as_of_month < $1
     ORDER BY as_of_month DESC
     LIMIT 1`,
    [month],
  );
  const priorMonth = priorRes.rows[0]?.as_of_month ?? null;

  const months = priorMonth ? [month, priorMonth] : [month];
  const result = await pool.query<RollbackCloseRow>(
    `SELECT as_of_month, location,
            value_floor::float8 AS value_floor,
            value_full::float8  AS value_full,
            ${purchasesFloorExpr} AS purchases_floor,
            ${purchasesFullExpr}  AS purchases_full
     FROM inventory.fifo_rollback_valuation
     WHERE as_of_month = ANY($1)
     ORDER BY as_of_month, location`,
    [months],
  );

  const currentRows = result.rows.filter((r) => r.as_of_month === month).map(toMonthValue);
  const priorRows = priorMonth
    ? result.rows.filter((r) => r.as_of_month === priorMonth).map(toMonthValue)
    : null;

  if (currentRows.length === 0) {
    return {
      purchasesAvailable,
      rollForward: [],
      journalEntries: [],
      categoryCogsSeries: [],
      firstAnchoredMonth: null,
      categoryRollForward: [],
      categoryJournalEntries: [],
      categoryUnavailable: null,
      accountNumbers: {},
    };
  }

  const rollForward = buildRollForward(currentRows, priorRows, basis, purchasesAvailable);

  const locationRows = rollForward.filter((r) => r.cut === 'location');
  const journalEntries = await Promise.all(
    locationRows.map(async (row) => {
      const fifoTarget = row.ending;
      // Rollback rows speak RDS naming ('MedRock Florida'); the QB client
      // speaks token naming ('MedRock FL'). An unmapped label (FOCAS has no
      // drug inventory) degrades to book-unavailable rather than a bad call.
      const qbLocation = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === row.label);
      if (qbLocation === undefined) {
        return buildLocationJE(row.label, fifoTarget, null, []);
      }
      const book = await getBalanceSheetInventory(qbLocation, monthEnd);
      return buildLocationJE(row.label, fifoTarget, book?.total ?? null, book?.accounts ?? []);
    }),
  );

  // ---- Category grain (lot-ledger sourced) -------------------------------
  // Best-effort for the READ path: a category-side failure must never take down
  // the location-grain close that has been shipping since July. But the WRITE
  // path (generateInvCloseDrafts) now generates from these entries, so a swallowed
  // failure there would delete every unposted draft and create none. The reason is
  // therefore REPORTED, not just logged — `categoryUnavailable` distinguishes
  // "the read broke" from "this month genuinely has no categories".
  // The prior month is read from the ledger itself (it has every month, unlike the
  // rollback table).
  let categoryRollForward: CategoryRollForwardRow[] = [];
  let categoryJournalEntries: CategoryJE[] = [];
  let categoryUnavailable: string | null = null;
  try {
    const priorLedgerRes = await pool.query<{ as_of_month: string }>(
      `SELECT as_of_month FROM inventory.lot_depletion_ledger
       WHERE as_of_month < $1
       ORDER BY as_of_month DESC
       LIMIT 1`,
      [month],
    );
    const priorLedgerMonth = priorLedgerRes.rows[0]?.as_of_month ?? null;

    const currentCats = await fetchCategoryLedgerValues(pool, month);
    const priorCats = priorLedgerMonth ? await fetchCategoryLedgerValues(pool, priorLedgerMonth) : null;
    categoryRollForward = buildCategoryRollForward(currentCats, priorCats);

    const locations = [...new Set(categoryRollForward.map((r) => r.location))];
    categoryJournalEntries = await Promise.all(
      locations.map(async (location) => {
        const qbLocation = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === location);
        if (qbLocation === undefined) {
          return buildCategoryJE(location, categoryRollForward, [], {}, false);
        }
        // Two QB reads per location: the balance sheet (per-sub-account balances,
        // named '1220.05 …') and the dimensions (FullyQualifiedName -> AcctNum),
        // which is the only way to bridge those two naming conventions.
        // BOTH catch: one location's realm rejecting must degrade THAT location to
        // bookAvailable=false, not reject the Promise.all and blank all three.
        const [book, refs] = await Promise.all([
          getBalanceSheetInventory(qbLocation, monthEnd).catch(() => null),
          fetchDimensions(qbLocation).catch(() => null),
        ]);
        if (refs !== null) accountNumbers[location] = refs.accountNums ?? {};
        if (book === null || refs === null) {
          return buildCategoryJE(location, categoryRollForward, [], {}, false);
        }
        return buildCategoryJE(location, categoryRollForward, book.accounts, refs.accountNums ?? {}, true);
      }),
    );
  } catch (categoryErr) {
    categoryUnavailable = categoryErr instanceof Error ? categoryErr.message : String(categoryErr);
    // A partial build must not look like a complete one — drop it entirely.
    categoryRollForward = [];
    categoryJournalEntries = [];
    console.warn('[inventory/close-server] category grain skipped:', categoryUnavailable);
  }

  // COGS by category by month, calendar-year-to-date — the shape the accountants
  // read the QuickBooks 5000.xx P&L in. Best-effort for the same reason the
  // category grain is: a failure here must not take down the close.
  let categoryCogsSeries: CategoryCogsSeriesRow[] = [];
  let firstAnchoredMonth: string | null = null;
  try {
    [categoryCogsSeries, firstAnchoredMonth] = await Promise.all([
      fetchCategoryCogsSeries(pool, `${month.slice(0, 4)}-01`, month),
      fetchFirstAnchoredMonth(pool),
    ]);
  } catch (seriesErr) {
    console.warn(
      '[inventory/close-server] COGS series skipped:',
      seriesErr instanceof Error ? seriesErr.message : seriesErr,
    );
  }

  return {
    purchasesAvailable,
    rollForward,
    journalEntries,
    categoryRollForward,
    categoryCogsSeries,
    firstAnchoredMonth,
    categoryJournalEntries,
    categoryUnavailable,
    accountNumbers,
  };
}

/**
 * CORRECTION to a posted month (ds-correction-entry-2026-09-15). Barbara, via Carson
 * 2026-09-15: "instead of just pull back and regenerate … do a regenerate and post a
 * correction journal entry, to catch any one offs".
 *
 * No new arithmetic: the close is `FIFO − book` per category and `target − posted`
 * for lab supplies, both read as of today. With the parent already in the book, the
 * recompute IS the delta. Saved as a second header on the same month with
 * period_segment 'C{n}' (n = posted corrections + 1) and doc `<parent>-{n+1}`.
 * Rules: posted parent required; an unposted correction draft is replaced; a zero
 * delta saves nothing; regular Generate stays locked and never touches these rows.
 */
export async function generateInvCloseCorrection(
  month: string,
  basis: CloseBasis,
  monthEnd: string,
  entity: Entity,
): Promise<
  | { headerId: number; docNumber: string; warnings: string[] }
  | { nothingToCorrect: true; warnings: string[] }
  | { locked: string }
> {
  const cutoverLock = monthlyCloseLock(month);
  if (cutoverLock !== null) return { locked: cutoverLock };

  const existing = (await listInvCloseHeaders(monthEnd)).filter((h) => h.entity === entity);
  const parent = existing.find((h) => correctionIndex(h.period_segment) === null);
  if (!parent || parent.status !== 'posted') {
    return { locked: `${entity}: no posted ${month} inventory entry to correct — post the month first, or regenerate it` };
  }
  // ORDER (ds-close-drift-guard-2026-09-18): month-end balances carry forward, so an
  // earlier month's gap or open correction must be settled before this one is drafted —
  // otherwise this correction books that gap too and it counts twice once corrected.
  const orderLock = await correctionOrderLock(entity, month);
  if (orderLock !== null) return { locked: orderLock };

  const corrections = existing.filter((h) => correctionIndex(h.period_segment) !== null);
  const postedCorrections = corrections.filter((h) => h.status === 'posted').length;
  const openDraft = corrections.find((h) => h.status !== 'posted');
  const index = postedCorrections + 1;

  const close = await computeClose(month, basis, monthEnd);
  if (close.categoryUnavailable !== null) {
    return { locked: `Category detail could not be read (${close.categoryUnavailable}) — nothing was generated` };
  }
  const qbLocation = QB_LOCATIONS.find((qb) => qb === entity);
  if (!qbLocation) return { locked: `${entity}: not an inventory company` };
  const location = QB_TO_RDS_LOCATION[qbLocation];
  const je = close.categoryJournalEntries.find((j) => j.location === location);
  if (!je) return { locked: `${entity}: no category detail for ${month}` };
  if (!je.bookAvailable) return { locked: `${entity}: QB book balance unavailable — no correction generated` };

  const warnings: string[] = [];
  const jeLines = categoryJournalEntryLinesWithSources(je, monthEnd);
  if (jeLines.find((l) => !l.mapped)) warnings.push(residualWarning(je.location, je.unmappedCategories));
  const [lab, ship] = await Promise.all([
    labSuppliesContributionFor(entity, month),
    shippingReliefContributionFor(entity, month, invCloseDocNumber(je.location, month)),
  ]);
  const pool = assemblePool([fifoCategoryContribution(je, monthEnd), lab.contribution, ship]);
  for (const w of pool.warnings) warnings.push(w);
  if (pool.unavailable.length > 0) {
    return { locked: `${entity}: ${pool.unavailable.join(', ')} could not compute — no correction generated` };
  }
  if (pool.lines.length === 0) {
    // Nothing moved since the parent posted. Drop a stale open draft if one exists.
    if (openDraft) {
      await getRdsPool().query(`DELETE FROM accounting.payroll_journal_lines WHERE header_id = $1`, [openDraft.id]);
      await getRdsPool().query(`DELETE FROM accounting.payroll_journal_headers WHERE id = $1 AND status <> 'posted'`, [openDraft.id]);
    }
    return { nothingToCorrect: true, warnings };
  }
  if (pool.variance !== 0) {
    return { locked: `${entity}: correction does not balance (variance ${pool.variance.toFixed(2)}) — no correction generated` };
  }
  // An open draft under a DIFFERENT index (a correction posted since it was built)
  // would collide with nothing but mislead; replace it with the fresh one.
  if (openDraft && openDraft.period_segment !== correctionSegment(index)) {
    await getRdsPool().query(`DELETE FROM accounting.payroll_journal_lines WHERE header_id = $1`, [openDraft.id]);
    await getRdsPool().query(`DELETE FROM accounting.payroll_journal_headers WHERE id = $1 AND status <> 'posted'`, [openDraft.id]);
  }

  const entityHash = createHash('sha256')
    .update(JSON.stringify({ basis, correctionOf: parent.qb_doc_number, index, categoryJournalEntry: je, lab: lab.snapshot, shipping: ship.snapshot }))
    .digest('hex');
  const docNumber = invCloseCorrectionDocNumber(je.location, month, index);
  const draft: JournalDraft = {
    entity,
    kind: 'inventory',
    payDate: isoToAdp(monthEnd),
    payGroup: INV_CLOSE_PAY_GROUP,
    periodStart: `${month}-01`,
    periodEnd: monthEnd,
    periodSegment: correctionSegment(index),
    docNumber,
    txnDate: monthEnd,
    privateNote: invCloseCorrectionNote(je.location, month, index),
    lines: pool.lines,
    totalDebits: pool.totalDebits,
    totalCredits: pool.totalCredits,
    variance: pool.variance,
    rowKeys: [],
  };
  const headerId = await saveDraft(draft, entityHash);
  await insertAudit({
    headerId,
    mode: 'dry_run',
    entity,
    outcome: 'generated',
    reason: `correction ${index} to ${parent.qb_doc_number ?? `#${parent.id}`} generated for ${month} (${basis} basis)`,
  });
  if (lab.snapshot !== null) {
    try {
      await saveSourceSnapshot(headerId, entity, lab.snapshot);
    } catch (error) {
      console.warn(`[inventory/close-server] lab basis not retained for correction ${docNumber}:`, error);
    }
  }
  if (ship.snapshot !== null) {
    try {
      await saveSourceSnapshot(headerId, entity, ship.snapshot, SHIPPING_SNAPSHOT_OUTCOME);
    } catch (error) {
      console.warn(`[inventory/close-server] shipping basis not retained for correction ${docNumber}:`, error);
    }
  }
  return { headerId, docNumber, warnings };
}

/** header id → ISO time of its latest `generated` audit row (see generateInvCloseDrafts). */
async function lastGeneratedAt(headerIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (headerIds.length === 0) return out;
  const { rows } = await getRdsPool().query<{ header_id: string; at: string }>(
    `SELECT header_id::text, to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM accounting.payroll_post_audit
      WHERE header_id = ANY($1::bigint[]) AND outcome = 'generated'
      GROUP BY header_id`,
    [headerIds],
  );
  for (const r of rows) out.set(Number(r.header_id), r.at);
  return out;
}

/** Stored drafts for the month, shaped for the client. */
export async function loadStoredDrafts(
  monthEnd: string,
): Promise<{ headers: InvCloseHeader[]; linesById: Record<string, InvCloseLine[]> }> {
  const stored = await listInvCloseHeaders(monthEnd);
  const generatedAt = await lastGeneratedAt(stored.map((h) => h.id));
  const headers: InvCloseHeader[] = stored.map((h) => ({
    id: h.id,
    entity: h.entity,
    status: h.status,
    qb_doc_number: h.qb_doc_number,
    txn_date: h.txn_date,
    total_debits: h.total_debits,
    total_credits: h.total_credits,
    variance: h.variance,
    generated_at: generatedAt.get(h.id) ?? null,
    period_segment: h.period_segment,
  }));
  const linesById: Record<string, InvCloseLine[]> = {};
  for (const h of stored) {
    const loaded = await loadDraft(h.id);
    linesById[String(h.id)] = (loaded?.lines ?? []).map((l) => ({
      postingType: l.postingType,
      amount: l.amount,
      accountName: l.accountName,
      memo: l.memo,
    }));
  }
  return { headers, linesById };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The residual-line warning, with advice that fits the bucket it names.
 *
 * The old text told the accountant to "assign drug codes to clear" whatever was in
 * the residual. That is right for `Uncoded` and IMPOSSIBLE for `Opening Balance`:
 * OB rows are pre-history pseudo-receipts with no `purchase_lots` row at all, so
 * there is no product to code. Measured 2026-03, Florida's entire residual was
 * Opening Balance ($4,212.00) while Uncoded sat at $0.00 — the message sent them
 * after the empty bucket with an instruction that could not work on the full one.
 *
 * Exported for the test that pins each bucket's advice.
 */
/**
 * The FIFO category adjustment as a pool contributor.
 *
 * Pure: it takes an already-computed `CategoryJE` and shapes its Dr/Cr pairs into
 * journal lines. `available` is the book-balance question — without a QuickBooks
 * balance sheet there is nothing to adjust TOWARDS, so the pool must not post.
 */
export function fifoCategoryContribution(je: CategoryJE, monthEnd: string): JeContribution {
  const jeLines = je.bookAvailable ? categoryJournalEntryLinesWithSources(je, monthEnd) : [];
  return {
    source: 'fifo-category',
    label: 'FIFO category adjustment',
    available: je.bookAvailable,
    warnings: [],
    lines: jeLines.map((l) => ({
      postingType: l.debit !== null ? 'Debit' : 'Credit',
      amount: round2(l.debit ?? l.credit ?? 0),
      accountName: l.account,
      departmentName: null,
      className: null,
      memo: l.memo,
      creditBucket: null,
      origin: 'generated',
      sourceRowKeys: l.receiptIds,
    })),
  };
}

export function residualWarning(location: string, categories: readonly string[]): string {
  const listed = categories.length > 0 ? categories.join(', ') : 'one or more categories';
  const advice: string[] = [];
  if (categories.includes('Uncoded')) {
    advice.push("'Uncoded' clears by assigning drug codes to those products");
  }
  if (categories.includes('Opening Balance')) {
    advice.push(
      "'Opening Balance' is pre-history stock carrying no product record, so it cannot be coded — " +
        'it clears as those lots deplete, or by attributing them to the category their own product ' +
        'already carries',
    );
  }
  return (
    `${location}: ${listed} ${categories.length === 1 ? 'has' : 'have'} no QuickBooks category ` +
    'account — posted to the parent Inventory Asset / Cost of Goods Sold as ONE combined residual ' +
    `line${advice.length > 0 ? `. ${advice.join('; ')}` : ''}`
  );
}


/**
 * Generate (or regenerate) the month's inventory-close drafts from the current
 * close numbers. Locked once any draft for the month has posted — mirroring the
 * EOM generate gate, the accountant must un-post in QuickBooks first.
 */
export async function generateInvCloseDrafts(
  month: string,
  basis: CloseBasis,
  monthEnd: string,
): Promise<{ savedEntities: Entity[]; warnings: string[] } | { locked: string }> {
  // HARD LOCK: no monthly close at or before the year-end correction month. The
  // two stale December 2025 drafts deleted 2026-09-15 were exactly this — the
  // same true-up as the posted correction, drafted a second time.
  const cutoverLock = monthlyCloseLock(month);
  if (cutoverLock !== null) return { locked: cutoverLock };

  const existing = await listInvCloseHeaders(monthEnd);
  const posted = existing.filter((h) => h.status === 'posted');
  if (posted.length > 0) {
    const docNumbers = posted.map((h) => h.qb_doc_number ?? `#${h.id}`).join(', ');
    return { locked: `month has posted inventory-close JEs — regeneration locked (${docNumbers})` };
  }

  const close = await computeClose(month, basis, monthEnd);

  // The category read FAILED (as opposed to this month genuinely having no
  // categories). Generating from an empty list would save nothing and then hand
  // deleteUnpostedInvCloseHeaders an empty keep-list — wiping every non-posted
  // header for the month, APPROVED ones included, with nothing on screen to say
  // why. Refuse to touch stored drafts and report the reason instead.
  if (close.categoryUnavailable !== null) {
    return {
      savedEntities: [],
      warnings: [
        `Category detail could not be read (${close.categoryUnavailable}) — nothing was generated and ` +
          'existing drafts were left untouched. Retry once QuickBooks / the lot ledger is reachable.',
      ],
    };
  }

  const warnings: string[] = [];
  const savedEntities: Entity[] = [];
  const payDate = isoToAdp(monthEnd);

  for (const je of close.categoryJournalEntries) {
    const entity = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === je.location);
    if (entity === undefined) continue;
    if (!je.bookAvailable) {
      warnings.push(`${je.location}: QB book balance unavailable — no draft generated`);
      continue;
    }
    const jeLines = categoryJournalEntryLinesWithSources(je, monthEnd);
    // Gate on a residual line HAVING BEEN EMITTED, not on unmappedCategories
    // being non-empty: an unmapped category whose combined adjustment nets to zero
    // (TX 'Uncoded' in 2026-03 — every remaining_value NULL) posts nothing, and
    // claiming otherwise sends the accountant looking for a line that isn't there.
    const residualLine = jeLines.find((l) => !l.mapped);
    if (residualLine) {
      warnings.push(residualWarning(je.location, je.unmappedCategories));
    }

    // ONE entry per (entity, month): FIFO plus the lab-supplies accrual, pooled.
    // Carson, 2026-09-14: "fold lab supplies into the main journal entry, not a
    // separate piece, so it generates on journal entry generation." The lab
    // contributor books target − posted (ds-one-inventory-je §3), so no reversal
    // and no second entry. See docs/fifo-monthly-close/ds-one-inventory-je-2026-09-03.md.
    // Shipping packaging relief joins the same entry (Carson, 2026-09-18: "get it going with
    // inventory journals") — Barbara's postage-ratio method, see ds-shipping-relief-2026-09-18.
    const [lab, ship] = await Promise.all([
      labSuppliesContributionFor(entity, month),
      shippingReliefContributionFor(entity, month, invCloseDocNumber(je.location, month)),
    ]);
    const pool = assemblePool([fifoCategoryContribution(je, monthEnd), lab.contribution, ship]);
    for (const w of pool.warnings) warnings.push(w);
    if (pool.unavailable.length > 0) {
      // A partial read must never become a posted number — the whole entry waits.
      warnings.push(`${je.location}: ${pool.unavailable.join(', ')} could not compute — no draft generated`);
      continue;
    }
    if (pool.lines.length === 0) {
      warnings.push(`${je.location}: no adjustment needed (FIFO ties to book, lab accrual stands, no shipping relief) — no draft generated`);
      continue;
    }
    if (pool.variance !== 0) {
      warnings.push(`${je.location}: pooled entry does not balance (variance ${pool.variance.toFixed(2)}) — no draft generated`);
      continue;
    }
    const lines = pool.lines;
    const totalDebits = pool.totalDebits;
    const totalCredits = pool.totalCredits;
    // Per entity, and including the lab basis: a moved estimate must invalidate
    // the draft exactly as a moved category value does.
    const entityHash = createHash('sha256')
      .update(JSON.stringify({ basis, categoryJournalEntry: je, lab: lab.snapshot, shipping: ship.snapshot }))
      .digest('hex');
    const draft: JournalDraft = {
      entity,
      kind: 'inventory',
      payDate,
      payGroup: INV_CLOSE_PAY_GROUP,
      periodStart: `${month}-01`,
      periodEnd: monthEnd,
      periodSegment: '',
      docNumber: invCloseDocNumber(je.location, month),
      txnDate: monthEnd,
      privateNote: `Inventory FIFO close adjustment — ${month} (category detail, lot-level; lab supplies accrual and shipping packaging relief pooled)`,
      lines,
      totalDebits,
      totalCredits,
      variance: pool.variance,
      rowKeys: [],
    };
    const headerId = await saveDraft(draft, entityHash);
    // Stamp the generation in the audit trail. The header's updated_at also moves
    // on approve / post, so it cannot say when the NUMBERS were last built; this
    // row can. Carson, 2026-09-15: "a generated date/time stamp next to the
    // generate button … that does not update until generate is successful".
    await insertAudit({
      headerId,
      mode: 'dry_run',
      entity,
      outcome: 'generated',
      reason: `drafts generated for ${month} (${basis} basis)`,
    });
    // RETAIN THE LAB BASIS on the header: completeness is a function of the day
    // QuickBooks was read, so the workbook must print what was retained, never a
    // re-pull. Best-effort — a failed snapshot costs the basis sheet, not the entry.
    if (lab.snapshot !== null) {
      try {
        await saveSourceSnapshot(headerId, entity, lab.snapshot);
      } catch (error) {
        console.warn(`[inventory/close-server] lab basis not retained for ${je.location} ${month}:`, error);
      }
    }
    if (ship.snapshot !== null) {
      try {
        await saveSourceSnapshot(headerId, entity, ship.snapshot, SHIPPING_SNAPSHOT_OUTCOME);
      } catch (error) {
        console.warn(`[inventory/close-server] shipping basis not retained for ${je.location} ${month}:`, error);
      }
    }
    savedEntities.push(entity);
  }

  await deleteUnpostedInvCloseHeaders(monthEnd, savedEntities);
  return { savedEntities, warnings };
}

// ---------------------------------------------------------------------------
// OPENING CORRECTION — the one-time JE that trues book to FIFO.
//
// Dated 2025-12-31 as a 13th-month entry (Ash, relayed by Barbara 2026-09-14;
// Carson: "large adjustment in December so all of 2026 is smooth"). It was
// 2026-03-01 under the 08-26 proposal; see ds-year-end-correction-2025-12.md.
// Book balances read as of 12/31; FIFO target read from the 2025-12 lot ledger,
// which must be COUNT-ANCHORED for the figure to mean anything — until the
// loader pins its anchor start at 2025-12, the December ledger is the
// unanchored roll-forward and this card must not be posted. Drafts stored under
// pay_group 'INV OPEN' with pay_date 2025-12-31 so they never collide with the
// monthly close's month-end drafts (which start at CUTOVER_MONTH).
// ---------------------------------------------------------------------------

// CORRECTION_MONTH / CUTOVER_MONTH are canonical in monthly-close.ts (pure) so the
// client tab can read them; re-exported here so existing callers keep their import site.
export { CORRECTION_MONTH, CUTOVER_MONTH };
const OPENING_DATE = '2025-12-31';
const BOOK_AS_OF = '2025-12-31';
// Canonical in monthly-close.ts (pure) — je-identity needs it and must not import this
// module's RDS/QuickBooks deps. Re-exported so existing callers keep their import site.
export { INV_OPEN_PAY_GROUP };

export async function listOpeningCorrectionHeaders(): Promise<PayrollHeader[]> {
  const { rows } = await getRdsPool().query<HeaderRow>(
    `${HEADER_SELECT}
     WHERE pay_group = $1 AND kind = 'inventory' AND pay_date = $2
     ORDER BY entity`,
    [INV_OPEN_PAY_GROUP, isoToAdp(OPENING_DATE)],
  );
  return rows.map(toHeader);
}

interface CorrectionComputation {
  locations: OpeningCorrectionLocation[];
  /** Server-side detail generation needs (per RDS location). */
  detail: Map<
    string,
    { rows: ReturnType<typeof buildOpeningCorrectionRows>; bookAvailable: boolean; offsetFound: boolean }
  >;
}

async function computeCorrectionLocations(): Promise<CorrectionComputation> {
  const pool = getRdsPool();
  const categoryValues: CategoryLedgerValue[] = await fetchCategoryLedgerValues(pool, CORRECTION_MONTH);

  const locations: OpeningCorrectionLocation[] = [];
  const detail: CorrectionComputation['detail'] = new Map();
  for (const qbLocation of QB_LOCATIONS) {
    const rdsLocation = QB_TO_RDS_LOCATION[qbLocation];
    const [book, refs] = await Promise.all([
      getBalanceSheetInventory(qbLocation, BOOK_AS_OF).catch(() => null),
      fetchDimensions(qbLocation).catch(() => null),
    ]);
    const bookAvailable = book !== null && refs !== null;
    const accountNums = refs?.accountNums ?? {};
    const rows = bookAvailable
      ? buildOpeningCorrectionRows(rdsLocation, categoryValues, book.accounts, accountNums)
      : [];
    // Every row offsets to its PAIRED COGS account (no dedicated correction
    // account — Carson, 2026-09-14). The draft is refused if any of those is
    // missing from this company's chart, so the post can never throw
    // `unresolved account` on a line the reviewer already approved.
    const offsetFound =
      bookAvailable && rows.every((row) => correctionOffsetAccount(row) in accountNums);
    detail.set(rdsLocation, { rows, bookAvailable, offsetFound });
    locations.push({
      location: rdsLocation,
      bookAvailable,
      offsetFound,
      accountNumbers: accountNums,
      rows: rows.map((row) => {
        const offsetAccount = correctionOffsetAccount(row);
        return {
          qbCategory: row.qbCategory,
          account: row.account,
          accountNumber: accountNums[row.account] ?? null,
          offsetAccount,
          offsetAccountNumber: accountNums[offsetAccount] ?? null,
          book: row.book,
          fifo: row.fifo,
          adjustment: row.adjustment,
          mapped: row.mapped,
        };
      }),
      netAdjustment: round2(rows.reduce((s, r) => s + r.adjustment, 0)),
    });
  }
  return { locations, detail };
}

/** The correction card's data: computed rows + stored drafts. */
export async function computeOpeningCorrection(): Promise<OpeningCorrection> {
  const { locations } = await computeCorrectionLocations();
  const stored = await listOpeningCorrectionHeaders();
  const generatedAt = await lastGeneratedAt(stored.map((h) => h.id));
  const headers: InvCloseHeader[] = stored.map((h) => ({
    id: h.id,
    entity: h.entity,
    status: h.status,
    qb_doc_number: h.qb_doc_number,
    txn_date: h.txn_date,
    total_debits: h.total_debits,
    total_credits: h.total_credits,
    variance: h.variance,
    generated_at: generatedAt.get(h.id) ?? null,
    period_segment: h.period_segment,
  }));
  const linesById: Record<string, InvCloseLine[]> = {};
  for (const h of stored) {
    const loaded = await loadDraft(h.id);
    linesById[String(h.id)] = (loaded?.lines ?? []).map((l) => ({
      postingType: l.postingType,
      amount: l.amount,
      accountName: l.accountName,
      memo: l.memo,
    }));
  }
  return {
    cutoverMonth: CUTOVER_MONTH,
    openingDate: OPENING_DATE,
    bookAsOf: BOOK_AS_OF,
    offsetAccount: 'its paired Cost of Goods Sold sub-account (parent COGS for the residual)',
    locations,
    headers,
    linesById,
  };
}

/**
 * Generate (or regenerate) the opening-correction drafts. Locked once any
 * correction has posted (a posted cutover is final — un-post in QuickBooks
 * first). A company whose chart lacks the offset account gets a warning and no
 * draft: without it the post would throw `unresolved account` anyway, and a
 * draft that cannot post is a trap for the reviewer.
 */
export async function generateOpeningCorrectionDrafts(): Promise<
  { savedEntities: Entity[]; warnings: string[] } | { locked: string }
> {
  const existing = await listOpeningCorrectionHeaders();
  const posted = existing.filter((h) => h.status === 'posted');
  if (posted.length > 0) {
    const docNumbers = posted.map((h) => h.qb_doc_number ?? `#${h.id}`).join(', ');
    return { locked: `the opening correction has posted — regeneration locked (${docNumbers})` };
  }

  const { detail } = await computeCorrectionLocations();
  const warnings: string[] = [];
  const savedEntities: Entity[] = [];
  const payDate = isoToAdp(OPENING_DATE);

  for (const qbLocation of QB_LOCATIONS) {
    const rdsLocation = QB_TO_RDS_LOCATION[qbLocation];
    const d = detail.get(rdsLocation);
    if (!d || !d.bookAvailable) {
      warnings.push(`${rdsLocation}: QB book balance unavailable — no correction draft generated`);
      continue;
    }
    if (!d.offsetFound) {
      const missing = d.rows
        .map((row) => correctionOffsetAccount(row))
        .filter((account, i, all) => all.indexOf(account) === i);
      warnings.push(
        `${rdsLocation}: a paired COGS account is missing from the chart of accounts ` +
          `(needs ${missing.join(', ')}) — no correction draft generated`,
      );
      continue;
    }
    const jeLines = openingCorrectionLines(d.rows, BOOK_AS_OF);
    if (jeLines.length === 0) {
      warnings.push(`${rdsLocation}: book already ties to the FIFO opening — no correction needed`);
      continue;
    }
    const lines: JournalLine[] = jeLines.map((l) => ({
      postingType: l.debit !== null ? 'Debit' : 'Credit',
      amount: round2(l.debit ?? l.credit ?? 0),
      accountName: l.account,
      departmentName: null,
      className: null,
      memo: l.memo,
      creditBucket: null,
      origin: 'generated',
      sourceRowKeys: l.receiptIds,
    }));
    const totalDebits = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const totalCredits = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({ correction: rdsLocation, rows: d.rows }))
      .digest('hex');
    const draft: JournalDraft = {
      entity: qbLocation,
      kind: 'inventory',
      payDate,
      payGroup: INV_OPEN_PAY_GROUP,
      periodStart: OPENING_DATE,
      periodEnd: OPENING_DATE,
      periodSegment: '',
      docNumber: openingCorrectionDocNumber(rdsLocation, CORRECTION_MONTH),
      txnDate: OPENING_DATE,
      privateNote:
        `${OPENING_CORRECTION_NOTE}. ` +
        'See docs/fifo-monthly-close/ds-year-end-correction-2025-12.md.',
      lines,
      totalDebits,
      totalCredits,
      variance: round2(totalDebits - totalCredits),
      rowKeys: [],
    };
    const headerId = await saveDraft(draft, snapshotHash);
    await insertAudit({
      headerId,
      mode: 'dry_run',
      entity: qbLocation,
      outcome: 'generated',
      reason: `year-end correction drafts generated (${CORRECTION_MONTH})`,
    });
    savedEntities.push(qbLocation);
  }

  // Replace-semantics mirror of deleteUnpostedInvCloseHeaders, on the INV OPEN key.
  await getRdsPool().query(
    `DELETE FROM accounting.payroll_journal_headers
     WHERE pay_group = $1 AND kind = 'inventory' AND pay_date = $2
       AND status <> 'posted' AND NOT (entity = ANY($3::text[]))`,
    [INV_OPEN_PAY_GROUP, isoToAdp(OPENING_DATE), savedEntities],
  );
  return { savedEntities, warnings };
}
