// Probe: does Medisca need a CREATE mode at all?
//
// run-medisca.ts is enrich-only on the claim that "every Medisca invoice already has a draft". That
// claim was asserted, not measured. Measure it: line up Medisca invoice numbers across QuickBooks,
// Ramp bills and Ramp drafts and see who is missing from where.
//
// Note what this CANNOT see: an invoice that exists at Medisca but was never entered anywhere. Only
// the vendor portal knows that set. This bounds the gap from the inside.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-medisca-creategap.ts [since]
import '../ramp-split-push/load-env';
import { listDraftBills } from './bill-draft';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';

const VENDOR_RE = /medisca/i;
const SINCE = process.argv[2] ?? '2026-05-01';

interface QbBill { Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; VendorRef?: { name?: string } }
interface RampBill {
  id: string;
  invoice_number?: string | null;
  status?: string | null;
  issued_at?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { name?: string | null } | null;
}
interface BillPage { data?: RampBill[]; page?: { next?: string | null } }

function norm(n: string | null | undefined): string {
  // Medisca numbers are zero-padded 8-digit ("04234493") but QB sometimes drops the pad ("3865107").
  return (n ?? '').trim().replace(/^0+/, '');
}

async function listIssuedBills(entity: Entity, token: string): Promise<RampBill[]> {
  const out: RampBill[] = [];
  let url: string | null = '/bills?page_size=100';
  for (let i = 0; i < 50 && url !== null; i++) {
    const res: { status: number; body: BillPage } = await rampGet<BillPage>(entity, url, token);
    out.push(...(res.body.data ?? []));
    url = res.body.page?.next ?? null;
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`Medisca create-gap scan since ${SINCE}\n`);

  const qb = new Map<string, { entity: Entity; date: string; amt: number; doc: string }>();
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      const k = norm(b.DocNumber);
      if (k === '') continue;
      qb.set(k, { entity, date: b.TxnDate ?? '', amt: b.TotalAmt ?? 0, doc: b.DocNumber ?? '' });
    }
  }

  const drafts = new Map<string, { entity: Entity; id: string; amt: number; doc: string }>();
  const issued = new Map<string, { entity: Entity; id: string; status: string; amt: number; doc: string }>();
  const issuedInWindow = new Set<string>();
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read accounting:read');
    for (const d of (await listDraftBills(entity, token, rampGet)).filter((x) => VENDOR_RE.test(x.vendor?.name ?? ''))) {
      const k = norm(d.invoice_number);
      if (k !== '') drafts.set(k, { entity, id: d.id, amt: (d.amount?.amount ?? 0) / 100, doc: d.invoice_number ?? '' });
    }
    for (const b of (await listIssuedBills(entity, token)).filter((x) => VENDOR_RE.test(x.vendor?.name ?? ''))) {
      const k = norm(b.invoice_number);
      if (k !== '') issued.set(k, { entity, id: b.id, status: b.status ?? '', amt: (b.amount?.amount ?? 0) / 100, doc: b.invoice_number ?? '' });
      // The QB side is windowed to `since`; the Ramp side must be too, or "Ramp only" is just every
      // bill older than the window and means nothing.
      if (k !== '' && (b.issued_at ?? '') >= SINCE) issuedInWindow.add(k);
    }
  }

  console.log(`QuickBooks Medisca bills : ${qb.size} distinct invoice #`);
  console.log(`Ramp DRAFT bills         : ${drafts.size}`);
  console.log(`Ramp ISSUED bills        : ${issued.size}`);

  const inRamp = new Set([...drafts.keys(), ...issued.keys()]);
  const qbOnly = [...qb.keys()].filter((k) => !inRamp.has(k));
  const rampOnly = [...inRamp].filter((k) => !qb.has(k));
  const both = [...qb.keys()].filter((k) => inRamp.has(k));

  console.log(`\nIn BOTH                  : ${both.length}`);
  console.log(`QuickBooks ONLY (no Ramp record at all) : ${qbOnly.length}`);
  for (const k of qbOnly.sort().slice(0, 30)) {
    const v = qb.get(k);
    if (v) console.log(`    ${v.doc.padEnd(10)} ${v.entity} ${v.date} $${v.amt.toFixed(2)}`);
  }
  const draftOnly = rampOnly.filter((k) => drafts.has(k) && !issued.has(k));
  const issuedOnlyWindowed = rampOnly.filter((k) => issuedInWindow.has(k));
  console.log(`\nRamp ONLY, issued within the window     : ${draftOnly.length + issuedOnlyWindowed.length}`);
  console.log(`    still a DRAFT (expected — awaiting her approval) : ${draftOnly.length}`);
  console.log(`    issued bill not yet in QuickBooks               : ${issuedOnlyWindowed.length}`);
  for (const k of issuedOnlyWindowed.sort().slice(0, 15)) {
    const v = issued.get(k);
    if (v) console.log(`      ${v.doc.padEnd(10)} ${v.entity} ${v.status} $${v.amt.toFixed(2)}`);
  }

  // Duplicate-key safety: would invoice number alone be a safe dedupe key across entities?
  console.log('\n--- would invoice # alone be a safe dedupe key? ---');
  const perEntity = new Map<string, Set<Entity>>();
  for (const [k, v] of qb) perEntity.set(k, new Set([v.entity]));
  for (const [k, v] of drafts) perEntity.set(k, (perEntity.get(k) ?? new Set<Entity>()).add(v.entity));
  for (const [k, v] of issued) perEntity.set(k, (perEntity.get(k) ?? new Set<Entity>()).add(v.entity));
  const shared = [...perEntity].filter(([, s]) => s.size > 1);
  console.log(`invoice numbers seen under MORE THAN ONE entity: ${shared.length}`);
  for (const [k, s] of shared.slice(0, 10)) console.log(`    ${k} -> ${[...s].join(',')}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
