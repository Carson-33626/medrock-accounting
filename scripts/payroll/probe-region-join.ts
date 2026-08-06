/**
 * READ-ONLY validation: can we recover each marketer's REGION by joining payroll `name`
 * (plaintext) -> salesforce-conversion/config/territory_mapping.json (rep_name -> market)
 * -> Amy's QB Department? Plaintext only — NO decryption, no wage amounts. Reports, per
 * pay_group for 03/27/2026: matched region headcounts, UNMATCHED marketer names (actionable),
 * and how the recovered region SET compares to Amy's actual PR 2026.03.27 Departments.
 *   npx tsx scripts/payroll/probe-region-join.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const TERRITORY_FILE =
  'C:/Users/Carson.D/Documents/GitHub/Active Development/salesforce-conversion/config/territory_mapping.json';

// Salesforce "market" -> Amy's QB Department string (from PR 2026.03.27 marketing lines).
const MARKET_TO_QB_DEPT: Record<string, string> = {
  'Miami Region': 'Miami Region',
  'Orlando Region': 'Orlando Region',
  'Tampa Region': 'Tampa Region',
  'Naples Region': 'Tampa Region', // notes: merge Naples into Tampa
  'Jacksonville Region': 'Jax @ S GA Region',
  'South Georgia': 'Jax @ S GA Region',
  Remote: 'Puerto Rico Region', // Eileen Hernandez: merged from Puerto Rico into Remote
  Arizona: 'AZ Region',
  'North Georgia': 'N GA Region',
  'New England': 'NE Region',
  'Carolina Region': 'NC/SC Region',
  Michigan: 'Detroit Region',
  Tennessee: 'TN Region',
  Maryland: 'MD/DC/VA Region',
  'Colorado Region': 'CO Region',
  Illinois: 'IL Region',
  'Ohio Region': 'Ohio Region',
  Pennslyvania: 'PA Region',
  'Dallas Region': 'Dallas Region',
  'Houston Region': 'Houston Region',
  'Austin Region': 'Austin Region',
};

interface TerritoryRow { rep_name: string | null; market: string; period: number }
interface TerritoryFile { territories: TerritoryRow[] }

function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(jr|sr|ii|iii)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// ADP `name` is often "Last, First [Middle]" — produce a "first last" normalized key too.
function nameKeys(raw: string): string[] {
  const keys = new Set<string>();
  const n = norm(raw);
  keys.add(n);
  if (raw.includes(',')) {
    const [last, rest] = raw.split(',');
    const first = (rest ?? '').trim().split(/\s+/)[0] ?? '';
    keys.add(norm(`${first} ${last}`));
  }
  // first + last token only (drop middle names)
  const toks = n.split(' ');
  if (toks.length >= 2) keys.add(`${toks[0]} ${toks[toks.length - 1]}`);
  return [...keys];
}

async function main(): Promise<void> {
  const tf = JSON.parse(readFileSync(TERRITORY_FILE, 'utf-8')) as TerritoryFile;
  // Latest assignment per rep (max period), rep_name -> market.
  const repMarket = new Map<string, { market: string; period: number }>();
  for (const t of tf.territories) {
    if (!t.rep_name) continue;
    for (const k of nameKeys(t.rep_name)) {
      const cur = repMarket.get(k);
      if (!cur || t.period > cur.period) repMarket.set(k, { market: t.market, period: t.period });
    }
  }
  console.log(`territory file: ${tf.territories.length} rows, ${repMarket.size} rep-name keys`);

  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query<{ name: string; pg: string; sui: string }>(
      `SELECT name, pay_group pg, COALESCE(sui_sdi_tax_code,'?') sui
       FROM source.payroll_history
       WHERE home_department ILIKE 'MARKET%' AND pay_date = '03/27/2026'
       ORDER BY pay_group, name`);
    console.log(`\n03/27/2026 marketers: ${r.rows.length}`);

    const byPgRegion = new Map<string, Map<string, number>>();
    const unmatched: Array<{ pg: string; name: string; sui: string }> = [];
    for (const row of r.rows) {
      let hit: { market: string; period: number } | undefined;
      for (const k of nameKeys(row.name)) { hit = repMarket.get(k); if (hit) break; }
      const pgMap = byPgRegion.get(row.pg) ?? new Map<string, number>();
      if (!hit) {
        unmatched.push({ pg: row.pg, name: row.name, sui: row.sui });
        pgMap.set('(UNMATCHED)', (pgMap.get('(UNMATCHED)') ?? 0) + 1);
      } else {
        const dept = MARKET_TO_QB_DEPT[hit.market] ?? `(?market:${hit.market})`;
        pgMap.set(dept, (pgMap.get(dept) ?? 0) + 1);
      }
      byPgRegion.set(row.pg, pgMap);
    }

    for (const [pg, regions] of [...byPgRegion.entries()].sort()) {
      console.log(`\n=== ${pg} — recovered regions (marketer count) ===`);
      for (const [dept, n] of [...regions.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${dept}: ${n}`);
    }
    console.log(`\n=== UNMATCHED marketer names (need a territory_mapping entry / name fix) ===`);
    for (const u of unmatched) console.log(`  [${u.pg}] ${u.name}  (sui=${u.sui})`);
    console.log(`\nAmy's PR 2026.03.27 Departments — TN(9): AZ/N GA/NE/NC-SC/Detroit/TN/MD-DC-VA/CO/IL ; FL(6): Miami/Orlando/Tampa/Jax @ S GA/Puerto Rico/% Allocation`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
