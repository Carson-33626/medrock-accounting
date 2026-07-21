import { Basis, TrendMetric } from '@/types/location-analytics';
import {
  ManualForecastEntry,
  ManualForecastInput,
  MAX_ENTITY_LEN,
  MAX_ENTRIES,
  MAX_NAME_LEN,
  MAX_YEAR,
  MIN_YEAR,
} from '@/types/manual-forecast';

const METRICS: readonly TrendMetric[] = ['revenue', 'grossProfit', 'netIncome'];
const BASES: readonly Basis[] = ['Cash', 'Accrual'];

export type ValidationResult =
  | { ok: true; value: ManualForecastInput }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates a client-supplied manual-forecast body.
 *
 * Pure: no DB access, no throwing — the caller turns `errors` into a 400.
 * Collects every problem rather than failing on the first, so the grid editor can
 * surface all bad cells at once.
 */
export function validateManualForecastInput(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) return { ok: false, errors: ['Body must be an object'] };

  // name
  const nameRaw = raw.name;
  let name = '';
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) {
    errors.push('name is required');
  } else {
    name = nameRaw.trim();
    if (name.length > MAX_NAME_LEN) errors.push(`name must be <= ${MAX_NAME_LEN} characters`);
  }

  // metric
  const metricRaw = raw.metric;
  let metric: TrendMetric = 'revenue';
  if (typeof metricRaw !== 'string' || !METRICS.includes(metricRaw as TrendMetric)) {
    errors.push(`metric must be one of: ${METRICS.join(', ')}`);
  } else {
    metric = metricRaw as TrendMetric;
  }

  // basis
  const basisRaw = raw.basis;
  let basis: Basis = 'Accrual';
  if (typeof basisRaw !== 'string' || !BASES.includes(basisRaw as Basis)) {
    errors.push(`basis must be one of: ${BASES.join(', ')}`);
  } else {
    basis = basisRaw as Basis;
  }

  // entries
  const entriesRaw = raw.entries;
  const entries: ManualForecastEntry[] = [];
  if (!Array.isArray(entriesRaw)) {
    errors.push('entries must be an array');
  } else if (entriesRaw.length > MAX_ENTRIES) {
    errors.push(`entries must contain at most ${MAX_ENTRIES} items`);
  } else {
    const seen = new Set<string>();
    entriesRaw.forEach((item: unknown, i: number) => {
      if (!isRecord(item)) { errors.push(`entries[${i}] must be an object`); return; }

      const locationRaw = item.location;
      const sortKeyRaw = item.sortKey;
      const amountRaw = item.amount;

      if (typeof locationRaw !== 'string' || !locationRaw.trim()) {
        errors.push(`entries[${i}].location is required`); return;
      }
      const location = locationRaw.trim();
      if (location.length > MAX_ENTITY_LEN) {
        errors.push(`entries[${i}].location must be <= ${MAX_ENTITY_LEN} characters`); return;
      }

      if (typeof sortKeyRaw !== 'number' || !Number.isInteger(sortKeyRaw)) {
        errors.push(`entries[${i}].sortKey must be an integer`); return;
      }
      const year = Math.floor(sortKeyRaw / 100);
      const month = sortKeyRaw % 100;
      if (month < 1 || month > 12) {
        errors.push(`entries[${i}].sortKey has an invalid month (${month})`); return;
      }
      if (year < MIN_YEAR || year > MAX_YEAR) {
        errors.push(`entries[${i}].sortKey year must be ${MIN_YEAR}-${MAX_YEAR}`); return;
      }

      if (typeof amountRaw !== 'number' || !Number.isFinite(amountRaw)) {
        errors.push(`entries[${i}].amount must be a finite number`); return;
      }

      const dedupeKey = `${location} ${sortKeyRaw}`;
      if (seen.has(dedupeKey)) {
        errors.push(`entries[${i}] is a duplicate of an earlier (location, sortKey) pair`); return;
      }
      seen.add(dedupeKey);

      entries.push({ location, sortKey: sortKeyRaw, amount: amountRaw });
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, metric, basis, entries } };
}
