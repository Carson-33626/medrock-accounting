-- create_ramp_split_push_audit.sql
-- Append-only audit + bugtracking log for the QB->Ramp Amazon split-push automation.
-- App-owned state on AWS RDS MedDotsPBI (accounting schema) — NOT a write to QB/Ramp.
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting.ramp_split_push_audit (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              uuid  NOT NULL,
  phase               text  NOT NULL,
  mode                text  NOT NULL,
  event_type          text  NOT NULL,
  outcome             text  NOT NULL,
  entity              text,
  ramp_transaction_id text,
  qb_realm            text,
  qb_doc_number       text,
  qb_entry_id         text,
  match_tier          text,
  drift               text,
  amount_cents        bigint,
  prior_state         jsonb,
  request_payload     jsonb,
  response_status     int,
  response_body       jsonb,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ramp_split_push_audit_event_chk CHECK (event_type IN ('match','write_split','write_memo','flag','skip','error')),
  CONSTRAINT ramp_split_push_audit_mode_chk  CHECK (mode IN ('dry_run','live'))
);

CREATE INDEX IF NOT EXISTS ramp_split_push_audit_run_idx   ON accounting.ramp_split_push_audit (run_id, created_at);
CREATE INDEX IF NOT EXISTS ramp_split_push_audit_txn_idx   ON accounting.ramp_split_push_audit (ramp_transaction_id);
CREATE INDEX IF NOT EXISTS ramp_split_push_audit_event_idx ON accounting.ramp_split_push_audit (event_type, outcome);
CREATE INDEX IF NOT EXISTS ramp_split_push_audit_order_idx ON accounting.ramp_split_push_audit (qb_doc_number);

COMMENT ON TABLE accounting.ramp_split_push_audit IS
  'Append-only audit + bugtracking log for the QB->Ramp Amazon split-push. App-owned RDS state; not a write to QB/Ramp.';
