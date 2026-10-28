/**
 * The reads behind the device standard-cost contributor (`device-cost-je.ts`), and the gate that
 * decides whether it joins an entity's close entry at all.
 *
 * Read-only against RDS (`inventory.device_usage_monthly`, `accounting.payroll_journal_*`).
 *
 * WHEN IT JOINS THE POOL. Only for an entity whose FIFO close emits no 1220.15 line
 * (`fifoRelievesPackaging` false — Texas today). FL and TN packaging is already relieved by the
 * FIFO category line (FIFO target − book); a device line there would relieve it a second time
 * (2026-10-27 map: FL May 21,273.52 and TN 25,125.40 of device cost sit inside FIFO's own relief).
 *
 * WHAT IT CATCHES UP. The months after the last one an already-POSTED device line covered
 * (`fetchDeviceRelievedThrough`); with none posted, everything from 2026-01. So the first entry in
 * an open month carries every prior unrelieved month, and a correction posted after it carries
 * nothing further until a later month ends.
 */
import { getRdsPool } from '@/lib/rds';
import { INV_CLOSE_PAY_GROUP } from './monthly-close';
import {
  DEVICE_COST_FIRST_MONTH,
  DEVICE_SOURCE_KEY_PREFIX,
  deviceCostContribution,
  fifoRelievesPackaging,
  type DeviceUsageRow,
} from './device-cost-je';
import type { JeContribution } from './je-pool';
import type { Entity } from '@/lib/payroll/types';
import type { CategoryJE } from '@/types/inventory';

interface UsageRow {
  as_of_month: string;
  location: string;
  device: string;
  sku: string;
  fills: number;
  units: string;
  confidence: string;
  disposition: DeviceUsageRow['disposition'];
}

/** Modelled usage 2026-01 through `throughMonth`, or null when the loader table cannot be read. */
export async function fetchDeviceUsage(throughMonth: string): Promise<DeviceUsageRow[] | null> {
  try {
    const { rows } = await getRdsPool().query<UsageRow>(
      `SELECT as_of_month, location, device, sku, fills::int AS fills, units::text AS units, confidence, disposition
         FROM inventory.device_usage_monthly
        WHERE as_of_month BETWEEN $1 AND $2`,
      [DEVICE_COST_FIRST_MONTH, throughMonth],
    );
    return rows.map((r) => ({
      asOfMonth: r.as_of_month,
      location: r.location,
      device: r.device,
      sku: r.sku,
      fills: r.fills,
      units: Number(r.units),
      confidence: r.confidence,
      disposition: r.disposition,
    }));
  } catch (error) {
    console.warn('[device-cost] usage unreadable:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The last month ('YYYY-MM') that an already-POSTED INV CLOSE entry's device lines covered for
 * this entity, or null when none has posted. Each such entry carries every month after the one
 * before it, so "covered through its period" is exact.
 */
export async function fetchDeviceRelievedThrough(entity: Entity): Promise<string | null> {
  const { rows } = await getRdsPool().query<{ through: string | null }>(
    `SELECT max(h.period_end::date)::text AS through
       FROM accounting.payroll_journal_headers h
      WHERE h.entity = $1
        AND h.status = 'posted'
        AND h.pay_group = $2
        AND EXISTS (
          SELECT 1
            FROM accounting.payroll_journal_lines l, unnest(l.source_row_keys) AS k
           WHERE l.header_id = h.id AND k LIKE $3
        )`,
    [entity, INV_CLOSE_PAY_GROUP, `${DEVICE_SOURCE_KEY_PREFIX}%`],
  );
  return rows[0]?.through?.slice(0, 7) ?? null;
}

/**
 * The device standard-cost contributor for one entity's close/correction entry for `month`, or
 * null when it does not apply because the entity's FIFO close already relieves packaging.
 */
export async function deviceCostContributionFor(
  entity: Entity,
  je: CategoryJE,
  month: string,
): Promise<JeContribution | null> {
  if (fifoRelievesPackaging(je)) return null;
  const [usage, relievedThrough] = await Promise.all([fetchDeviceUsage(month), fetchDeviceRelievedThrough(entity)]);
  return deviceCostContribution(je.location, month, usage, relievedThrough);
}
