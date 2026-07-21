-- Barbara 2026-07-21: a marketer legitimately kept on '% Allocation' (e.g. a director with no
-- territory like Lockwood) re-flagged forever in the "Marketers needing region review" worklist,
-- because saving '% Allocation' re-satisfies the flag condition. Add a `reviewed` marker so an
-- accountant can confirm the assignment (any region, including '% Allocation') and have the marketer
-- drop off the list. Additive + default false, so existing rows keep re-flagging until confirmed.
ALTER TABLE accounting.payroll_employee_map
  ADD COLUMN IF NOT EXISTS reviewed boolean NOT NULL DEFAULT false;
