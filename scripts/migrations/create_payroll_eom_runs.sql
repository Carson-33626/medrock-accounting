-- create_payroll_eom_runs.sql — snapshot of what a month's allocation drafts were built from
CREATE TABLE IF NOT EXISTS accounting.payroll_eom_runs (
  month        text PRIMARY KEY,           -- 'YYYY-MM'
  pool         jsonb NOT NULL,             -- PoolLine[]
  revenue      jsonb NOT NULL,             -- RevenueTest + computed shares
  attention    jsonb NOT NULL DEFAULT '[]'::jsonb, -- passthrough/unknown PoolLine[]
  generated_at timestamptz NOT NULL DEFAULT now()
);
