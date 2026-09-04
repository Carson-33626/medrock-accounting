/**
 * READ-ONLY: how many PAIRS of eye pads did purchasing actually buy in 2026, and where were
 * they coded? Reads the CSV produced by
 * receipt-enrichment/engines/receipt-capture/_probe-syringe-eyepad-tret-coding.ts.
 *
 * Each product name states its own pack size ("30 Pairs", "(50 Pairs)", "(100 Pairs)",
 * "6 Pairs"), so pairs = lineAmount / (per-pack price) * packSize is not needed — instead
 * pairs = (lineAmount / unitPackPrice) * packSize, where unitPackPrice is the MODE of the
 * cheapest single-pack price seen for that product. Simpler and defensible: derive $/pair from
 * the smallest observed line for each product (one pack) and divide total spend by it.
 *
 * Run from web/:  npx tsx scripts/_probe-eyepad-pairs.ts
 */
import { readFileSync } from 'node:fs';

const CSV =
  'C:\\Users\\Carson.D\\AppData\\Local\\Temp\\claude\\C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics\\177f3ac3-ddba-4363-878d-e00630b65e52\\scratchpad\\syringe-eyepad-tret-lines.csv';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\r') continue;
    cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** "30 Pairs" / "(100 Pairs)" / "6 Pairs" -> the number. */
function packPairs(desc: string): number | null {
  const m = /(\d+)\s*PAIRS?/i.exec(desc);
  return m === null ? null : Number(m[1]);
}

/** Product identity = brand + pack size, which is what the price attaches to. */
function productKey(desc: string): string {
  const brand = /^(?:[A-Za-z .'-]+? - )?(?:\d+ of: )?([A-Z][A-Za-z&]+)/.exec(desc.replace(/^.*?of:\s*/, ''));
  const pairs = packPairs(desc);
  const b = (brand?.[1] ?? desc.slice(0, 12)).toUpperCase();
  return `${b} ${pairs ?? '?'}pr`;
}

interface Row { loc: string; date: string; desc: string; amount: number; acct: string; acctName: string }

function main(): void {
  const rows = parseCsv(readFileSync(CSV, 'utf8'));
  const header = rows[0];
  const idx = (name: string): number => header.indexOf(name);
  const data: Row[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < header.length) continue;
    if (r[idx('bucket')] !== 'EYE PAD') continue;
    data.push({
      loc: r[idx('location')].replace('MedRock ', ''),
      date: r[idx('txnDate')],
      desc: r[idx('lineDescription')],
      amount: Number(r[idx('lineAmount')]),
      acct: r[idx('glAcctNum')],
      acctName: r[idx('glAccountName')],
    });
  }

  for (const year of ['2025', '2026']) {
    const yr = data.filter((d) => d.date.startsWith(year));
    console.log(`\n===== EYE PADS ${year} =====`);

    const byAcct = new Map<string, { lines: number; amount: number }>();
    for (const d of yr) {
      const k = `${d.acct} ${d.acctName}`;
      const a = byAcct.get(k) ?? { lines: 0, amount: 0 };
      a.lines += 1; a.amount += d.amount;
      byAcct.set(k, a);
    }
    console.log('-- GL coding --');
    for (const [k, v] of [...byAcct].sort((a, b) => b[1].amount - a[1].amount)) {
      console.log(`  ${k.padEnd(48)} ${String(v.lines).padStart(3)} lines  $${v.amount.toFixed(2).padStart(9)}`);
    }

    // Per product: cheapest positive line = one pack; use it to derive $/pair and pairs bought.
    const byProduct = new Map<string, { pairs: number | null; amount: number; lines: number; minLine: number }>();
    for (const d of yr) {
      const k = productKey(d.desc);
      const a = byProduct.get(k) ?? { pairs: packPairs(d.desc), amount: 0, lines: 0, minLine: Number.POSITIVE_INFINITY };
      a.amount += d.amount;
      a.lines += 1;
      if (d.amount > 0 && d.amount < a.minLine) a.minLine = d.amount;
      byProduct.set(k, a);
    }
    console.log('-- product / pairs bought (pairs = spend / single-pack price x pack size) --');
    let totalPairs = 0;
    let totalSpend = 0;
    for (const [k, v] of [...byProduct].sort((a, b) => b[1].amount - a[1].amount)) {
      const packs = v.minLine > 0 && Number.isFinite(v.minLine) ? v.amount / v.minLine : 0;
      const pairs = v.pairs === null ? 0 : packs * v.pairs;
      const perPair = pairs > 0 ? v.amount / pairs : 0;
      totalPairs += pairs;
      totalSpend += v.amount;
      console.log(
        `  ${k.padEnd(16)} spend $${v.amount.toFixed(2).padStart(8)}  1 pack $${(Number.isFinite(v.minLine) ? v.minLine : 0).toFixed(2).padStart(7)}  ` +
        `~${packs.toFixed(1).padStart(6)} packs  ~${pairs.toFixed(0).padStart(6)} pairs  $/pair ${perPair.toFixed(4)}`,
      );
    }
    console.log(`  TOTAL ${year}: $${totalSpend.toFixed(2)}   ~${totalPairs.toFixed(0)} pairs   blended $/pair ${(totalPairs > 0 ? totalSpend / totalPairs : 0).toFixed(4)}`);
  }
}

main();
