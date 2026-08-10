/**
 * READ-ONLY: how many MARKET-cost-centre people on real runs actually resolve to a market/title?
 *
 * WHY: the Review tab's person pills now show "Department · Market · Title" for marketers
 * (Carson, 2026-08-10 — "add in their market they cover for the marketers"). The market comes
 * from territory-snapshot.json, joined on NAME. If that join misses, the pill silently renders
 * department-only and the feature looks shipped while telling accounting nothing new. This
 * measures the hit rate before anyone relies on it.
 *
 * Prints names — they are already visible to any admin in the Review tab, and a coverage report
 * is useless without knowing WHO is unmatched. No dollar amounts, no decryption, no writes.
 *   npx tsx scripts/payroll/probe-marketer-territory-coverage.ts 2026
 */
import '../receipt-enrichment/engines/ramp-split-push/load-env';

import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { resolveRepTerritory, resolveDirector } from '../../src/lib/payroll/territory';

interface Row { name: string; home_department: string | null; location: string | null; pay_group: string }

async function main(): Promise<void> {
  const year = process.argv[2] ?? '2026';
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: RDS_SSL,
    connectionTimeoutMillis: Number(process.env.RDS_CONNECT_TIMEOUT_MS) || 30_000,
  });

  try {
    const { rows } = await pool.query<Row>(
      `SELECT DISTINCT name, home_department, location, pay_group
         FROM source.payroll_history
        WHERE to_date(pay_date,'MM/DD/YYYY') BETWEEN $1::date AND $2::date
        ORDER BY name`,
      [`${year}-01-01`, `${year}-12-31`],
    );

    const marketers = rows.filter((r) => costCenterFor(r.home_department) === 'MARKET');
    console.log(`\n${rows.length} distinct people in ${year}; ${marketers.length} in the MARKET cost centre\n`);

    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const r of marketers) {
      const rep = resolveRepTerritory(r.name);
      const dir = rep ? null : resolveDirector(r.name);
      const market = rep?.market ?? dir?.division ?? '';
      const title = rep?.title ?? dir?.title ?? '';
      const line = `${r.name.padEnd(28)} ${(r.location ?? '').padEnd(14)} ${market || '—'}${title ? ` · ${title}` : ''}`;
      if (market) matched.push(line); else unmatched.push(line);
    }

    console.log(`=== RESOLVED (${matched.length}/${marketers.length}) ===`);
    for (const l of matched) console.log('  ' + l);
    console.log(`\n=== NO TERRITORY MATCH (${unmatched.length}/${marketers.length}) ===`);
    for (const l of unmatched) console.log('  ' + l);

    const pct = marketers.length === 0 ? 0 : Math.round((matched.length / marketers.length) * 100);
    console.log(`\nCoverage: ${pct}% of marketers resolve to a market.`);

    // A non-marketer resolving to a territory would mean the MARKET gate is the only thing
    // standing between us and a wrong label — worth knowing how many that gate is catching.
    const falsePositives = rows
      .filter((r) => costCenterFor(r.home_department) !== 'MARKET')
      .filter((r) => resolveRepTerritory(r.name) !== null || resolveDirector(r.name) !== null);
    console.log(
      `\nNon-marketers that WOULD have been mislabelled without the MARKET gate: ${falsePositives.length}`,
    );
    for (const r of falsePositives) {
      console.log(`  ${r.name} (${r.home_department ?? 'no dept'}) -> ${resolveRepTerritory(r.name)?.market ?? resolveDirector(r.name)?.division}`);
    }
  } finally {
    await pool.end();
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
