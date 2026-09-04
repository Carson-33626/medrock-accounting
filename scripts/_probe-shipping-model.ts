/**
 * READ-ONLY: fit the shipping-packaging accrual parameters off the extracted bill
 * lines, and check the model against the shipment feed.
 *
 * Reads `docs/fifo-monthly-close/shipping-packaging-bill-lines-2026-09-04.csv`
 * (written by `_probe-shipping-purchases.ts`) — no new QuickBooks or RDS calls, so
 * this can be re-run freely while the model is argued over.
 *
 * Proves:
 *   1. 1220.30 monthly spend and DOCUMENT COUNT per entity — the trailing average
 *      and the entry clamp's denominator;
 *   2. the completeness curve fitted on 1220.30's OWN settled months, rather than
 *      borrowing the lab-supplies curve, and whether there is enough data to fit
 *      one at all;
 *   3. how lumpy the spend is (CV of monthly totals) — the number that decides
 *      how much a trailing average can be trusted here;
 *   4. the cold-chain share, split out of the same lines by description.
 *
 * Run from web/:  npx tsx scripts/_probe-shipping-model.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSV = resolve(
  process.cwd(),
  '..',
  'docs',
  'fifo-monthly-close',
  'shipping-packaging-bill-lines-2026-09-04.csv',
);

const ASSET_ACCT = '1220.30';
const LOCATIONS = ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const;
type Loc = (typeof LOCATIONS)[number];

/** Days after month-end at which a month is treated as fully settled. */
const SETTLE_DAYS = 300;
/** The day this analysis is anchored to — the probe pull date. */
const AS_OF = '2026-09-04';

const CURVE_POINTS: readonly number[] = [7, 14, 21, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300];

/** Descriptions that mark a cold-chain consumable rather than an ambient mailer. */
const COLD_CHAIN = /insulat|cold pack|ice pack|gel pack|cooler|thermal liner|refriger/i;

interface Row {
  location: string;
  docId: string;
  txnDate: string;
  month: string;
  createTime: string;
  entryLag: number | null;
  vendor: string;
  acctNum: string;
  amount: number;
  description: string;
  itemName: string;
}

/** Minimal RFC4180 line splitter — the writer quotes only when it must. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadRows(): Row[] {
  const text = readFileSync(CSV, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0]);
  const idx = (name: string): number => header.indexOf(name);
  const iLoc = idx('location');
  const iDoc = idx('doc_id');
  const iTxn = idx('txn_date');
  const iMon = idx('month');
  const iCre = idx('create_time');
  const iLag = idx('entry_lag_days');
  const iVen = idx('vendor');
  const iAcc = idx('acct_num');
  const iAmt = idx('amount');
  const iDes = idx('description');
  const iItm = idx('item_name');

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = splitCsvLine(lines[i]);
    if (c.length < header.length) continue;
    const lag = c[iLag] === '' ? null : Number(c[iLag]);
    rows.push({
      location: c[iLoc],
      docId: c[iDoc],
      txnDate: c[iTxn],
      month: c[iMon],
      createTime: c[iCre],
      entryLag: lag === null || Number.isNaN(lag) ? null : lag,
      vendor: c[iVen],
      acctNum: c[iAcc],
      amount: Number(c[iAmt]) || 0,
      description: c[iDes],
      itemName: c[iItm],
    });
  }
  return rows;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function monthEndIso(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface MonthStat {
  month: string;
  total: number;
  docs: number;
}

function monthlyStats(rows: readonly Row[], location: Loc): MonthStat[] {
  const totals = new Map<string, number>();
  const docs = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.location !== location || r.acctNum !== ASSET_ACCT) continue;
    totals.set(r.month, (totals.get(r.month) ?? 0) + r.amount);
    const set = docs.get(r.month) ?? new Set<string>();
    set.add(r.docId);
    docs.set(r.month, set);
  }
  return [...totals.keys()]
    .sort()
    .map((m) => ({ month: m, total: round2(totals.get(m) ?? 0), docs: docs.get(m)?.size ?? 0 }));
}

/**
 * Completeness at each curve point: for every month old enough to have settled,
 * what share of its eventual total was already keyed D days after month-end.
 */
function fitCurve(rows: readonly Row[], location: Loc): { points: Array<[number, number]>; months: string[] } {
  const byMonth = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.location !== location || r.acctNum !== ASSET_ACCT) continue;
    if (r.createTime === '') continue;
    const arr = byMonth.get(r.month) ?? [];
    arr.push(r);
    byMonth.set(r.month, arr);
  }

  const eligible: string[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    if (daysBetween(monthEndIso(month), AS_OF) >= SETTLE_DAYS) eligible.push(month);
  }

  const points: Array<[number, number]> = [];
  for (const d of CURVE_POINTS) {
    const shares: number[] = [];
    for (const month of eligible) {
      const lines = byMonth.get(month) ?? [];
      const eventual = lines.reduce((a, r) => a + r.amount, 0);
      if (eventual <= 0) continue;
      const cutoff = daysBetween(monthEndIso(month), AS_OF);
      void cutoff;
      const visible = lines
        .filter((r) => daysBetween(monthEndIso(month), r.createTime) <= d)
        .reduce((a, r) => a + r.amount, 0);
      shares.push(Math.max(0, Math.min(1, visible / eventual)));
    }
    const avg = shares.length === 0 ? 0 : shares.reduce((a, b) => a + b, 0) / shares.length;
    points.push([d, Math.round(avg * 1000) / 1000]);
  }
  return { points, months: eligible };
}

function main(): void {
  const rows = loadRows();
  console.log(`Loaded ${rows.length} lines from ${CSV}\n`);

  // --- 1. monthly totals + doc counts ------------------------------------
  console.log(`=== ${ASSET_ACCT} monthly spend and document count ===\n`);
  const stats = new Map<Loc, MonthStat[]>();
  for (const location of LOCATIONS) {
    const s = monthlyStats(rows, location);
    stats.set(location, s);
    console.log(`${location}:`);
    for (const m of s) {
      console.log(`   ${m.month}  $${m.total.toFixed(2).padStart(11)}   ${String(m.docs).padStart(3)} docs`);
    }
    console.log('');
  }

  // --- 2. how lumpy is it? ------------------------------------------------
  console.log('=== lumpiness of monthly spend (higher CV = a trailing average means less) ===\n');
  console.log(
    `${'location'.padEnd(13)} ${'window'.padEnd(20)} ${'n'.padStart(3)} ${'mean'.padStart(11)} ` +
      `${'stdev'.padStart(11)} ${'CV'.padStart(6)} ${'median'.padStart(10)} ${'zero mo'.padStart(8)}`,
  );
  for (const location of LOCATIONS) {
    const all = stats.get(location) ?? [];
    for (const [label, from, to] of [
      ['2025-01..2026-08', '2025-01', '2026-08'],
      ['2026-01..2026-08', '2026-01', '2026-08'],
    ] as ReadonlyArray<[string, string, string]>) {
      // Include months with no documents at all as genuine zeros.
      const months: string[] = [];
      const [fy, fm] = from.split('-').map(Number);
      const [ty, tm] = to.split('-').map(Number);
      for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m += 1) {
        if (m > 12) {
          m = 1;
          y += 1;
        }
        months.push(`${y}-${String(m).padStart(2, '0')}`);
      }
      const vals = months.map((m) => all.find((s) => s.month === m)?.total ?? 0);
      const n = vals.length;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      const zeros = vals.filter((v) => v === 0).length;
      console.log(
        `${location.padEnd(13)} ${label.padEnd(20)} ${String(n).padStart(3)} ` +
          `${mean.toFixed(2).padStart(11)} ${sd.toFixed(2).padStart(11)} ` +
          `${(mean === 0 ? 0 : sd / mean).toFixed(2).padStart(6)} ` +
          `${median(vals).toFixed(2).padStart(10)} ${String(zeros).padStart(8)}`,
      );
    }
  }
  console.log('');

  // --- 3. completeness curve, fitted on this account ----------------------
  console.log(`=== completeness curve fitted on ${ASSET_ACCT}'s own settled months ===\n`);
  for (const location of LOCATIONS) {
    const { points, months } = fitCurve(rows, location);
    console.log(`${location}: ${months.length} settled months (${months[0] ?? '—'} .. ${months[months.length - 1] ?? '—'})`);
    if (months.length === 0) {
      console.log('   NOT FITTABLE — no month is old enough to have settled.\n');
      continue;
    }
    console.log('   ' + points.map(([d, c]) => `${d}d=${(c * 100).toFixed(0)}%`).join('  '));
    console.log('');
  }

  // --- 4. entry lag -------------------------------------------------------
  console.log(`=== ${ASSET_ACCT} entry lag, all history (per document) ===\n`);
  console.log(`${'location'.padEnd(13)} ${'n'.padStart(5)} ${'min'.padStart(6)} ${'median'.padStart(7)} ${'p90'.padStart(6)} ${'max'.padStart(6)}`);
  for (const location of LOCATIONS) {
    const seen = new Set<string>();
    const lags: number[] = [];
    for (const r of rows) {
      if (r.location !== location || r.acctNum !== ASSET_ACCT || r.entryLag === null) continue;
      if (seen.has(r.docId)) continue;
      seen.add(r.docId);
      lags.push(r.entryLag);
    }
    lags.sort((a, b) => a - b);
    if (lags.length === 0) {
      console.log(`${location.padEnd(13)} ${'0'.padStart(5)}`);
      continue;
    }
    console.log(
      `${location.padEnd(13)} ${String(lags.length).padStart(5)} ${String(lags[0]).padStart(6)} ` +
        `${String(median(lags)).padStart(7)} ${String(lags[Math.floor(lags.length * 0.9)]).padStart(6)} ` +
        `${String(lags[lags.length - 1]).padStart(6)}`,
    );
  }
  console.log('');

  // --- 5. cold chain share ------------------------------------------------
  console.log('=== cold-chain share of 1220.30 spend, 2026 (by line description) ===\n');
  for (const location of LOCATIONS) {
    const y2026 = rows.filter(
      (r) => r.location === location && r.acctNum === ASSET_ACCT && r.month >= '2026-01',
    );
    const cold = y2026.filter((r) => COLD_CHAIN.test(`${r.description} ${r.itemName}`));
    const coldTotal = cold.reduce((a, r) => a + r.amount, 0);
    const total = y2026.reduce((a, r) => a + r.amount, 0);
    console.log(
      `${location.padEnd(13)} cold $${coldTotal.toFixed(2).padStart(10)} of $${total.toFixed(2).padStart(11)} ` +
        `= ${total === 0 ? '—' : ((coldTotal / total) * 100).toFixed(1) + '%'}   (${cold.length} of ${y2026.length} lines)`,
    );
    const byDesc = new Map<string, number>();
    for (const r of cold) {
      const key = (r.description || r.itemName).slice(0, 46);
      byDesc.set(key, round2((byDesc.get(key) ?? 0) + r.amount));
    }
    for (const [d, amt] of [...byDesc.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      $${amt.toFixed(2).padStart(9)}  ${d}`);
    }
  }
  console.log('');

  // --- 5b. pooled FL+TN curve, for TX to borrow ---------------------------
  console.log('=== pooled FL+TN curve (what TX borrows — it has 1 settled month) ===\n');
  {
    const fl = fitCurve(rows, 'MedRock FL');
    const tn = fitCurve(rows, 'MedRock TN');
    const wf = fl.months.length;
    const wt = tn.months.length;
    const pooled = fl.points.map(([d, c], i) => {
      const cn = tn.points[i][1];
      return [d, Math.round(((c * wf + cn * wt) / (wf + wt)) * 1000) / 1000] as [number, number];
    });
    console.log(`   weights FL=${wf} months, TN=${wt} months`);
    console.log('   ' + pooled.map(([d, c]) => `[${d}, ${c}]`).join(', '));
    console.log('');
    console.log('   FL: ' + fl.points.map(([d, c]) => `[${d}, ${c}]`).join(', '));
    console.log('   TN: ' + tn.points.map(([d, c]) => `[${d}, ${c}]`).join(', '));
    console.log('');
  }

  // --- 5c. trailing-12 average ending at the last SETTLED month -----------
  console.log('=== trailing-12 average, window ending at the last month >= 60d past month-end ===\n');
  for (const location of LOCATIONS) {
    const all = stats.get(location) ?? [];
    // Last month whose month-end is at least 60 days before AS_OF — this account's
    // own curve reaches 100% by 60 days, so anything older is settled.
    const [ay, am] = AS_OF.slice(0, 7).split('-').map(Number);
    let endY = ay;
    let endM = am;
    for (;;) {
      const m = `${endY}-${String(endM).padStart(2, '0')}`;
      if (daysBetween(monthEndIso(m), AS_OF) >= 60) break;
      endM -= 1;
      if (endM === 0) {
        endM = 12;
        endY -= 1;
      }
    }
    const window: string[] = [];
    for (let i = 11, y = endY, m = endM; i >= 0; i -= 1) {
      window.unshift(`${y}-${String(m).padStart(2, '0')}`);
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    const vals = window.map((m) => all.find((s) => s.month === m)?.total ?? 0);
    const active = vals.filter((v) => v !== 0).length;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    console.log(
      `${location.padEnd(13)} ${window[0]}..${window[window.length - 1]}  ` +
        `avg $${avg.toFixed(2).padStart(10)}   ${active}/12 months with activity` +
        `${active < 6 ? '   <-- THIN, flag it' : ''}`,
    );
  }
  console.log('');

  // --- 6. the ULINE figures Carson quoted ---------------------------------
  console.log('=== ULINE-only 2026 totals (the figures quoted in OPEN-DECISIONS C2) ===\n');
  for (const location of LOCATIONS) {
    const uline = rows.filter(
      (r) =>
        r.location === location &&
        r.acctNum === ASSET_ACCT &&
        r.month >= '2026-01' &&
        /uline/i.test(r.vendor),
    );
    const total = uline.reduce((a, r) => a + r.amount, 0);
    console.log(`${location.padEnd(13)} ULINE 2026 $${total.toFixed(2).padStart(10)}  (${uline.length} lines)`);
  }
  console.log('');
}

main();
