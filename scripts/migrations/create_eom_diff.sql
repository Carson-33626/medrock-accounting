-- create_eom_diff.sql — daily month-end allocation difference check (DS 2026-09-25).
CREATE TABLE IF NOT EXISTS accounting.eom_diff_settings (
  id                int PRIMARY KEY CHECK (id = 1),
  threshold         numeric(12,2) NOT NULL DEFAULT 1,
  enabled           boolean NOT NULL DEFAULT true,
  check_from_month  text NOT NULL DEFAULT '2026-03',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text
);
INSERT INTO accounting.eom_diff_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS accounting.eom_diff_runs (
  id           serial PRIMARY KEY,
  trigger      text NOT NULL,              -- 'cron' | 'manual'
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  error        text
);

CREATE TABLE IF NOT EXISTS accounting.eom_diff_checks (
  month         text NOT NULL,             -- 'YYYY-MM'
  entity        text NOT NULL,
  run_id        int NOT NULL REFERENCES accounting.eom_diff_runs(id),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  delta_lines   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- JournalLine[]
  delta_debits  numeric(14,2) NOT NULL DEFAULT 0,
  error         text,
  PRIMARY KEY (month, entity)
);
