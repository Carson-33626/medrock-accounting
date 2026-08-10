// READ-ONLY follow-up probe. The first probe (probe-ramp-amazon-suspense.ts) surfaced a
// `QuickbooksVendor` selection of type MERCHANT sitting at TRANSACTION level on ~every Amazon txn,
// even though `/accounting/fields` does NOT list it. This probe answers the "fix the vendor to be
// just amazon" half of the ask:
//   - what distinct QuickbooksVendor values do Amazon txns actually carry, per entity
//   - what SETS them (source.type: WORKFLOW rule vs MANUAL vs AUTOMATIC merchant mapping)
//   - is that vendor field writable at all (does it appear under /accounting/field-options)
//   - do line-level memos exist that a line_items PATCH would destroy
//   - the full sync_status vocabulary across the whole book, not just Amazon
//
// Zero writes.  Run from web/:  npx tsx scripts/probe-ramp-amazon-vendor.ts
import './lib/load-env';
import { rampToken, rampGet, getRampFields } from './lib/ramp';
import type { Entity } from './lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE = 'transactions:read accounting:read';
const RETAIL_AMAZON = /amazon/i;
const NOT_RETAIL = /web\s*services|\baws\b|whole\s*foods|audible|kindle|prime\s*video|twitch|zappos/i;

interface RawSel {
  id?: string | null;
  name?: string | null;
  external_code?: string | null;
  external_id?: string | null;
  type?: string | null;
  source?: { type?: string | null } | null;
  category_info?: { external_id?: string | null; type?: string | null; name?: string | null } | null;
}
interface RawLine { amount?: number | null; memo?: string | null; accounting_field_selections?: RawSel[] | null }
interface RawTxn {
  id: string;
  amount: number;
  sync_status?: string | null;
  state?: string | null;
  user_transaction_time?: string | null;
  memo?: string | null;
  merchant_name?: string | null;
  merchant_descriptor?: string | null;
  merchant_id?: string | null;
  accounting_field_selections?: RawSel[] | null;
  line_items?: RawLine[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

function money(c: number): string {
  return (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function bump(m: Map<string, number>, k: string, n = 1): void { m.set(k, (m.get(k) ?? 0) + n); }

async function pullAll(entity: Entity, token: string): Promise<RawTxn[]> {
  const out: RawTxn[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 200 && next !== null; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
    if (res.status !== 200) break;
    const rows = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    next = res.body.page?.next ?? null;
  }
  return out;
}

function vendorSel(t: RawTxn): RawSel | null {
  for (const s of t.accounting_field_selections ?? []) {
    if (s.category_info?.external_id === 'QuickbooksVendor' || s.type === 'MERCHANT') return s;
  }
  return null;
}
function glSel(t: RawTxn): RawSel | null {
  for (const l of t.line_items ?? []) {
    for (const s of l.accounting_field_selections ?? []) {
      if (s.category_info?.external_id === 'QuickbooksCategory' || s.type === 'GL_ACCOUNT') return s;
    }
  }
  for (const s of t.accounting_field_selections ?? []) {
    if (s.category_info?.external_id === 'QuickbooksCategory' || s.type === 'GL_ACCOUNT') return s;
  }
  return null;
}

async function main(): Promise<void> {
  const allSync = new Map<string, number>();
  let firstDump = false;

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);
    const txns = await pullAll(entity, token);
    for (const t of txns) bump(allSync, `${t.sync_status ?? '(null)'}`);

    const amz = txns.filter((t) => RETAIL_AMAZON.test(t.merchant_name ?? '') && !NOT_RETAIL.test(`${t.merchant_name ?? ''} ${t.merchant_descriptor ?? ''}`));

    console.log(`\n======================= ${entity} — ${amz.length} retail Amazon txns =======================`);

    // ---- raw shape of one vendor selection, verbatim (field names matter for any future write) ----
    if (!firstDump) {
      const sample = amz.find((t) => vendorSel(t) !== null);
      if (sample) {
        console.log('  RAW txn-level accounting_field_selections of one Amazon txn:');
        console.log('  ' + JSON.stringify(sample.accounting_field_selections, null, 2).split('\n').join('\n  '));
        console.log('  RAW line_items:');
        console.log('  ' + JSON.stringify(sample.line_items, null, 2).split('\n').join('\n  '));
        firstDump = true;
      }
    }

    // ---- distinct vendor values ----
    const byVendor = new Map<string, { n: number; cents: number; ids: Set<string>; codes: Set<string>; sources: Map<string, number>; sync: Map<string, number> }>();
    for (const t of amz) {
      const v = vendorSel(t);
      const key = v ? (v.name ?? '(unnamed)') : '(NO VENDOR SET)';
      const g = byVendor.get(key) ?? { n: 0, cents: 0, ids: new Set<string>(), codes: new Set<string>(), sources: new Map<string, number>(), sync: new Map<string, number>() };
      g.n++;
      g.cents += Math.round(t.amount * 100);
      if (v?.id) g.ids.add(v.id);
      if (v?.external_code) g.codes.add(v.external_code);
      if (v?.external_id) g.codes.add(`ext:${v.external_id}`);
      bump(g.sources, v?.source?.type ?? '(none)');
      bump(g.sync, t.sync_status ?? '(null)');
      byVendor.set(key, g);
    }
    console.log('\n  --- QuickbooksVendor values on retail Amazon ---');
    for (const [name, g] of [...byVendor.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`   ${String(g.n).padStart(4)}x ${money(g.cents).padStart(13)}  vendor="${name}"`);
      console.log(`         ids=[${[...g.ids].join(',')}] codes=[${[...g.codes].join(',')}] source={${[...g.sources].map(([k, n]) => `${k}:${n}`).join(' ')}} sync={${[...g.sync].map(([k, n]) => `${k}:${n}`).join(' ')}}`);
    }

    // ---- NOT_SYNC_READY breakdown by current GL + coding source (what an override would destroy) ----
    const ns = amz.filter((t) => t.sync_status === 'NOT_SYNC_READY');
    const byGl = new Map<string, { n: number; cents: number; src: Map<string, number> }>();
    for (const t of ns) {
      const g = glSel(t);
      const key = g ? `${g.external_code ?? ''} ${g.name ?? ''}`.trim() : '(uncoded)';
      const b = byGl.get(key) ?? { n: 0, cents: 0, src: new Map<string, number>() };
      b.n++; b.cents += Math.round(t.amount * 100);
      bump(b.src, g?.source?.type ?? '(none)');
      byGl.set(key, b);
    }
    console.log(`\n  --- NOT_SYNC_READY (${ns.length}) current GL, by coding source ---`);
    for (const [k, b] of [...byGl.entries()].sort((a, b2) => b2[1].n - a[1].n)) {
      console.log(`   ${String(b.n).padStart(4)}x ${money(b.cents).padStart(13)}  ${k}  [${[...b.src].map(([s, n]) => `${s}:${n}`).join(' ')}]`);
    }

    // ---- line-level memos that a line_items PATCH would overwrite ----
    const lineCounts = new Map<string, number>();
    let withLineMemo = 0;
    for (const t of ns) {
      bump(lineCounts, `lines=${t.line_items?.length ?? 0}`);
      if ((t.line_items ?? []).some((l) => (l.memo ?? '').trim().length > 0)) withLineMemo++;
    }
    console.log(`\n  --- NOT_SYNC_READY line shape --- ${[...lineCounts.entries()].sort().map(([k, n]) => `${k}:${n}`).join('  ')}`);
    console.log(`      txns carrying a LINE-level memo (would be lost by a naive line_items PATCH): ${withLineMemo}`);
    const withTxnMemo = ns.filter((t) => (t.memo ?? '').trim().length > 0).length;
    console.log(`      txns carrying a TXN-level memo (untouched by line_items PATCH): ${withTxnMemo}`);

    // ---- is the vendor field addressable through the accounting API? ----
    const fields = await getRampFields(entity, token);
    console.log(`\n  --- /accounting/fields --- ${fields.map((f) => `${f.name}[${f.id}]`).join(' | ')}`);
    for (const probeId of ['QuickbooksVendor', 'QuickbooksCategory']) {
      const res = await rampGet<{ data?: { id: string; value: string }[]; error?: { message?: string } }>(
        entity,
        `/accounting/field-options?field_id=${probeId}&page_size=3`,
        token,
      );
      console.log(`      field-options?field_id=${probeId} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }
  }

  console.log('\n================ sync_status vocabulary across ALL txns (all entities) ================');
  for (const [k, n] of [...allSync.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
}

main().catch((e: Error) => { console.error(e); process.exit(1); });
