/**
 * Bulk draft builder — the same path as POST /api/payroll/runs, month by month,
 * so a long historical backfill gives progress + a per-month summary instead of
 * one opaque call.
 *
 *   Preview (no writes):  npx tsx scripts/payroll/build-range.ts 2026-01-01 2026-07-31
 *   Apply (saves drafts): npx tsx scripts/payroll/build-range.ts 2026-01-01 2026-07-31 --apply
 *
 * Writes DRAFTS ONLY to accounting.payroll_journal_* — nothing posts to QuickBooks.
 * saveDraft upserts on (entity, pay_date, pay_group) and refuses to touch a header
 * already in 'posted' status, so re-running is safe.
 *
 * Decrypts payroll rows in memory (needs PAYROLL_ENC_KEY); no decrypted values are
 * persisted or logged — only aggregated JE lines, same as the API route.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { AccountMapRule, EmployeeMapRule } from '../../src/lib/payroll/types';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { selectSource } from '../../src/lib/payroll/source-select';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { getAccountMap, getEmployeeMap, saveDraft, sourceSnapshotHash } from '../../src/lib/payroll/store';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const start = process.argv[2];
const end = process.argv[3];
const apply = process.argv.includes('--apply');
if (!start || !end || !ISO.test(start) || !ISO.test(end)) {
  throw new Error('usage: build-range.ts <start YYYY-MM-DD> <end YYYY-MM-DD> [--apply]');
}

/** Inclusive month windows spanning [start, end], clipped to the real bounds. */
function monthWindows(startISO: string, endISO: string): Array<{ from: string; to: string; tag: string }> {
  const out: Array<{ from: string; to: string; tag: string }> = [];
  const s = new Date(`${startISO}T00:00:00Z`);
  const e = new Date(`${endISO}T00:00:00Z`);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  for (;;) {
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0));
    if (first > e) break;
    const from = first < s ? startISO : first.toISOString().slice(0, 10);
    const to = last > e ? endISO : last.toISOString().slice(0, 10);
    out.push({ from, to, tag: `${y}-${String(m + 1).padStart(2, '0')}` });
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main(): Promise<void> {
  console.log(`Range ${start} .. ${end}   mode=${apply ? 'APPLY (saves drafts)' : 'PREVIEW (no writes)'}`);

  const accountMapLists: AccountMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getAccountMap));
  const employeeMapLists: EmployeeMapRule[][] = await Promise.all(POSTABLE_ENTITIES.map(getEmployeeMap));
  const accountMap = accountMapLists.flat();
  const employeeMap = employeeMapLists.flat();
  console.log(`Maps loaded: ${accountMap.length} account rules, ${employeeMap.length} employee rules\n`);

  const source = selectSource();
  const allUnmapped = new Set<string>();
  const excludedTotals = new Map<string, number>();
  let totalDrafts = 0;
  let totalSaved = 0;
  let nonZeroVariance = 0;

  for (const w of monthWindows(start, end)) {
    const rows = await source.fetchRange(w.from, w.to);
    if (rows.length === 0) {
      console.log(`${w.tag}  no source rows`);
      continue;
    }
    const snapshot = sourceSnapshotHash(rows);
    const { drafts, unmappedColumns, excluded } = buildJournal(rows, accountMap, employeeMap);

    for (const c of unmappedColumns) allUnmapped.add(c);
    for (const g of excluded) excludedTotals.set(g.payGroup, (excludedTotals.get(g.payGroup) ?? 0) + g.count);
    totalDrafts += drafts.length;

    const varSum = drafts.reduce((a, d) => a + Math.abs(d.variance), 0);
    if (drafts.some((d) => Math.abs(d.variance) >= 0.005)) nonZeroVariance += 1;

    if (apply) {
      for (const draft of drafts) {
        await saveDraft(draft, snapshot);
        totalSaved += 1;
      }
    }

    const dates = [...new Set(drafts.map((d) => d.payDate))].length;
    console.log(
      `${w.tag}  rows=${String(rows.length).padStart(4)}  drafts=${String(drafts.length).padStart(3)}` +
        `  payDates=${String(dates).padStart(2)}  |variance|=${money(varSum).padStart(12)}` +
        `${unmappedColumns.length ? `  unmapped=${unmappedColumns.length}` : ''}`,
    );
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`drafts built : ${totalDrafts}${apply ? `  (saved ${totalSaved})` : '  (preview — nothing saved)'}`);
  console.log(`months with a non-zero-variance draft: ${nonZeroVariance}`);
  console.log(`\nunmapped columns across the whole range (${allUnmapped.size}):`);
  for (const c of [...allUnmapped].sort()) console.log(`  ${c}`);
  console.log(`\nexcluded pay groups:`);
  if (excludedTotals.size === 0) console.log('  none');
  for (const [g, n] of [...excludedTotals].sort()) console.log(`  ${g}: ${n} rows`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
