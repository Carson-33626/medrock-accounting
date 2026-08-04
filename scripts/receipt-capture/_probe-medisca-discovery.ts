// Medisca discovery — the two facts that decide whether the Letco enrich pattern ports:
//
//   1. PER-DRAFT coding state. Letco's rule is "ANY coded line aborts the whole draft" (she uses
//      accounts we refuse to automate, so a half-coded draft is a judgement in progress). Medisca
//      shows 49 of 83 lines already coded, which is either "some drafts fully done" (fine — enrich
//      takes the rest) or "most drafts half-done" (the Letco rule would skip nearly everything and
//      enrich would be worthless without a different rule). Those need telling apart.
//   2. The GL rule from the accountant's own history, the way Letco's 508-of-516 product/shipping
//      split was mined. No rule, no automation.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-medisca-discovery.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';

import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const VENDOR_RE = /medisca/i;

interface DraftLine { memo?: string | null; amount?: { amount?: number } | null; accounting_field_selections?: { external_code?: string | null; name?: string | null }[] }
interface Draft {
  id?: string;
  invoice_number?: string | null;
  amount?: { amount?: number } | null;
  vendor?: { name?: string | null; id?: string } | null;
  line_items?: DraftLine[];
  invoice_urls?: string[];
}
interface DraftPage { data?: Draft[]; page?: { next?: string | null } }

interface QbLine {
  Amount?: number;
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string; value?: string } };
  ItemBasedExpenseLineDetail?: { ItemRef?: { name?: string } };
  Description?: string;
}
interface QbBill {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: { name?: string };
  Line?: QbLine[];
}

async function draftState(): Promise<void> {
  console.log('=== 1. Medisca drafts in Ramp: per-draft coding state ===');
  let fully = 0, none = 0, partial = 0, noLines = 0;
  const vendorIds = new Map<string, string>();
  const partialSamples: string[] = [];
  let multiLine = 0, total = 0;
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read');
    let url: string | null = '/bills/drafts?page_size=100';
    const drafts: Draft[] = [];
    for (let i = 0; i < 50 && url !== null; i++) {
      const res: { status: number; body: DraftPage } = await rampGet<DraftPage>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      drafts.push(...rows);
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
    for (const d of drafts) {
      if (!VENDOR_RE.test(d.vendor?.name ?? '')) continue;
      total++;
      if (d.vendor?.id) vendorIds.set(`${entity} "${d.vendor.name}"`, d.vendor.id);
      const lines = d.line_items ?? [];
      if (lines.length > 1) multiLine++;
      const coded = lines.filter((l) => (l.accounting_field_selections ?? []).length > 0).length;
      if (lines.length === 0) { noLines++; continue; }
      if (coded === 0) none++;
      else if (coded === lines.length) fully++;
      else {
        partial++;
        if (partialSamples.length < 5) partialSamples.push(`${entity} ${d.invoice_number ?? '?'} ${coded}/${lines.length} coded`);
      }
    }
  }
  console.log(`drafts=${total}  fully_coded=${fully}  UNCODED=${none}  partially_coded=${partial}  no_lines=${noLines}  multi_line=${multiLine}`);
  if (partialSamples.length) console.log(`partial samples: ${partialSamples.join(' | ')}`);
  console.log('\nBill Pay vendor UUIDs (use these for MEDISCA_RAMP_VENDOR_*, NOT the /accounting/vendors integer):');
  for (const [k, v] of vendorIds) console.log(`  ${k} -> ${v}`);
}

async function glRule(): Promise<void> {
  console.log('\n=== 2. GL rule mined from the accountant\'s own Medisca bills (QB, 2026) ===');
  const byAccount = new Map<string, { lines: number; cents: number }>();
  let bills = 0, lines = 0;
  const descByAccount = new Map<string, Set<string>>();
  for (const entity of ALL_ENTITIES) {
    const location = ENTITY_TO_QB_LOCATION[entity];
    const all = await qbQueryAll<QbBill>(location, 'Bill', `WHERE TxnDate >= '2026-01-01'`);
    const mine = all.filter((b) => VENDOR_RE.test(b.VendorRef?.name ?? ''));
    bills += mine.length;
    for (const b of mine) {
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name
          ?? (l.ItemBasedExpenseLineDetail?.ItemRef?.name ? `ITEM:${l.ItemBasedExpenseLineDetail.ItemRef.name}` : null);
        if (acct === null) continue;
        lines++;
        const prev = byAccount.get(acct) ?? { lines: 0, cents: 0 };
        prev.lines++;
        prev.cents += Math.round((l.Amount ?? 0) * 100);
        byAccount.set(acct, prev);
        const d = (l.Description ?? '').trim();
        if (d !== '') {
          const set = descByAccount.get(acct) ?? new Set<string>();
          if (set.size < 6) set.add(d.slice(0, 48));
          descByAccount.set(acct, set);
        }
      }
    }
    console.log(`  [${entity}] ${mine.length} Medisca bill(s) in QB since 2026-01-01`);
  }
  console.log(`\ntotal bills=${bills} coded lines=${lines}`);
  const rows = [...byAccount.entries()].sort((a, b) => b[1].lines - a[1].lines);
  for (const [acct, s] of rows) {
    const pct = lines === 0 ? 0 : Math.round((s.lines / lines) * 1000) / 10;
    console.log(`  ${acct.padEnd(52)} ${String(s.lines).padStart(4)} lines (${String(pct).padStart(5)}%)  $${(s.cents / 100).toFixed(2)}`);
    const d = descByAccount.get(acct);
    if (d) console.log(`      e.g. ${[...d].join(' | ')}`);
  }
  const top2 = rows.slice(0, 2).reduce((a, r) => a + r[1].lines, 0);
  console.log(`\ntop-2 accounts cover ${lines === 0 ? 0 : Math.round((top2 / lines) * 1000) / 10}% of lines (Letco's equivalent was 508/516 = 98.4%)`);
}

async function main(): Promise<void> {
  await draftState();
  await glRule();
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
