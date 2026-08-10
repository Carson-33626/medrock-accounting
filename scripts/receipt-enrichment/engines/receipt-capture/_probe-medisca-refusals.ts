// Probe: dump the FULL line detail of every Medisca draft the classifier refused, plus scan every
// Medisca draft for the zero/negative "free item" pattern (a cost line paired with a credit line).
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-medisca-refusals.ts
import '../ramp-split-push/load-env';
import { listDraftBills, isGlCoded } from './bill-draft';
import type { RampDraftBill } from './bill-draft';
import { planMediscaEnrichment, recordHistory, classifyLine } from './medisca-gl';
import type { MediscaHistory, MediscaDraftLine } from './medisca-gl';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';

const VENDOR_RE = /medisca/i;
const SINCE = '2023-01-01';

interface QbLine { Description?: string; Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: QbLine[] }

async function buildHistory(): Promise<{ history: MediscaHistory; bills: QbBill[] }> {
  const history: MediscaHistory = new Map();
  const all: QbBill[] = [];
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      all.push(b);
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const desc = (l.Description ?? '').trim();
        if (!acct || desc === '') continue;
        recordHistory(history, desc, acct.split(' ')[0]);
      }
    }
  }
  return { history, bills: all };
}

function toDraftLines(d: RampDraftBill): MediscaDraftLine[] {
  return (d.line_items ?? []).map((l) => ({
    amountCents: l.amount?.amount ?? 0,
    memo: l.memo ?? '',
    coded: isGlCoded(l.accounting_field_selections),
  }));
}

async function main(): Promise<void> {
  const { history, bills } = await buildHistory();
  console.log(`history: ${bills.length} QB Medisca bills, ${history.size} distinct items\n`);

  let zeroOrNegative = 0;
  let totalLines = 0;

  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read accounting:read');
    const drafts = (await listDraftBills(entity, token, rampGet))
      .filter((d) => VENDOR_RE.test(d.vendor?.name ?? ''));

    for (const d of drafts) {
      const lines = toDraftLines(d);
      totalLines += lines.length;
      const odd = lines.filter((l) => l.amountCents <= 0);
      if (odd.length > 0) {
        zeroOrNegative += odd.length;
        console.log(`[${entity}] ZERO/NEG  inv=${d.invoice_number} draft=${d.id} total=$${((d.amount?.amount ?? 0) / 100).toFixed(2)}`);
        for (const l of lines) console.log(`         ${(l.amountCents / 100).toFixed(2).padStart(10)}  ${l.memo}`);
      }

      const plan = planMediscaEnrichment(lines, history);
      if (plan.ok || plan.reason !== 'unclassifiable') continue;

      console.log(`\n[${entity}] REFUSED  inv=${d.invoice_number}  draft=${d.id}  total=$${((d.amount?.amount ?? 0) / 100).toFixed(2)}  lines=${lines.length}`);
      for (const l of lines) {
        const v = classifyLine(l.memo, history);
        const mark = v.account === null ? '  <-- BLOCKS' : '';
        console.log(`    $${(l.amountCents / 100).toFixed(2).padStart(9)}  ${(v.account ?? '  ??  ').padEnd(8)} ${v.reason.padEnd(34)} ${JSON.stringify(l.memo)}${mark}`);
      }
    }
  }

  console.log(`\n--- free-item scan: ${zeroOrNegative} zero/negative line(s) across ${totalLines} draft line(s) ---`);

  // The same scan on the QB side: if the team books a free item as cost + credit, her own history
  // will contain the negative half, and we need to know which account it lands on.
  let qbNeg = 0;
  for (const b of bills) {
    for (const l of b.Line ?? []) {
      if ((l.Amount ?? 0) > 0) continue;
      qbNeg++;
      if (qbNeg <= 25) {
        console.log(`  QB ${b.TxnDate} ${b.DocNumber ?? ''} $${(l.Amount ?? 0).toFixed(2)} ${l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '(no acct)'} :: ${l.Description ?? ''}`);
      }
    }
  }
  console.log(`--- QB history: ${qbNeg} zero/negative line(s) ---`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
