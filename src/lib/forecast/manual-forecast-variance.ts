// Ported from MRPBI power_bi_replacement_fe/components/forecast/manual-forecast-variance.ts,
// per task-15-brief.md. `diff()` is unchanged. The lookup is adapted from MRPBI's
// sortKey-based `ForecastResult` (entity.historical / entity.projected) to the target's
// string-month `ForecastModel`/`ForecastLocation` (loc.actual / loc.est / loc.future, keyed
// by 'YYYY-MM').
import { skToYm } from './engine';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';
import type { ManualForecast } from '@/types/manual-forecast';

/** |Δ%| at or under this counts as "Close". Single knob — change here only. */
export const CLOSE_THRESHOLD_PCT = 10;

export type VarianceStatus = 'close' | 'over' | 'under' | 'none';
export type SystemKind = 'actual' | 'projected';

export interface VarianceRow {
  location: string;
  sortKey: number;
  label: string;
  manual: number;
  system: number | null;
  systemKind: SystemKind | null;
  delta: number | null;
  deltaPct: number | null;
  status: VarianceStatus;
}

export interface VarianceSubtotal {
  manual: number;
  system: number | null;
  delta: number | null;
  deltaPct: number | null;
  status: VarianceStatus;
}

export interface VarianceGroup {
  location: string;
  label: string;
  rows: VarianceRow[];
  subtotal: VarianceSubtotal;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 202608 → "Aug '26" (matches the engine's fmtMonth output style / MRPBI's formatSortKey). */
function formatSortKey(sortKey: number): string {
  const y = Math.floor(sortKey / 100);
  const m = sortKey % 100;
  const abbr = MONTH_ABBR[m - 1] ?? '?';
  return `${abbr} '${String(y).slice(-2)}`;
}

/** entry.sortKey (year*100+month) → the model's 'YYYY-MM' month key. */
function sortKeyToYm(sortKey: number): string {
  const { y, m } = skToYm(sortKey);
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Δ / Δ% / status from a manual-vs-system pair. Kept in one place so rows and subtotals agree. */
function diff(manual: number, system: number | null): Pick<VarianceRow, 'delta' | 'deltaPct' | 'status'> {
  if (system === null) return { delta: null, deltaPct: null, status: 'none' };
  const delta = manual - system;
  if (system === 0) {
    // No percentage is meaningful against a zero base; treat any positive manual as Over.
    return { delta, deltaPct: null, status: delta === 0 ? 'close' : 'over' };
  }
  const deltaPct = (delta / system) * 100;
  const status: VarianceStatus =
    Math.abs(deltaPct) <= CLOSE_THRESHOLD_PCT ? 'close' : delta > 0 ? 'over' : 'under';
  return { delta, deltaPct, status };
}

/**
 * Builds the manual-vs-system comparison, one group per location.
 *
 * Only locations present in `model.locations` are included — a manual entry whose
 * `location` doesn't match any `qbLocation` isn't shown.
 *
 * System value per month ('YYYY-MM' derived from the entry's sortKey):
 *   • ym <  model.currentMonthKey → `loc.actual[ym]` (a completed month)
 *   • ym >= model.currentMonthKey → `loc.future[ym] ?? loc.est[ym]` (the projection),
 *     or null when `showProjected` is false (Method = None) or the month has no
 *     system value at all.
 * The in-progress current month is deliberately treated as not-completed: its partial
 * actual would make every comparison look wildly Under. `loc.future` only holds
 * strictly-future months, so the current month falls through to `loc.est`.
 */
export function computeVariance(
  model: ForecastModel,
  manual: ManualForecast,
  opts: { showProjected: boolean },
): VarianceGroup[] {
  const cmk = model.currentMonthKey;
  const byLocation = new Map(model.locations.map((l) => [l.qbLocation, l]));

  const grouped = new Map<string, VarianceRow[]>();

  for (const entry of manual.entries) {
    const loc = byLocation.get(entry.location);
    if (!loc) continue; // manual covers a location that isn't in the model → not our row

    const ym = sortKeyToYm(entry.sortKey);
    let system: number | null = null;
    let systemKind: SystemKind | null = null;

    if (cmk !== null && ym < cmk) {
      const actual = loc.actual[ym];
      if (actual !== undefined) { system = actual; systemKind = 'actual'; }
    } else if (opts.showProjected) {
      const projected = loc.future[ym] ?? loc.est[ym];
      if (projected !== undefined) { system = projected; systemKind = 'projected'; }
    }

    const row: VarianceRow = {
      location: entry.location,
      sortKey: entry.sortKey,
      label: formatSortKey(entry.sortKey),
      manual: entry.amount,
      system,
      systemKind,
      ...diff(entry.amount, system),
    };
    const list = grouped.get(entry.location);
    if (list) list.push(row);
    else grouped.set(entry.location, [row]);
  }

  const groups: VarianceGroup[] = [];
  for (const [location, rows] of grouped) {
    rows.sort((a, b) => a.sortKey - b.sortKey);
    // Subtotal spans only months with a system counterpart, so Δ% stays meaningful.
    const comparable = rows.filter((r) => r.system !== null);
    const manualSum = comparable.reduce((s, r) => s + r.manual, 0);
    const systemSum = comparable.length
      ? comparable.reduce((s, r) => s + (r.system as number), 0)
      : null;
    groups.push({
      location,
      label: byLocation.get(location)?.label ?? location,
      rows,
      subtotal: { manual: manualSum, system: systemSum, ...diff(manualSum, systemSum) },
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label) || a.location.localeCompare(b.location));
  return groups;
}
