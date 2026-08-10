// buildVendorSplit returned null for the trial invoice. It has three null paths (vendor-split.ts):
// no suspense GL id, itemsTotal <= 0, or the built lines not summing to the txn amount. Which one
// fired matters: a missing suspense id is config, a sum mismatch is a parse/rounding problem, and
// each needs a different fix. This reproduces the build step by step. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-toprx-split-why.ts
import '../ramp-split-push/load-env';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { rampToken } from '../ramp-split-push/ramp-client';
import { parseTopRxInvoice } from './toprx-invoice';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import type { Entity } from '../ramp-split-push/types';
import { RC } from '../../paths';

const ENTITY: Entity = 'FL';
const PDF = `${RC.pdf}/toprx-FL-4569499.pdf`;
const TXN_CENTS = 31500;

async function main(): Promise<void> {
  const parsed = parseTopRxInvoice((await pdfParse(readFileSync(PDF))).text);
  if (parsed === null) { console.log('parseTopRxInvoice returned null'); return; }
  console.log(`parsedTotalCents=${parsed.parsedTotalCents} tax=${parsed.taxCents} shipping=${parsed.shippingCents} tip=${parsed.tipCents}`);
  console.log(`items=${parsed.items.length}`);
  for (const i of parsed.items) console.log(`  ${String(i.amountCents).padStart(9)}  ${i.desc.slice(0, 60)}`);
  const items = parsed.items.filter((i) => i.amountCents !== 0);
  const itemsTotal = items.reduce((a, b) => a + b.amountCents, 0);
  console.log(`\nnon-zero items=${items.length} itemsTotal=${itemsTotal}  (null if <= 0)`);
  console.log(`txnAmountCents=${TXN_CENTS}  itemsTotal+tax+ship+tip=${itemsTotal + parsed.taxCents + parsed.shippingCents + parsed.tipCents}`);

  const token = await rampToken(ENTITY, 'transactions:read');
  const gl = await buildGlIndex(ENTITY, token);
  console.log(`\nGL index: suspenseId=${gl.suspenseId ?? 'NULL  <- this alone returns null'}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
