// Diagnostic: split the "uncovered" merchant list into vendors already keyed into QuickBooks as
// Bills/Purchases (the accountant enters the emailed invoice by hand — a data-entry automation,
// NOT a receipt-capture gap) versus vendors with no QB presence (a true capture gap).
// One QB pass per entity, then cross-reference. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-uncovered-vs-qb.ts
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';
import { readFileSync } from 'node:fs';
import { RC } from '../../paths';

const SINCE = '2026-01-01';
const CSV = `${RC.out}/target-scan.csv`;

interface QBRef { value: string; name?: string }
interface QBDoc { Id: string; TxnDate?: string; TotalAmt?: number; VendorRef?: QBRef; EntityRef?: QBRef }

interface QBVendorAgg { docs: number; total: number }

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; } else { cur += c; }
  }
  out.push(cur);
  return out;
}

async function main(): Promise<void> {
  // 1. Every QB Bill/Purchase payee in 2026, rolled up.
  const qb = new Map<string, QBVendorAgg>();
  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    for (const kind of ['Bill', 'Purchase']) {
      try {
        const docs = await qbQueryAll<QBDoc>(loc, kind, `WHERE TxnDate >= '${SINCE}'`);
        for (const d of docs) {
          const payee = d.VendorRef?.name ?? d.EntityRef?.name ?? '';
          if (payee === '') continue;
          const k = norm(payee);
          const a = qb.get(k) ?? { docs: 0, total: 0 };
          a.docs++;
          a.total += d.TotalAmt ?? 0;
          qb.set(k, a);
        }
      } catch (e: unknown) {
        console.log(`[warn] ${entity} ${kind}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  console.log(`QB payees with 2026 Bill/Purchase activity: ${qb.size}\n`);

  // 2. Uncovered merchants from the last target scan.
  const lines = readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = parseCsvLine(lines[0]);
  const col = (n: string): number => header.indexOf(n);
  const rows = lines.slice(1).map(parseCsvLine).filter((r) => r[col('coverage')] === 'UNCOVERED');

  // A QB payee often carries a suffix ("Hospital Pharmaceutical Real Value - AutoPay CC"), so match
  // on containment either way rather than equality.
  const findQb = (merchant: string): { key: string; agg: QBVendorAgg } | null => {
    const m = norm(merchant);
    if (m.length < 4) return null;
    for (const [k, agg] of qb) {
      if (k.includes(m) || m.includes(k)) return { key: k, agg };
    }
    return null;
  };

  const inQb: string[] = [];
  const notInQb: string[] = [];
  for (const r of rows.slice(0, 40)) {
    const merchant = r[col('merchant')];
    const txns = r[col('txns')];
    const dollars = r[col('dollars')];
    const hit = findQb(merchant);
    const line = `${merchant.slice(0, 32).padEnd(33)} ${txns.padStart(4)} ${dollars.padStart(10)}`;
    if (hit) inQb.push(`${line}   QB: ${hit.agg.docs} docs $${hit.agg.total.toFixed(2)}`);
    else notInQb.push(line);
  }

  console.log('=== ALREADY IN QUICKBOOKS (accountant keys the invoice — data-entry automation, not receipt capture) ===');
  console.log('merchant                           txns          $   quickbooks');
  for (const l of inQb) console.log(`  ${l}`);

  console.log('\n=== NO QB BILL/PURCHASE — a genuine receipt-capture gap ===');
  console.log('merchant                           txns          $');
  for (const l of notInQb) console.log(`  ${l}`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
