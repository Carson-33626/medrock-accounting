/**
 * Economic-nexus exposure: compare MedRock's actual ship-to sales (by patient state,
 * from source.sales_tax_report) against each state's economic-nexus threshold.
 *
 * IMPORTANT framing (surfaced in the UI):
 *  - The feed starts 2026-01, so figures are YTD-2026, NOT a full trailing-12-months.
 *    We annualize (YTD ÷ fraction-of-year-elapsed) to project full-year and flag states
 *    that are trending over even if YTD is still under.
 *  - We compare GROSS sales (Σ Subtotal). Most states measure gross (incl. exempt Rx);
 *    a few measure taxable only (FL, MO) — flagged via salesBasis so the lower real
 *    figure is not misread.
 *  - This is a screen to feed the CPA nexus study, not a filing determination.
 */

import { getRdsPool } from './rds';
import { ALL_FILINGS } from './sales-tax-filings';
import { STATE_THRESHOLDS, THRESHOLD_BY_ABBR, type StateThreshold } from './nexus-thresholds';

/** States where MedRock already holds a registration (active FL/TX/TN + legacy GA/NC). */
export const REGISTERED_STATES: ReadonlySet<string> = new Set(ALL_FILINGS.map((f) => f.stateAbbr));

export type NexusStatus = 'registered' | 'over' | 'approaching' | 'under' | 'no_tax';

export interface NexusStateRow {
  abbr: string;
  name: string;
  registered: boolean;
  /** YTD gross sales (Σ Subtotal) shipped to this state. */
  grossYtd: number;
  /** YTD distinct transaction count. */
  txnsYtd: number;
  /** YTD sales tax collected (≈0 for exempt-Rx states). */
  taxYtd: number;
  /** Annualized projection (YTD ÷ fraction of year elapsed). */
  grossProjected: number;
  txnsProjected: number;
  salesThreshold: number | null;
  txnThreshold: number | null;
  salesBasis: StateThreshold['salesBasis'];
  combine: StateThreshold['combine'];
  measurement: string;
  hasSalesTax: boolean;
  /** True if the threshold is met on the YTD figures alone. */
  overNow: boolean;
  /** True if the annualized projection crosses the threshold. */
  overProjected: boolean;
  status: NexusStatus;
  note?: string;
}

export interface NexusResponse {
  /** YTD window. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Fraction of the calendar year elapsed at periodEnd (used for the projection). */
  yearFraction: number;
  feedAsOf: string | null;
  rows: NexusStateRow[];
  /** Ship-to codes that aren't a US state/DC (territories, APO/FPO, blanks) — not scored. */
  unrecognized: { code: string; gross: number; txns: number }[];
  summary: {
    overUnregistered: number;
    approaching: number;
    registered: number;
    statesWithSales: number;
  };
}

interface StateAgg {
  state: string;
  txns: number;
  gross: number;
  tax: number;
}

const APPROACHING_RATIO = 0.8;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Does (sales, txns) cross the threshold under its combine rule? */
function crosses(t: StateThreshold, gross: number, txns: number): boolean {
  if (!t.hasSalesTax) return false;
  const salesHit = t.salesThreshold != null && gross >= t.salesThreshold;
  const txnHit = t.txnThreshold != null && txns >= t.txnThreshold;
  if (t.combine === 'and') return salesHit && txnHit;
  return salesHit || txnHit; // 'or' and 'sales_only' (txnThreshold null → txnHit false)
}

/** Within APPROACHING_RATIO of either prong (but not yet over)? */
function nearing(t: StateThreshold, gross: number, txns: number): boolean {
  if (!t.hasSalesTax) return false;
  const salesNear = t.salesThreshold != null && gross >= t.salesThreshold * APPROACHING_RATIO;
  const txnNear = t.txnThreshold != null && txns >= t.txnThreshold * APPROACHING_RATIO;
  return salesNear || txnNear;
}

export async function fetchNexusExposure(): Promise<NexusResponse> {
  const pool = getRdsPool();

  const aggRes = await pool.query<{ state: string | null; txns: string; gross: string | null; tax: string | null }>(
    `SELECT row_data->>'Patient State' AS state,
            count(DISTINCT row_data->>'Tx ID')::text AS txns,
            sum((NULLIF(row_data->>'Subtotal', ''))::numeric)::text AS gross,
            sum((NULLIF(row_data->>'Tax', ''))::numeric)::text AS tax
     FROM source.sales_tax_report
     GROUP BY 1`,
  );

  const spanRes = await pool.query<{ start: string | null; end: string | null }>(
    `SELECT min(to_date(row_data->>'Tx Effective Date', 'MM/DD/YYYY'))::text AS start,
            max(to_date(row_data->>'Tx Effective Date', 'MM/DD/YYYY'))::text AS end
     FROM source.sales_tax_report`,
  );
  const freshRes = await pool.query<{ as_of: string | null }>(
    `SELECT max(ingested_at)::text AS as_of FROM source.sales_tax_report`,
  );

  const aggs: StateAgg[] = aggRes.rows.map((r) => ({
    state: (r.state ?? '').trim().toUpperCase(),
    txns: parseInt(r.txns, 10) || 0,
    gross: round2(parseFloat(r.gross ?? '0') || 0),
    tax: round2(parseFloat(r.tax ?? '0') || 0),
  }));
  const byState = new Map<string, StateAgg>();
  for (const a of aggs) {
    // Collapse any duplicate casings/whitespace into one bucket per code.
    const prev = byState.get(a.state);
    if (prev) {
      prev.txns += a.txns;
      prev.gross = round2(prev.gross + a.gross);
      prev.tax = round2(prev.tax + a.tax);
    } else {
      byState.set(a.state, { ...a });
    }
  }

  // Fraction of the calendar year elapsed at the feed's last transaction date.
  const periodEnd = spanRes.rows[0]?.end ?? null;
  const periodStart = spanRes.rows[0]?.start ?? null;
  const yearFraction = computeYearFraction(periodEnd);

  const rows: NexusStateRow[] = STATE_THRESHOLDS.map((t) => {
    const a = byState.get(t.abbr) ?? { state: t.abbr, txns: 0, gross: 0, tax: 0 };
    const grossProjected = yearFraction > 0 ? round2(a.gross / yearFraction) : a.gross;
    const txnsProjected = yearFraction > 0 ? Math.round(a.txns / yearFraction) : a.txns;
    const registered = REGISTERED_STATES.has(t.abbr);
    const overNow = crosses(t, a.gross, a.txns);
    const overProjected = crosses(t, grossProjected, txnsProjected);

    let status: NexusStatus;
    if (!t.hasSalesTax) status = 'no_tax';
    else if (registered) status = 'registered';
    else if (overNow) status = 'over';
    else if (overProjected || nearing(t, a.gross, a.txns)) status = 'approaching';
    else status = 'under';

    return {
      abbr: t.abbr,
      name: t.name,
      registered,
      grossYtd: a.gross,
      txnsYtd: a.txns,
      taxYtd: a.tax,
      grossProjected,
      txnsProjected,
      salesThreshold: t.salesThreshold,
      txnThreshold: t.txnThreshold,
      salesBasis: t.salesBasis,
      combine: t.combine,
      measurement: t.measurement,
      hasSalesTax: t.hasSalesTax,
      overNow,
      overProjected,
      status,
      note: t.note,
    };
  });

  const unrecognized = [...byState.entries()]
    .filter(([code]) => !THRESHOLD_BY_ABBR[code])
    .map(([code, a]) => ({ code: code || '(blank)', gross: a.gross, txns: a.txns }))
    .sort((x, y) => y.gross - x.gross);

  const summary = {
    overUnregistered: rows.filter((r) => r.status === 'over').length,
    approaching: rows.filter((r) => r.status === 'approaching').length,
    registered: rows.filter((r) => r.registered).length,
    statesWithSales: rows.filter((r) => r.grossYtd > 0).length,
  };

  return { periodStart, periodEnd, yearFraction, feedAsOf: freshRes.rows[0]?.as_of ?? null, rows, unrecognized, summary };
}

/** Fraction of the calendar year elapsed at an ISO date (YYYY-MM-DD); 0..1. */
function computeYearFraction(isoDate: string | null): number {
  if (!isoDate) return 1;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return 1;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  // Day-of-year via UTC to avoid TZ drift; divide by the year's length.
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86_400_000);
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const fraction = dayOfYear / (isLeap ? 366 : 365);
  return Math.min(1, Math.max(0.01, fraction));
}

/** Ordering for display: over → approaching → registered → under → no_tax; then by gross desc. */
export function nexusSortKey(r: NexusStateRow): number {
  const rank: Record<NexusStatus, number> = { over: 0, approaching: 1, registered: 2, under: 3, no_tax: 4 };
  return rank[r.status];
}
