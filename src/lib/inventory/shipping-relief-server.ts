/**
 * The QuickBooks reads behind the shipping packaging relief (`shipping-relief.ts`).
 *
 * Four reads per entity-month, all SELECT/report GETs — nothing is written to QuickBooks:
 *   1. the chart, to resolve 5000.40 / 5000.20 / 1220.30 to this realm's ids (never hardcoded:
 *      FL 1220.30 is 266, TN 338, TX 137);
 *   2. the accrual P&L for the month — postage (5000.40) and what 5000.20 already carries;
 *   3. the month's JournalEntries, to find a relief Barbara already posted by hand;
 *   4. the month-end balance sheet, only to flag a relief larger than the asset.
 *
 * Accounts are matched by id on the report rows, not by label: QuickBooks prints labels with
 * or without account numbers depending on a company preference.
 */
import {
  getBalanceSheetInventory,
  getProfitAndLoss,
  qbQueryAll,
  type Location,
} from '@/lib/quickbooks-multi';
import type { Entity } from '@/lib/payroll/types';
import { monthEndOf } from './shipping-packaging-accrual';
import type { ShippingLocation } from './shipping-packaging-accrual';
import {
  buildShippingReliefContribution,
  type ManualRelief,
  type ShippingReliefContribution,
} from './shipping-relief';

const POSTAGE_ACCT = '5000.40';
const PACKAGING_ACCT = '5000.20';
const ASSET_ACCT = '1220.30';

interface AccountRow {
  Id: string;
  AcctNum?: string;
}

interface ReportColData {
  value?: string;
  id?: string;
}

interface ReportRow {
  ColData?: ReportColData[];
  Header?: { ColData?: ReportColData[] };
  Summary?: { ColData?: ReportColData[] };
  Rows?: { Row?: ReportRow[] };
}

interface PnlReport {
  Rows?: { Row?: ReportRow[] };
}

interface JeLine {
  Amount?: number;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string };
  };
}

interface JeDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: JeLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function amountOf(cols: ReportColData[] | undefined): number {
  const raw = cols?.[1]?.value ?? '';
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Σ of the report rows belonging to `ids`. A leaf row carries its id on ColData[0]; an
 * account with sub-accounts is a section whose Header carries the id and whose Summary
 * carries the total including children — read that and do not descend, or the children
 * would count twice.
 */
export function sumPnlRows(rows: readonly ReportRow[], ids: ReadonlySet<string>): number {
  let total = 0;
  for (const row of rows) {
    const headerId = row.Header?.ColData?.[0]?.id;
    if (headerId !== undefined && ids.has(headerId)) {
      total += amountOf(row.Summary?.ColData);
      continue;
    }
    const leafId = row.ColData?.[0]?.id;
    if (leafId !== undefined && ids.has(leafId)) total += amountOf(row.ColData);
    const nested = row.Rows?.Row;
    if (nested !== undefined) total += sumPnlRows(nested, ids);
  }
  return total;
}

/**
 * Posted JournalEntries in the month that credit 1220.30 against 5000.20 and are not our
 * own close entry (or one of its corrections). Inter-entity allocations also credit 1220.30,
 * but against Due To/From, so requiring the 5000.20 debit keeps them out.
 */
export function findManualReliefs(
  jes: readonly JeDoc[],
  assetIds: ReadonlySet<string>,
  packagingIds: ReadonlySet<string>,
  ownDocNumber: string,
): ManualRelief[] {
  const out: ManualRelief[] = [];
  for (const je of jes) {
    const doc = je.DocNumber ?? '';
    if (doc === ownDocNumber || doc.startsWith(`${ownDocNumber}-`)) continue;
    let assetCredit = 0;
    let packagingDebit = 0;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const acct = d?.AccountRef?.value ?? '';
      if (d?.PostingType === 'Credit' && assetIds.has(acct)) assetCredit += l.Amount ?? 0;
      if (d?.PostingType === 'Debit' && packagingIds.has(acct)) packagingDebit += l.Amount ?? 0;
    }
    if (assetCredit > 0 && packagingDebit > 0) {
      out.push({ docNumber: doc === '' ? `JE #${je.Id}` : doc, txnDate: je.TxnDate ?? '', amount: round2(assetCredit) });
    }
  }
  return out;
}

function idsFor(accounts: readonly AccountRow[], acctNum: string): Set<string> {
  return new Set(accounts.filter((a) => a.AcctNum === acctNum).map((a) => a.Id));
}

/**
 * The shipping relief for one entity's close entry.
 *
 * @param ownDocNumber this month's close DocNumber (`invCloseDocNumber`), so our own posted
 *   entry is never mistaken for a manual relief when a correction is generated.
 */
export async function shippingReliefContributionFor(
  entity: Entity,
  month: string,
  ownDocNumber: string,
): Promise<ShippingReliefContribution> {
  const asOf = new Date().toISOString().slice(0, 10);
  const location = entity as ShippingLocation;
  const monthEnd = monthEndOf(month);
  const base = {
    location,
    month,
    monthEnded: monthEnd < asOf,
    postage: 0,
    packagingCarried: 0,
    assetBalance: null,
    manualReliefs: [],
  };
  if (!base.monthEnded) {
    return buildShippingReliefContribution({ ...base, available: true }, asOf);
  }

  try {
    const qbLocation = entity as Location;
    const accounts = await qbQueryAll<AccountRow>(qbLocation, 'Account', '');
    const postageIds = idsFor(accounts, POSTAGE_ACCT);
    const packagingIds = idsFor(accounts, PACKAGING_ACCT);
    const assetIds = idsFor(accounts, ASSET_ACCT);
    if (postageIds.size === 0 || packagingIds.size === 0 || assetIds.size === 0) {
      console.warn(`[shipping-relief] ${entity}: chart is missing ${POSTAGE_ACCT}, ${PACKAGING_ACCT} or ${ASSET_ACCT}`);
      return buildShippingReliefContribution({ ...base, available: false }, asOf);
    }

    const [pnl, jes, bs] = await Promise.all([
      getProfitAndLoss({
        location: qbLocation,
        startDate: `${month}-01`,
        endDate: monthEnd,
        accounting_method: 'Accrual',
      }) as Promise<PnlReport>,
      qbQueryAll<JeDoc>(qbLocation, 'JournalEntry', `WHERE TxnDate >= '${month}-01' AND TxnDate <= '${monthEnd}'`),
      getBalanceSheetInventory(qbLocation, monthEnd),
    ]);
    const rows = pnl.Rows?.Row ?? [];
    const asset = bs?.accounts.find((a) => /shipping packaging/i.test(a.name)) ?? null;

    return buildShippingReliefContribution(
      {
        ...base,
        available: true,
        postage: round2(sumPnlRows(rows, postageIds)),
        packagingCarried: round2(sumPnlRows(rows, packagingIds)),
        assetBalance: asset === null ? null : asset.value,
        manualReliefs: findManualReliefs(jes, assetIds, packagingIds, ownDocNumber),
      },
      asOf,
    );
  } catch (error) {
    console.warn(`[shipping-relief] ${entity} ${month} unavailable:`, error);
    return buildShippingReliefContribution({ ...base, available: false }, asOf);
  }
}
