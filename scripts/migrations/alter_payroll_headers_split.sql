-- web/scripts/migrations/alter_payroll_headers_split.sql
-- Month-crossing payroll split (spec 2026-07-27): a straddling run persists as N sibling
-- headers, one per calendar month ("period segment"). Idempotent + additive.
ALTER TABLE accounting.payroll_journal_headers
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'pay_date',
  ADD COLUMN IF NOT EXISTS period_segment text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS txn_date date;

-- Existing rows are all unsplit pay-date JEs: TxnDate == pay date.
UPDATE accounting.payroll_journal_headers
  SET txn_date = to_date(pay_date, 'MM/DD/YYYY')
  WHERE txn_date IS NULL;

-- Widen the natural key so two pieces of one run can coexist. Existing rows keep
-- period_segment = '' and remain unique under the new key.
ALTER TABLE accounting.payroll_journal_headers
  DROP CONSTRAINT IF EXISTS payroll_journal_headers_entity_pay_date_pay_group_key;
DO $$ BEGIN
  ALTER TABLE accounting.payroll_journal_headers
    ADD CONSTRAINT payroll_headers_run_segment_key
    UNIQUE (entity, pay_date, pay_group, period_segment);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
