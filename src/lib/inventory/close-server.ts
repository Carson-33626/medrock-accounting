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
import { createHash } from 'node:crypto';
import { getRdsPool } from '../rds';
import { getBalanceSheetInventory } from '../quickbooks-multi';
import { QB_LOCATIONS, QB_TO_RDS_LOCATION } from '../qb-links';
import {
  buildRollForward,
  buildLocationJE,
  journalEntryLines,
  invCloseDocNumber,
  type RollbackMonthValue,
} from './monthly-close';
import {
  saveDraft,
  loadDraft,
  toHeader,
  type HeaderRow,
  type PayrollHeader,
} from '../payroll/store';
import type { Entity, JournalDraft, JournalLine } from '../payroll/types';
import type {
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  MonthlyCloseResponse,
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

/** The close computation without stored drafts — shared by GET and generate. */
export async function computeClose(
  month: string,
  basis: CloseBasis,
  monthEnd: string,
): Promise<Pick<MonthlyCloseResponse, 'purchasesAvailable' | 'rollForward' | 'journalEntries'>> {
  const pool = getRdsPool();

  const exists = await pool.query<{ regclass: string | null }>(
    `SELECT to_regclass('inventory.fifo_rollback_valuation')::text AS regclass`,
  );
  if (!exists.rows[0]?.regclass) {
    return { purchasesAvailable: false, rollForward: [], journalEntries: [] };
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
    return { purchasesAvailable, rollForward: [], journalEntries: [] };
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

  return { purchasesAvailable, rollForward, journalEntries };
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
  const warnings: string[] = [];
  const savedEntities: Entity[] = [];
  const payDate = isoToAdp(monthEnd);
  const snapshotHash = createHash('sha256')
    .update(JSON.stringify({ basis, journalEntries: close.journalEntries }))
    .digest('hex');

  for (const je of close.journalEntries) {
    const entity = QB_LOCATIONS.find((qb) => QB_TO_RDS_LOCATION[qb] === je.location);
    if (entity === undefined) continue;
    if (!je.bookAvailable) {
      warnings.push(`${je.location}: QB book balance unavailable — no draft generated`);
      continue;
    }
    const jeLines = journalEntryLines(je, basis, monthEnd);
    if (jeLines.length === 0) {
      warnings.push(`${je.location}: no adjustment needed (FIFO ties to book) — no draft generated`);
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
      sourceRowKeys: [],
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
      privateNote: `Inventory FIFO close adjustment — ${month} (${basis === 'floor' ? 'receipt-priced floor' : 'full-coverage estimate'})`,
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
