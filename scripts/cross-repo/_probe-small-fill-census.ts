/**
 * READ-ONLY: why does the Syringes rule fire so rarely?
 *
 * The v1 draft mapping (MRPBI docs/device-usage/device-mapping-draft.csv rows 4-6) routed
 * Keratosis + Infections fills at 5-10g to MD SYRINGE AIRLESS 10ML and called them "the airless
 * syringe's main volume". v2 replaced that with rule 26 — "CREAM/GEL/LOTION and qty <= 10" — at
 * position 26 of a FIRST-MATCH-WINS list. So any small fill whose NAME matches an earlier rule
 * (Wart Pen at 2, Nail Brush at 3, AK Pump at 21...) is taken before rule 26 is reached.
 *
 * This censuses every 2026 fill at qty <= 10 and shows which rule actually claims it, so the
 * syringe shortfall can be attributed to specific competing rules rather than guessed at.
 *
 * Run from web/:  npx tsx scripts/_probe-small-fill-census.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  DEVICE_RULES,
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  item: string | null;
  qty: string | null;
  location: string | null;
  month: string | null;
  fills: number;
}

const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Location' AS location
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label,
           row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item, d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'TN'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'FL'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'TX'
              ELSE '' END AS location,
         to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') AS month,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= $1
  GROUP BY 1, 2, 3, 4`;

const RULE_DEVICE = new Map<number, string>(DEVICE_RULES.map((r) => [r.id, r.device]));

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<FillRow>(FILLS_SQL, ['2026-01']);

  interface Cell { fills: number; items: Map<string, number> }
  const small = new Map<string, Cell>();   // fills with qty <= 10, by winning rule
  const small20 = new Map<string, Cell>(); // fills with qty <= 20, by winning rule
  let totalSmall = 0;
  let totalSmall20 = 0;
  let drynessV = 0;

  const put = (m: Map<string, Cell>, key: string, item: string, n: number): void => {
    const c = m.get(key) ?? { fills: 0, items: new Map<string, number>() };
    c.fills += n;
    c.items.set(item, (c.items.get(item) ?? 0) + n);
    m.set(key, c);
  };

  for (const r of rows) {
    if ((r.location ?? '') === '') continue;
    const item = r.item ?? '';
    const qty = deriveQty(r.qty);
    if (item.toUpperCase().includes('DRYNESS V')) drynessV += r.fills;
    if (qty === null) continue;
    const ruleId = classifyDeviceRule(item, deriveForm(item), qty);
    const res = resolveDevice(ruleId, qty);
    const key = `rule ${String(ruleId).padStart(2)}  ${RULE_DEVICE.get(ruleId) ?? 'Unmapped'}`;
    if (qty <= 10) { put(small, key, item, r.fills); totalSmall += r.fills; }
    if (qty <= 20) { put(small20, key, item, r.fills); totalSmall20 += r.fills; }
    void res;
  }

  const dump = (title: string, m: Map<string, Cell>, total: number): void => {
    console.log(`\n===== ${title} — ${total} fills =====`);
    for (const [key, c] of [...m.entries()].sort((a, b) => b[1].fills - a[1].fills)) {
      const top = [...c.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, v]) => `${v} ${n.slice(0, 44)}`).join(' | ');
      console.log(`${key.padEnd(30)} ${String(c.fills).padStart(7)}  ${((c.fills / total) * 100).toFixed(1).padStart(5)}%   ${top}`);
    }
  };

  dump('2026 fills at qty <= 10, by the rule that CLAIMS them', small, totalSmall);
  dump('2026 fills at qty <= 20, by the rule that CLAIMS them', small20, totalSmall20);
  console.log(`\nDRYNESS V fills in 2026 (rules 8/9): ${drynessV}`);

  await pool.end();
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
