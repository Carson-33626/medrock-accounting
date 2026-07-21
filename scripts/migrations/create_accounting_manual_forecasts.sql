-- Manual what-if forecasts for Location Analytics (dollar scenarios per location).
-- New table only; never modifying an existing migration.
CREATE TABLE IF NOT EXISTS source.accounting_manual_forecasts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  metric      text NOT NULL,          -- 'revenue' | 'grossProfit' | 'netIncome'
  basis       text NOT NULL,          -- 'Cash' | 'Accrual'
  entries     jsonb NOT NULL,         -- [{ "location": "MedRock FL", "sortKey": 202608, "amount": 500000 }]
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
