// READ-ONLY probe 3 — closes the last three gaps before any write plan can be costed:
//   A. Is the QuickbooksVendor / QuickbooksCategory field addressable via the accounting API at all?
//      (probe 2 proved `field_id=QuickbooksVendor` 422s — field_id wants the category_info UUID.)
//   B. Are FL's competing codings LIVE rules or historical residue? A one-time PATCH is worthless if
//      the Ramp workflow rule keeps re-coding new Amazon charges to Office Expense tomorrow.
//      -> month-by-month split of FL Amazon between 8220 Suspense and 6200.80 Office Expense.
//   C. Is TX's Ramp->QB sync even switched on (every TX Amazon txn is uncoded + NOT_SYNC_READY)?
//
// Zero writes.  Run from web/:  npx tsx scripts/probe-ramp-amazon-rule.ts
import './lib/load-env';
import { rampToken, rampGet } from './lib/ramp';
import type { Entity } from './lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE = 'transactions:read accounting:read';
const RETAIL_AMAZON = /amazon/i;
const NOT_RETAIL = /web\s*services|\baws\b|whole\s*foods|audible|kindle|prime\s*video|twitch|zappos/i;

// category_info.id UUIDs observed in probe 2 (FL). Confirmed live per entity below.
interface RawSel {
  name?: string | null;
  external_code?: string | null;
  external_id?: string | null;
  type?: string | null;
  source?: { type?: string | null } | null;
  category_info?: { id?: string | null; external_id?: string | null; name?: string | null } | null;
}
interface RawLine { memo?: string | null; accounting_field_selections?: RawSel[] | null }
interface RawTxn {
  id: string;
  amount: number;
  sync_status?: string | null;
  state?: string | null;
  user_transaction_time?: string | null;
  merchant_name?: string | null;
  merchant_descriptor?: string | null;
  accounting_field_selections?: RawSel[] | null;
  line_items?: RawLine[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

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

function glName(t: RawTxn): string {
  for (const l of t.line_items ?? []) {
    for (const s of l.accounting_field_selections ?? []) {
      if (s.type === 'GL_ACCOUNT') return `${s.external_code ?? ''} ${s.name ?? ''}`.trim();
    }
  }
  return '(uncoded)';
}
function vendorName(t: RawTxn): string {
  for (const s of t.accounting_field_selections ?? []) if (s.type === 'MERCHANT') return s.name ?? '(unnamed)';
  return '(none)';
}
function categoryUuids(t: RawTxn): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (sels: RawSel[] | null | undefined): void => {
    for (const s of sels ?? []) {
      const ext = s.category_info?.external_id;
      const id = s.category_info?.id;
      if (ext && id) m.set(ext, id);
    }
  };
  walk(t.accounting_field_selections);
  for (const l of t.line_items ?? []) walk(l.accounting_field_selections);
  return m;
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);
    const txns = await pullAll(entity, token);
    const amz = txns.filter((t) => RETAIL_AMAZON.test(t.merchant_name ?? '') && !NOT_RETAIL.test(`${t.merchant_name ?? ''} ${t.merchant_descriptor ?? ''}`));

    console.log(`\n================================ ${entity} ================================`);

    // ---- C. entity-wide sync health ----
    const sync = new Map<string, number>();
    for (const t of txns) bump(sync, t.sync_status ?? '(null)');
    console.log(`  ALL txns (${txns.length}) sync_status: ${[...sync.entries()].map(([k, n]) => `${k}=${n}`).join(', ')}`);
    const syncedDates = txns.filter((t) => t.sync_status === 'SYNCED').map((t) => (t.user_transaction_time ?? '').slice(0, 10)).sort();
    console.log(`  SYNCED date range: ${syncedDates.length ? `${syncedDates[0]} .. ${syncedDates[syncedDates.length - 1]}` : 'NONE — this entity has never synced a txn to QBO'}`);

    // ---- A. resolve the real accounting-field UUIDs, then re-probe field-options ----
    const uuids = new Map<string, string>();
    for (const t of amz) for (const [k, v] of categoryUuids(t)) uuids.set(k, v);
    console.log(`  accounting category UUIDs seen on Amazon txns:`);
    for (const [ext, id] of uuids) console.log(`     ${ext.padEnd(26)} -> ${id}`);
    for (const ext of ['QuickbooksVendor', 'QuickbooksCategory']) {
      const id = uuids.get(ext);
      if (!id) continue;
      const res = await rampGet<{ data?: { id: string; value: string }[] }>(entity, `/accounting/field-options?field_id=${id}&page_size=5`, token);
      const n = res.body.data?.length ?? 0;
      const sample = (res.body.data ?? []).slice(0, 5).map((o) => o.value).join(' | ');
      console.log(`     field-options(${ext}) -> HTTP ${res.status}, ${n} options: ${sample.slice(0, 160)}`);
    }

    // ---- B. month x GL x vendor: is the miscoding current or historical? ----
    const byMonth = new Map<string, Map<string, number>>();
    const vendorByMonth = new Map<string, Map<string, number>>();
    for (const t of amz) {
      const m = (t.user_transaction_time ?? '').slice(0, 7) || 'unknown';
      const g = byMonth.get(m) ?? new Map<string, number>();
      bump(g, glName(t));
      byMonth.set(m, g);
      const v = vendorByMonth.get(m) ?? new Map<string, number>();
      bump(v, vendorName(t));
      vendorByMonth.set(m, v);
    }
    console.log(`\n  --- Amazon by month: GL coding  ||  QB vendor ---`);
    for (const m of [...byMonth.keys()].sort().reverse().slice(0, 14)) {
      const gl = [...byMonth.get(m)!.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
      const vd = [...vendorByMonth.get(m)!.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
      console.log(`   ${m}  ${gl.padEnd(64)} || ${vd}`);
    }
  }
}

main().catch((e: Error) => { console.error(e); process.exit(1); });
