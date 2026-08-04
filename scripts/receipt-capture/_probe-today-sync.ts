// Diagnostic: did this morning's ULINE enrichment flip those txns toward SYNCED? If a receipt +
// GL coding makes a txn sync-ready, it will post into QB as a Purchase — and for a vendor whose
// invoices Barbara already keys as Bills, that is a DOUBLE COUNT we would have created.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-today-sync.ts [YYYY-MM-DD]
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';
import { readFileSync } from 'node:fs';

const DAY = process.argv[2] ?? '2026-08-04';
const AUDIT = 'scripts/receipt-capture/out/receipt-capture-audit.csv';

interface Txn {
  id: string;
  amount: number;
  merchant_name: string | null;
  state: string | null;
  sync_status: string | null;
  receipts: string[] | null;
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
  const lines = readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = parseCsvLine(lines[0]);
  const ix = {
    ts: header.indexOf('ts'),
    vendor: header.indexOf('vendor'),
    entity: header.indexOf('entity'),
    txn: header.indexOf('txn_id'),
    action: header.indexOf('action'),
    status: header.indexOf('status'),
  };

  // txns that actually received a receipt today
  const targets = new Map<string, Entity>();
  for (const l of lines.slice(1)) {
    const r = parseCsvLine(l);
    if (!r[ix.ts].startsWith(DAY)) continue;
    if (r[ix.vendor] !== 'uline') continue;
    if (r[ix.action] !== 'attach_receipt' || r[ix.status] !== '201') continue;
    targets.set(r[ix.txn], r[ix.entity] as Entity);
  }
  console.log(`ULINE txns receipted on ${DAY}: ${targets.size}\n`);

  const byStatus = new Map<string, number>();
  for (const [txnId, entity] of targets) {
    const token = await rampToken(entity, 'transactions:read');
    const res = await rampGet<Txn>(entity, `/transactions/${txnId}`, token);
    const t = res.body;
    const key = `${t.state ?? '?'} / sync=${t.sync_status ?? 'null'}`;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    console.log(`  ${entity}  ${txnId.slice(0, 8)}  $${Math.abs(t.amount).toFixed(2).padStart(9)}  receipts=${(t.receipts ?? []).length}  ${key}`);
  }

  console.log('\n=== rollup ===');
  for (const [k, n] of [...byStatus.entries()].sort()) console.log(`  ${k.padEnd(34)} ${n}`);
  const risky = [...byStatus.entries()].filter(([k]) => !k.includes('NOT_SYNC_READY')).reduce((s, [, n]) => s + n, 0);
  console.log(
    risky > 0
      ? `\n⚠ ${risky} txn(s) are no longer NOT_SYNC_READY — they may post to QB as Purchases and duplicate Barbara's Bills.`
      : '\nAll still NOT_SYNC_READY — receipt + coding alone did NOT make them sync-ready. No duplicate risk from this morning.',
  );
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
