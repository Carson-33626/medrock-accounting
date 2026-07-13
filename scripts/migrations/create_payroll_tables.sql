-- web/scripts/migrations/create_payroll_tables.sql
-- App-owned payroll JE state on RDS MedDotsPBI (accounting schema). Idempotent.
CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting.payroll_account_map (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity        text NOT NULL,
  adp_column    text NOT NULL,
  account_name  text NOT NULL,
  posting_type  text NOT NULL CHECK (posting_type IN ('Debit','Credit')),
  is_cogs       boolean NOT NULL DEFAULT false,
  credit_bucket text,
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, adp_column)
);

CREATE TABLE IF NOT EXISTS accounting.payroll_employee_map (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity        text NOT NULL,
  position_id   text NOT NULL,
  department_name text,
  class_name    text,
  cogs_override boolean,
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, position_id)
);

CREATE TABLE IF NOT EXISTS accounting.payroll_journal_headers (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity              text NOT NULL,
  pay_date            text NOT NULL,
  pay_group           text NOT NULL,
  period_start        text,
  period_end          text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','needs_review','approved','posted','error')),
  total_debits        numeric(14,2) NOT NULL DEFAULT 0,
  total_credits       numeric(14,2) NOT NULL DEFAULT 0,
  variance            numeric(14,2) NOT NULL DEFAULT 0,
  row_count           int NOT NULL DEFAULT 0,
  source_snapshot_hash text,
  qb_entry_id         text,
  qb_doc_number       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, pay_date, pay_group)
);

CREATE TABLE IF NOT EXISTS accounting.payroll_journal_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  header_id     bigint NOT NULL REFERENCES accounting.payroll_journal_headers(id) ON DELETE CASCADE,
  posting_type  text NOT NULL CHECK (posting_type IN ('Debit','Credit')),
  amount        numeric(14,2) NOT NULL,
  account_name  text NOT NULL,
  department_name text,
  class_name    text,
  memo          text,
  credit_bucket text,
  origin        text NOT NULL DEFAULT 'generated' CHECK (origin IN ('generated','manual','inter_entity')),
  source_row_keys text[] NOT NULL DEFAULT '{}',
  sort_order    int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounting.payroll_post_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  header_id       bigint,
  mode            text NOT NULL CHECK (mode IN ('dry_run','live')),
  entity          text NOT NULL,
  qb_realm        text,
  qb_doc_number   text,
  qb_entry_id     text,
  outcome         text NOT NULL,
  request_payload jsonb,
  response_status int,
  response_body   jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_lines_header_idx ON accounting.payroll_journal_lines(header_id);
CREATE INDEX IF NOT EXISTS payroll_audit_header_idx ON accounting.payroll_post_audit(header_id, created_at);
