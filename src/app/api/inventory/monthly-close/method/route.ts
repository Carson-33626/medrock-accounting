import { NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/inventory/monthly-close/method — the live figures behind the
 * Methodology & Evidence sub-tab: per-entity monthly statement (beginning,
 * purchases, usage COGS, documented waste, count-residual shrink, ending) from
 * the FIFO valuation, plus the forward-vs-backward convergence control. Read
 * only; every number traces to inventory.fifo_valuation_summary /
 * fifo_rollback_valuation exactly as the close JEs do.
 */

const POSTABLE_FROM = '2026-03';
/** Beginning of the first postable month = ending of this one. */
const SEED_MONTH = '2026-02';

export interface MethodStatementRow {
  month: string;
  beginning: number | null;
  purchases: number;
  cogs: number;
  waste: number;
  shrink: number;
  ending: number;
  inProgress: boolean;
}

export interface MethodConvergenceRow {
  month: string;
  forward: number;
  backward: number;
  ratio: number | null;
}

export interface MethodResponse {
  postableFrom: string;
  latestMonth: string | null;
  wasteShrinkAvailable: boolean;
  statements: Record<string, MethodStatementRow[]>;
  convergence: MethodConvergenceRow[];
}

interface SummaryRow {
  location: string;
  as_of_month: string;
  ending: number;
  purchases: number;
  consumed: number;
  waste: number;
  shrink: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function GET() {
  try {
    const pool = getRdsPool();

    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'inventory' AND table_name = 'fifo_valuation_summary'
         AND column_name IN ('waste_value_in_month', 'shrink_value_in_month')`,
    );
    const wasteShrinkAvailable = cols.rows.length === 2;
    const wasteExpr = wasteShrinkAvailable ? 'COALESCE(waste_value_in_month, 0)::float8' : '0::float8';
    const shrinkExpr = wasteShrinkAvailable ? 'COALESCE(shrink_value_in_month, 0)::float8' : '0::float8';

    const result = await pool.query<SummaryRow>(
      `SELECT location, as_of_month,
              SUM(on_hand_value_fifo)::float8 AS ending,
              SUM(receipts_value_in_month)::float8 AS purchases,
              SUM(consumed_value_in_month)::float8 AS consumed,
              SUM(${wasteExpr})::float8 AS waste,
              SUM(${shrinkExpr})::float8 AS shrink
       FROM inventory.fifo_valuation_summary
       WHERE basis = 'accrual' AND as_of_month >= $1
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [SEED_MONTH],
    );

    const latestMonth = result.rows.reduce<string | null>(
      (max, r) => (max === null || r.as_of_month > max ? r.as_of_month : max),
      null,
    );

    const statements: Record<string, MethodStatementRow[]> = {};
    const byLocation = new Map<string, SummaryRow[]>();
    for (const r of result.rows) {
      const arr = byLocation.get(r.location);
      if (arr) arr.push(r);
      else byLocation.set(r.location, [r]);
    }
    for (const [location, rows] of byLocation) {
      const endingByMonth = new Map(rows.map((r) => [r.as_of_month, r.ending]));
      statements[location] = rows
        .filter((r) => r.as_of_month >= POSTABLE_FROM)
        .map((r) => {
          const priorMonth = `${r.as_of_month.slice(0, 5)}${String(Number(r.as_of_month.slice(5)) - 1).padStart(2, '0')}`;
          const yearWrapped =
            r.as_of_month.endsWith('-01')
              ? `${Number(r.as_of_month.slice(0, 4)) - 1}-12`
              : priorMonth;
          const beginning = endingByMonth.get(yearWrapped);
          return {
            month: r.as_of_month,
            beginning: beginning === undefined ? null : round2(beginning),
            purchases: round2(r.purchases),
            // Usage-driven COGS: total consumption minus the waste + shrink the
            // dedicated 5000.55 line carries (DS sec 21.2/23.1 — the columns sum
            // to the JE line by construction).
            cogs: round2(r.consumed - r.waste - r.shrink),
            waste: round2(r.waste),
            shrink: round2(r.shrink),
            ending: round2(r.ending),
            inProgress: r.as_of_month === latestMonth,
          };
        });
    }

    const rb = await pool.query<{ as_of_month: string; backward: number }>(
      `SELECT as_of_month, SUM(value_full)::float8 AS backward
       FROM inventory.fifo_rollback_valuation
       WHERE as_of_month >= $1
       GROUP BY 1 ORDER BY 1`,
      [POSTABLE_FROM],
    );
    const forwardByMonth = new Map<string, number>();
    for (const r of result.rows) {
      if (r.as_of_month < POSTABLE_FROM) continue;
      forwardByMonth.set(r.as_of_month, (forwardByMonth.get(r.as_of_month) ?? 0) + r.ending);
    }
    const convergence: MethodConvergenceRow[] = rb.rows.map((r) => {
      const forward = round2(forwardByMonth.get(r.as_of_month) ?? 0);
      return {
        month: r.as_of_month,
        forward,
        backward: round2(r.backward),
        ratio: r.backward > 0 ? Math.round((forward / r.backward) * 100) / 100 : null,
      };
    });

    const body: MethodResponse = {
      postableFrom: POSTABLE_FROM,
      latestMonth,
      wasteShrinkAvailable,
      statements,
      convergence,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('[inventory/monthly-close/method GET]', error);
    return NextResponse.json({ error: 'Failed to build the methodology figures' }, { status: 500 });
  }
}
