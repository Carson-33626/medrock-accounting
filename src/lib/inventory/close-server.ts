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
  type RollbackMonthValue,
  type CategoryLedgerValue,
} from './monthly-close';
import { CORRECTION_ACCOUNT } from './category-accounts';
import {
  fetchCategoryCogsSeries,
  fetchCategoryLedgerValues,
  fetchFirstAnchoredMonth,
} from './ledger-values';
import {
  saveDraft,
  loadDraft,
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
export const INV_CLOSE_PAY_GROUP = 'INV CLOSE';

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
  }
> {
  const pool = getRdsPool();

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
  };
}

/** Stored drafts for the month, shaped for the client. */
export async function loadStoredDrafts(
  monthEnd: string,
): Promise<{ headers: InvCloseHeader[]; linesById: Record<string, InvCloseLine[]> }> {
  const stored = await listInvCloseHeaders(monthEnd);
  const headers: InvCloseHeader[] = stored.map((h) => ({
    id: h.id,
    entity: h.entity,
    status: h.status,
    qb_doc_number: h.qb_doc_number,
    txn_date: h.txn_date,
    total_debits: h.total_debits,
    total_credits: h.total_credits,
    variance: h.variance,
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
 * Generate (or regenerate) the month's inventory-close drafts from the current
 * close numbers. Locked once any draft for the month has posted — mirroring the
 * EOM generate gate, the accountant must un-post in QuickBooks first.
 */
export async function generateInvCloseDrafts(
  month: string,
  basis: CloseBasis,
  monthEnd: string,
): Promise<{ savedEntities: Entity[]; warnings: string[] } | { locked: string }> {
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
  // Hash the CATEGORY entries — those are what generates now, so a change in a
  // category value must invalidate the draft.
  const snapshotHash = createHash('sha256')
    .update(JSON.stringify({ basis, categoryJournalEntries: close.categoryJournalEntries }))
    .digest('hex');

  for (const je of close.categoryJournalEntries) {
    const entity = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === je.location);
    if (entity === undefined) continue;
    if (!je.bookAvailable) {
      warnings.push(`${je.location}: QB book balance unavailable — no draft generated`);
      continue;
    }
    const jeLines = categoryJournalEntryLinesWithSources(je, monthEnd);
    if (jeLines.length === 0) {
      warnings.push(`${je.location}: no adjustment needed (FIFO ties to book) — no draft generated`);
      continue;
    }
    // Gate on a residual line HAVING BEEN EMITTED, not on unmappedCategories
    // being non-empty: an unmapped category whose combined adjustment nets to zero
    // (TX 'Uncoded' in 2026-03 — every remaining_value NULL) posts nothing, and
    // claiming otherwise sends the accountant looking for a line that isn't there.
    const residualLine = jeLines.find((l) => !l.mapped);
    if (residualLine) {
      warnings.push(
        `${je.location}: ${je.unmappedCategories.join(', ')} have no QuickBooks category account — ` +
          'posted to the parent Inventory Asset / Cost of Goods Sold as ONE combined residual line ' +
          '(assign drug codes to clear)',
      );
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
      privateNote: `Inventory FIFO close adjustment — ${month} (category detail, lot-level)`,
      lines,
      totalDebits,
      totalCredits,
      variance: round2(totalDebits - totalCredits),
      rowKeys: [],
    };
    await saveDraft(draft, snapshotHash);
    savedEntities.push(entity);
  }

  await deleteUnpostedInvCloseHeaders(monthEnd, savedEntities);
  return { savedEntities, warnings };
}

// ---------------------------------------------------------------------------
// OPENING CORRECTION — the one-time cutover JE (Carson's 2026-08-26 ruling:
// 2026-03 forward runs on the FIFO system). Book balances read at the settled
// stop point's eve; FIFO opening read from the prior month's lot ledger; drafts
// stored under pay_group 'INV OPEN' with pay_date 2026-03-01 so they never
// collide with the monthly close's month-end drafts.
// ---------------------------------------------------------------------------

export const CUTOVER_MONTH = '2026-03';
const CUTOVER_PRIOR_MONTH = '2026-02';
const OPENING_DATE = '2026-03-01';
const BOOK_AS_OF = '2026-02-28';
export const INV_OPEN_PAY_GROUP = 'INV OPEN';

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
  const categoryValues: CategoryLedgerValue[] = await fetchCategoryLedgerValues(pool, CUTOVER_PRIOR_MONTH);

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
    const offsetFound = CORRECTION_ACCOUNT in accountNums;
    detail.set(rdsLocation, { rows, bookAvailable, offsetFound });
    locations.push({
      location: rdsLocation,
      bookAvailable,
      offsetFound,
      rows: rows.map(({ qbCategory, account, book: b, fifo, adjustment, mapped }) => ({
        qbCategory,
        account,
        book: b,
        fifo,
        adjustment,
        mapped,
      })),
      netAdjustment: round2(rows.reduce((s, r) => s + r.adjustment, 0)),
    });
  }
  return { locations, detail };
}

/** The correction card's data: computed rows + stored drafts. */
export async function computeOpeningCorrection(): Promise<OpeningCorrection> {
  const { locations } = await computeCorrectionLocations();
  const stored = await listOpeningCorrectionHeaders();
  const headers: InvCloseHeader[] = stored.map((h) => ({
    id: h.id,
    entity: h.entity,
    status: h.status,
    qb_doc_number: h.qb_doc_number,
    txn_date: h.txn_date,
    total_debits: h.total_debits,
    total_credits: h.total_credits,
    variance: h.variance,
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
    offsetAccount: CORRECTION_ACCOUNT,
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
      warnings.push(
        `${rdsLocation}: offset account "${CORRECTION_ACCOUNT}" not found in the chart of accounts — ` +
          'create it (proposal §4) before generating this correction',
      );
      continue;
    }
    const jeLines = openingCorrectionLines(d.rows, CORRECTION_ACCOUNT, BOOK_AS_OF);
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
      docNumber: openingCorrectionDocNumber(rdsLocation, CUTOVER_MONTH),
      txnDate: OPENING_DATE,
      privateNote:
        'Opening inventory correction to FIFO method — one-time cutover (2026-03-01). ' +
        'See docs/fifo-monthly-close/2026-08-26-correction-je-proposal.md.',
      lines,
      totalDebits,
      totalCredits,
      variance: round2(totalDebits - totalCredits),
      rowKeys: [],
    };
    await saveDraft(draft, snapshotHash);
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
