/**
 * RDS data access for manually-entered forecasts.
 * Table: source.accounting_manual_forecasts (id bigint identity, name unique,
 * metric, basis, entries jsonb, created_by, created_at, updated_at).
 */

import { getRdsPool } from '@/lib/rds';
import type { ManualForecast, ManualForecastInput } from '@/types/manual-forecast';

interface Row {
  id: string;
  name: string;
  metric: string;
  basis: string;
  entries: ManualForecast['entries'];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS =
  'id, name, metric, basis, entries, created_by, created_at, updated_at';

function toModel(r: Row): ManualForecast {
  return {
    id: Number(r.id),
    name: r.name,
    metric: r.metric as ManualForecast['metric'],
    basis: r.basis as ManualForecast['basis'],
    entries: r.entries,
    createdBy: r.created_by ?? '',
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** List all manual forecasts, most recently updated first. */
export async function listManualForecasts(): Promise<ManualForecast[]> {
  const { rows } = await getRdsPool().query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM source.accounting_manual_forecasts ORDER BY updated_at DESC`,
  );
  return rows.map(toModel);
}

/** Fetch a single manual forecast by id. Returns null if not found. */
export async function getManualForecast(id: number): Promise<ManualForecast | null> {
  const { rows } = await getRdsPool().query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM source.accounting_manual_forecasts WHERE id = $1`,
    [id],
  );
  return rows[0] ? toModel(rows[0]) : null;
}

/** Create a new manual forecast. Throws a pg error (code 23505) on duplicate name. */
export async function createManualForecast(
  input: ManualForecastInput,
  createdBy: string,
): Promise<ManualForecast> {
  const { rows } = await getRdsPool().query<Row>(
    `INSERT INTO source.accounting_manual_forecasts (name, metric, basis, entries, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.name, input.metric, input.basis, JSON.stringify(input.entries), createdBy],
  );
  return toModel(rows[0]);
}

/**
 * Update an existing manual forecast, bumping updated_at.
 * Returns null if no row with that id exists. Throws a pg error (code 23505) on duplicate name.
 */
export async function updateManualForecast(
  id: number,
  input: ManualForecastInput,
): Promise<ManualForecast | null> {
  const { rows } = await getRdsPool().query<Row>(
    `UPDATE source.accounting_manual_forecasts
     SET name = $1, metric = $2, basis = $3, entries = $4::jsonb, updated_at = now()
     WHERE id = $5
     RETURNING ${SELECT_COLUMNS}`,
    [input.name, input.metric, input.basis, JSON.stringify(input.entries), id],
  );
  return rows[0] ? toModel(rows[0]) : null;
}

/** Delete a manual forecast. Returns true if a row was deleted. */
export async function deleteManualForecast(id: number): Promise<boolean> {
  const { rowCount } = await getRdsPool().query(
    'DELETE FROM source.accounting_manual_forecasts WHERE id = $1',
    [id],
  );
  return (rowCount ?? 0) > 0;
}
