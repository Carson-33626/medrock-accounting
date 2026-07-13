-- web/scripts/migrations/alter_payroll_account_map_cost_center.sql
-- Adds cost_center to accounting.payroll_account_map and relaxes the unique
-- constraint so multiple posting rules can exist per (entity, adp_column,
-- cost_center) -- needed for employer double-entry (debit + credit from one
-- ADP column) and role/cost-center-aware account resolution.
-- See docs/superpowers/specs/2026-07-10-payroll-mapping-addendum.md. Idempotent.

ALTER TABLE accounting.payroll_account_map
  ADD COLUMN IF NOT EXISTS cost_center text NOT NULL DEFAULT '*';

-- Drop the old single-rule-per-column unique constraint (was UNIQUE (entity, adp_column),
-- auto-named by Postgres as payroll_account_map_entity_adp_column_key per
-- scripts/migrations/create_payroll_tables.sql).
ALTER TABLE accounting.payroll_account_map
  DROP CONSTRAINT IF EXISTS payroll_account_map_entity_adp_column_key;

-- Add the new natural key allowing multiple rules per (entity, adp_column, cost_center) --
-- e.g. a cost-center-specific debit rule and a '*' credit rule for the same column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_account_map_natkey'
  ) THEN
    ALTER TABLE accounting.payroll_account_map
      ADD CONSTRAINT payroll_account_map_natkey
      UNIQUE (entity, adp_column, cost_center, posting_type, account_name);
  END IF;
END $$;
