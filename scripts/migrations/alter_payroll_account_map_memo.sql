-- Add a department-labelled JE line memo to the account map.
-- Nullable + additive: existing rules keep NULL memo (they fall back to the creditBucket
-- label in build-je, i.e. unchanged behaviour) until the seeder re-applies with memos.
-- Not part of the natural key (entity, adp_column, cost_center, posting_type, account_name),
-- so re-seeding updates memo in place rather than creating duplicate rows.
ALTER TABLE accounting.payroll_account_map
  ADD COLUMN IF NOT EXISTS memo text;
