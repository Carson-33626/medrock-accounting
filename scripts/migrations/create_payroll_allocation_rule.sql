-- web/scripts/migrations/create_payroll_allocation_rule.sql
-- Editable percentage table for admin-wage allocation across FL/TN/TX.
-- See docs/superpowers/specs/2026-07-16-payroll-accrual-and-admin-allocation-design.md
-- "Percentage table". Idempotent.

CREATE TABLE IF NOT EXISTS accounting.payroll_allocation_rule (
  id             SERIAL PRIMARY KEY,
  cost_center    TEXT         NOT NULL,
  target_entity  TEXT         NOT NULL,   -- 'MedRock FL' | 'MedRock TN' | 'MedRock TX'
  percent        NUMERIC(7,4) NOT NULL,   -- 33.3333
  effective_from DATE         NOT NULL,
  active         BOOLEAN      NOT NULL DEFAULT true,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT payroll_allocation_natkey UNIQUE (cost_center, target_entity, effective_from)
);
