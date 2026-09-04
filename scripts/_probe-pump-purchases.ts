/**
 * READ-ONLY probe: how many PUMPS were actually bought in 2026, at line level.
 *
 * ds-device-standard-cost-2026-09-03.md sec.11 compares modelled pump CONSUMPTION
 * ($390,484) against pump-vendor SPEND ($200,593) and gets 195%. Dollars against
 * dollars leaves price in the question. This counts UNITS off the invoice lines in
 * the OCR caches instead.
 *
 * Sources parsed:
 *   receipt-enrichment/cache/cosmeticpackaging/*.ocr.txt   (CPN, airless pumps + jars)
 *   receipt-enrichment/cache/device-pricing/*.txt          (Bottlemate, US Plastic, ULINE...)
 *
 * Run from web/:  npx tsx scripts/_probe-pump-purchases.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'C:/Users/Carson.D/Documents/GitHub/Active Development/Accounting-Analytics';
const CPN_DIR = join(REPO, 'receipt-enrichment/cache/cosmeticpackaging');
const DEVPRICE_DIR = join(REPO, 'receipt-enrichment/cache/device-pricing');

interface Line {
  readonly source: string;
  readonly invoice: string;
  readonly date: string;
  readonly desc: string;
  readonly sku: string;
  readonly qty: number;
  readonly unit: number;
}

const MONTHS: ReadonlyMap<string, string> = new Map<string, string>([
  ['January', '01'], ['February', '02'], ['March', '03'], ['April', '04'],
  ['May', '05'], ['June', '06'], ['July', '07'], ['August', '08'],
  ['September', '09'], ['October', '10'], ['November', '11'], ['December', '12'],
]);

function money(s: string): number | null {
  const m = /^\$?([0-9][0-9,]*\.[0-9]{2})$/.exec(s.trim());
  return m === null ? null : Number(m[1].replace(/,/g, ''));
}

function qtyOf(s: string): number | null {
  const m = /^[xX]?\s*([0-9][0-9,]*)$/.exec(s.trim());
  if (m === null) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * CPN invoice block shape (verified against 33587 / 34154 / 34918):
 *   description / $listPrice / [x]qty / $lineTotal / SKU / $netUnit
 * A single OCR file can carry several invoices ("Medrock invoices.pdf").
 */
function parseCpn(file: string, text: string): readonly Line[] {
  const lines = text.split(/\r?\n/).map((l): string => l.trim());
  const out: Line[] = [];
  let invoice = '';
  let date = '';
  for (let i = 0; i < lines.length; i += 1) {
    const inv = /^Invoice No\.?\s*([0-9]{4,})$/.exec(lines[i] ?? '');
    if (inv !== null) { invoice = inv[1]; continue; }
    const dt = /^Order Date\s+([A-Z][a-z]+)\s+([0-9]{1,2}),\s*([0-9]{4})$/.exec(lines[i] ?? '');
    if (dt !== null) {
      date = `${dt[3]}-${MONTHS.get(dt[1]) ?? '??'}-${String(dt[2]).padStart(2, '0')}`;
      continue;
    }
    const desc = lines[i] ?? '';
    const price = money(lines[i + 1] ?? '');
    const qty = qtyOf(lines[i + 2] ?? '');
    const total = money(lines[i + 3] ?? '');
    const sku = lines[i + 4] ?? '';
    const net = money(lines[i + 5] ?? '');
    if (price === null || qty === null || total === null || net === null) continue;
    if (desc === '' || /^\$/.test(desc) || /^(Subtotal|Total|Shipping)$/i.test(desc)) continue;
    if (!/^[0-9]{2}-[A-Z]{3}-/.test(sku)) continue;
    out.push({ source: file, invoice, date, desc, sku, qty, unit: net });
    i += 5;
  }
  return out;
}

/** True when a line is an airless pump/bottle body the classifier calls a "pump". */
function isPump(desc: string, sku: string): boolean {
  const d = desc.toUpperCase();
  if (d.includes('AIRLESS JAR')) return false; // White & Silver Jar, not a pump
  if (d.includes('AIRLESS')) return true;
  if (/PUMP/.test(d) && !/FOAM/.test(d)) return true;
  return /^(01|02|05|14|15|16|58|59|60|72)-/.test(sku) && d.includes('BOTTLE');
}

/** ML capacity from a CPN description ("Luxe 30 ML Airless Bottle ..."). */
function mlOf(desc: string): number | null {
  const m = /\b([0-9]{2,3})\s*ML\b/i.exec(desc);
  return m === null ? null : Number(m[1]);
}

function main(): void {
  const all: Line[] = [];
  for (const f of readdirSync(CPN_DIR)) {
    if (!f.endsWith('.ocr.txt')) continue;
    all.push(...parseCpn(f, readFileSync(join(CPN_DIR, f), 'utf8')));
  }

  // Dedupe: the same invoice is often cached from several mail threads.
  const seen = new Set<string>();
  const uniq: Line[] = [];
  for (const l of all) {
    const k = `${l.invoice}|${l.sku}|${l.qty}|${l.unit}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(l);
  }

  const in2026 = uniq.filter((l): boolean => l.date.startsWith('2026'));

  console.log('### Cosmetic Packaging Now — 2026 invoice lines parsed from the OCR cache');
  const invoices = new Map<string, { date: string; units: number; dollars: number }>();
  for (const l of in2026) {
    const acc = invoices.get(l.invoice) ?? { date: l.date, units: 0, dollars: 0 };
    acc.units += l.qty;
    acc.dollars += l.qty * l.unit;
    invoices.set(l.invoice, acc);
  }
  for (const [inv, a] of [...invoices.entries()].sort((x, y): number => x[1].date.localeCompare(y[1].date))) {
    console.log(`  inv ${inv}  ${a.date}  ${String(a.units).padStart(7)} units  $${a.dollars.toFixed(2)}`);
  }

  console.log('\n### CPN 2026 units by SKU');
  const bySku = new Map<string, { desc: string; qty: number; dollars: number; pump: boolean; ml: number | null }>();
  for (const l of in2026) {
    const acc = bySku.get(l.sku)
      ?? { desc: l.desc, qty: 0, dollars: 0, pump: isPump(l.desc, l.sku), ml: mlOf(l.desc) };
    acc.qty += l.qty;
    acc.dollars += l.qty * l.unit;
    bySku.set(l.sku, acc);
  }
  let pumpUnits = 0;
  let pumpDollars = 0;
  let otherUnits = 0;
  let otherDollars = 0;
  for (const [sku, a] of [...bySku.entries()].sort((x, y): number => y[1].qty - x[1].qty)) {
    console.log(
      `  ${a.pump ? 'PUMP ' : '     '}${sku.padEnd(14)} ${String(a.qty).padStart(7)} u  ` +
      `$${a.dollars.toFixed(2).padStart(10)}  ${a.ml === null ? '   ' : `${a.ml}ml`}  ${a.desc}`,
    );
    if (a.pump) { pumpUnits += a.qty; pumpDollars += a.dollars; }
    else { otherUnits += a.qty; otherDollars += a.dollars; }
  }
  console.log(`\n  CPN 2026 PUMP units ${pumpUnits}  ($${pumpDollars.toFixed(2)} goods)`);
  console.log(`  CPN 2026 other units ${otherUnits}  ($${otherDollars.toFixed(2)} goods)`);

  console.log('\n### CPN pump units by ML size (maps to the classifier SKU bands)');
  const byMl = new Map<number, number>();
  for (const a of bySku.values()) {
    if (!a.pump || a.ml === null) continue;
    byMl.set(a.ml, (byMl.get(a.ml) ?? 0) + a.qty);
  }
  for (const [ml, q] of [...byMl.entries()].sort((x, y): number => x[0] - y[0])) {
    console.log(`  ${String(ml).padStart(4)} ml : ${String(q).padStart(7)} units`);
  }

  console.log('\n### Bottlemate / other device-pricing cache — pump-ish lines (raw grep)');
  for (const f of readdirSync(DEVPRICE_DIR)) {
    if (!f.endsWith('.txt')) continue;
    const text = readFileSync(join(DEVPRICE_DIR, f), 'utf8');
    const hits = text.split(/\r?\n/).filter((l): boolean =>
      /airless|pump/i.test(l) && /[0-9]/.test(l));
    if (hits.length === 0) continue;
    console.log(`--- ${f}`);
    for (const h of hits.slice(0, 12)) console.log(`    ${h.trim()}`);
  }
}

main();
