/**
 * The base data an inventory-close journal entry was computed FROM, shaped into
 * extra sheets of the entry's own download.
 *
 * Carson, 2026-09-03: *"they want the base data that we have here to be included
 * in the downloads."* Until now the lot-grain evidence was reachable only from
 * the close page, one category at a time — expand a category, click *Excel
 * (every lot)* — while the JE download shipped a workbook with a single
 * `Journal Entry` sheet. An accountant checking an entry had to assemble the
 * backing themselves from as many files as the entry had categories.
 *
 * Pure assembly, deliberately: it takes the STORED draft lines and a lot lookup
 * and does no computation of its own. The close's arithmetic lives in
 * `monthly-close.ts` and must not be re-implemented here, or the attached file
 * becomes a second opinion about the entry instead of a view of it.
 *
 * Per `docs/fifo-monthly-close/ds-je-source-attachments.md` §3.2 this is the
 * builder the QuickBooks attachment will reuse once `qbUpload` exists; wiring
 * the download first is what lets the numbers be checked before any upload code
 * ships.
 */
import type { CellValue, ExportColumn } from '@/lib/inventory-export';
import type { JeLotDetailRow } from './ledger-values';
import type { JournalLine } from '@/lib/payroll/types';

export interface DetailSheet {
  name: string;
  columns: ExportColumn[];
  rows: Record<string, CellValue>[];
  note?: string;
}

const BRIDGE_COLUMNS: ExportColumn[] = [
  { header: 'QB Account', key: 'account' },
  { header: 'Debit', key: 'debit', currency: true },
  { header: 'Credit', key: 'credit', currency: true },
  { header: 'QB Category', key: 'category' },
  { header: 'Lots', key: 'lots' },
  { header: 'FIFO Value (lot-level)', key: 'fifo_value', currency: true },
  { header: 'Implied QB Book Balance', key: 'implied_book', currency: true },
  { header: 'Memo', key: 'memo' },
];

const LOT_COLUMNS: ExportColumn[] = [
  { header: 'QB Category', key: 'category' },
  { header: 'Product', key: 'product' },
  { header: 'NDC', key: 'ndc' },
  { header: 'Lot Number', key: 'lot_number' },
  { header: 'Vendor', key: 'vendor' },
  { header: 'Date Received', key: 'date_received' },
  { header: 'Qty Received', key: 'qty_received' },
  { header: 'Unit Cost', key: 'unit_cost', currency: true },
  { header: 'Total Cost', key: 'total_cost', currency: true },
  { header: 'Qty Consumed', key: 'qty_consumed' },
  { header: 'Qty Remaining', key: 'qty_remaining' },
  { header: 'Remaining Value', key: 'remaining_value', currency: true },
  { header: 'Opening Balance', key: 'opening_balance' },
  { header: 'LifeFile Anchored', key: 'anchored' },
  { header: 'Receipt ID', key: 'receipt_id' },
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Σ in integer cents, so two groupings of the same lots cannot land a cent
 *  apart — the same rule the valuation and COGS views follow. */
function sumDollars(values: Iterable<number>): number {
  let cents = 0;
  for (const v of values) cents += Math.round(v * 100);
  return cents / 100;
}

/** A line's receipt ids, order-independent, as a grouping key. */
function lotKey(line: JournalLine): string {
  return [...line.sourceRowKeys].sort().join('');
}

/**
 * The category a line's lots resolve to, taken from the LOTS rather than parsed
 * out of the memo.
 *
 * A mapped line's receipt ids all come from one category, so this reads back the
 * category the close chose. The aggregated residual pair unions several
 * categories' ids (they share one parent account and one book balance), and the
 * cell then names all of them — which is the honest answer, and the same set the
 * memo lists.
 */
function categoryOf(line: JournalLine, byReceipt: Map<string, JeLotDetailRow>): string {
  const found = new Set<string>();
  for (const id of line.sourceRowKeys) {
    const lot = byReceipt.get(id);
    if (lot) found.add(lot.qbCategory);
  }
  return found.size === 0 ? '—' : [...found].sort().join(' + ');
}

/**
 * The two evidence sheets that accompany an inventory-close entry.
 *
 * **Category bridge** — one row per posted line, carrying the lot-level FIFO
 * value behind it and the book balance that value was compared against. The
 * book balance is not stored on the draft, so it is shown as
 * `FIFO − adjustment`, which is exact arithmetic on what IS stored and gives the
 * accountant the third number of the bridge to check against QuickBooks
 * directly.
 *
 * The FIFO value is printed ONCE per lot set, on the first line carrying it, and
 * left blank on that line's mirror. Both halves of a Dr/Cr pair stand behind the
 * same lots; printing the value twice would make the column sum to double the
 * inventory it represents, and a column an accountant cannot total is worse than
 * one that is sometimes blank.
 *
 * **Lot detail** — every distinct lot behind the whole entry, category first.
 * Deduplicated by receipt id: a lot reached through both halves of a pair is one
 * lot, and listing it twice would double the sheet's total against the entry it
 * is meant to substantiate.
 */
export function buildInventoryJeDetailSheets(
  lines: readonly JournalLine[],
  lots: readonly JeLotDetailRow[],
  monthEnd: string,
): DetailSheet[] {
  const byReceipt = new Map<string, JeLotDetailRow>();
  for (const lot of lots) byReceipt.set(lot.receiptId, lot);

  const valueSeen = new Set<string>();
  const bridgeRows: Record<string, CellValue>[] = [];

  for (const line of lines) {
    const key = lotKey(line);
    const backing = line.sourceRowKeys
      .map((id) => byReceipt.get(id))
      .filter((lot): lot is JeLotDetailRow => lot !== undefined);
    const fifoValue = sumDollars(backing.map((lot) => lot.remainingValue ?? 0));
    const first = key !== '' && !valueSeen.has(key);
    if (first) valueSeen.add(key);

    const debit = line.postingType === 'Debit' ? round2(line.amount) : null;
    const credit = line.postingType === 'Credit' ? round2(line.amount) : null;

    bridgeRows.push({
      account: line.accountName,
      debit,
      credit,
      category: categoryOf(line, byReceipt),
      lots: backing.length,
      fifo_value: first ? fifoValue : null,
      // Only meaningful where the FIFO value is stated. The adjustment's sign
      // relative to the book balance depends on which account the line sits on,
      // so this is derived from the signed movement the pair represents: a debit
      // to inventory means FIFO exceeded book by the amount, a credit the
      // reverse.
      implied_book: first ? round2(fifoValue - signedAdjustment(line)) : null,
      memo: line.memo,
    });
  }

  const totalDebits = sumDollars(
    lines.filter((l) => l.postingType === 'Debit').map((l) => l.amount),
  );
  const totalCredits = sumDollars(
    lines.filter((l) => l.postingType === 'Credit').map((l) => l.amount),
  );
  bridgeRows.push({
    account: 'TOTAL',
    debit: totalDebits,
    credit: totalCredits,
    category: null,
    lots: valueSeen.size,
    fifo_value: sumDollars(
      bridgeRows.map((r) => (typeof r.fifo_value === 'number' ? r.fifo_value : 0)),
    ),
    implied_book: sumDollars(
      bridgeRows.map((r) => (typeof r.implied_book === 'number' ? r.implied_book : 0)),
    ),
    memo: null,
  });

  const seenLots = new Set<string>();
  const lotRows: Record<string, CellValue>[] = [];
  for (const line of lines) {
    for (const id of line.sourceRowKeys) {
      if (seenLots.has(id)) continue;
      const lot = byReceipt.get(id);
      if (!lot) continue;
      seenLots.add(id);
      lotRows.push({
        category: lot.qbCategory,
        product: lot.productName,
        ndc: lot.ndc,
        lot_number: lot.lotNumber,
        vendor: lot.vendor,
        date_received: lot.dateReceived,
        qty_received: lot.qtyReceived,
        unit_cost: lot.unitCost,
        total_cost: lot.totalCost,
        qty_consumed: lot.qtyConsumed,
        qty_remaining: lot.qtyRemaining,
        remaining_value: lot.remainingValue,
        opening_balance: lot.isOpeningBalance,
        anchored: lot.lotAnchored,
        receipt_id: lot.receiptId,
      });
    }
  }
  lotRows.sort((a, b) => {
    const ca = String(a.category ?? '');
    const cb = String(b.category ?? '');
    if (ca !== cb) return ca.localeCompare(cb);
    return String(a.product ?? '').localeCompare(String(b.product ?? ''));
  });
  if (lotRows.length > 0) {
    lotRows.push({
      category: 'TOTAL',
      product: null,
      ndc: null,
      lot_number: null,
      vendor: null,
      date_received: null,
      qty_received: null,
      unit_cost: null,
      total_cost: null,
      qty_consumed: null,
      qty_remaining: null,
      remaining_value: sumDollars(
        lotRows.map((r) => (typeof r.remaining_value === 'number' ? r.remaining_value : 0)),
      ),
      opening_balance: null,
      anchored: null,
      receipt_id: null,
    });
  }

  return [
    {
      name: 'Category bridge',
      columns: BRIDGE_COLUMNS,
      rows: bridgeRows,
      note:
        `Inventory close ${monthEnd} — what each posted line moves, and the lot-level FIFO value it moves the books TO. ` +
        'The line amount is the ADJUSTMENT; Implied QB Book Balance is FIFO Value minus that adjustment, so the three ' +
        'columns are the bridge and the middle one can be checked straight against the QuickBooks balance sheet. ' +
        'FIFO Value is stated once per set of lots — blank on the mirror half of a Dr/Cr pair, which stands behind the same lots.',
    },
    {
      name: 'Lot detail',
      columns: LOT_COLUMNS,
      rows: lotRows,
      note:
        `Every lot behind this entry as of ${monthEnd}, one row per lot, deduplicated across the Dr/Cr pairs. ` +
        'Remaining Value totals to the FIFO Value on the Category bridge sheet. Qty Consumed is consumed-to-date ' +
        'through this month, not this month alone.',
    },
  ];
}

/**
 * The adjustment a line represents, signed as FIFO-minus-book.
 *
 * An inventory-asset account debited means FIFO came in above the books; the
 * COGS mirror of the same pair carries the same movement with the opposite
 * posting type. Both halves therefore have to report the SAME signed adjustment,
 * which is what makes the implied book balance come out the same whichever half
 * of the pair happens to be printed first.
 *
 * Read off the account name because that is all the stored draft retains — the
 * close's own `direction` field is not persisted. Inventory sub-accounts are the
 * 1220.xx family, COGS the 5000.xx; a name matching neither is treated as the
 * inventory side, which is where the parent-account residual pair lands.
 */
function signedAdjustment(line: JournalLine): number {
  const isCogs = /(^|\s|\.)5000/.test(line.accountName) || /cost of goods/i.test(line.accountName);
  const amount = round2(line.amount);
  if (isCogs) {
    // A COGS debit is the mirror of an inventory credit: FIFO below book.
    return line.postingType === 'Debit' ? -amount : amount;
  }
  return line.postingType === 'Debit' ? amount : -amount;
}
