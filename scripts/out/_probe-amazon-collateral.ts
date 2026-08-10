// READ-ONLY: for the exact 230 txns a "recode everything not synced to Suspense" pass would touch,
// what ELSE rides on their line_items? A `PATCH /transactions {line_items:[...]}` REPLACES the whole
// line array, so any line-level selection we do not re-send (Class, Billable, Inventory Item,
// Customer) is destroyed. Quantify that collateral before costing the write.
import '../lib/load-env';
import { rampToken, rampGet } from '../lib/ramp';
import type { Entity } from '../lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const RETAIL_AMAZON = /amazon/i;
const NOT_RETAIL = /web\s*services|\baws\b|whole\s*foods|audible|kindle|prime\s*video|twitch|zappos/i;

interface RawSel {
  name?: string | null;
  external_code?: string | null;
  external_id?: string | null;
  type?: string | null;
  category_info?: { external_id?: string | null } | null;
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

async function main(): Promise<void> {
  const lineFields = new Map<string, number>();
  const txnFields = new Map<string, number>();
  const classValues = new Map<string, number>();
  const deptValues = new Map<string, number>();
  let targets = 0;

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'transactions:read accounting:read');
    const rows: RawTxn[] = [];
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 200 && next !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
      if (res.status !== 200) break;
      const page = res.body.data ?? [];
      rows.push(...page);
      if (page.length === 0) break;
      next = res.body.page?.next ?? null;
    }
    for (const t of rows) {
      const nm = `${t.merchant_name ?? ''} ${t.merchant_descriptor ?? ''}`;
      if (!RETAIL_AMAZON.test(t.merchant_name ?? '') || NOT_RETAIL.test(nm)) continue;
      if (t.sync_status !== 'NOT_SYNC_READY') continue;
      const gl = (t.line_items ?? []).flatMap((l) => l.accounting_field_selections ?? []).find((s) => s.type === 'GL_ACCOUNT');
      if (gl?.external_code === '8220') continue; // already Suspense -> no-op, not a target
      targets++;
      for (const l of t.line_items ?? []) {
        for (const s of l.accounting_field_selections ?? []) {
          const ext = s.category_info?.external_id ?? '(none)';
          bump(lineFields, `${entity} ${ext}`);
          if (ext === 'QuickbooksClass') bump(classValues, `${entity} ${s.name ?? ''}`);
        }
      }
      for (const s of t.accounting_field_selections ?? []) {
        const ext = s.category_info?.external_id ?? '(none)';
        bump(txnFields, `${entity} ${ext}`);
        if (ext === 'QuickbooksDepartment') bump(deptValues, `${entity} ${s.name ?? ''}`);
      }
    }
  }

  console.log(`TARGETS (retail Amazon, NOT_SYNC_READY, not already 8220): ${targets}\n`);
  console.log('LINE-level selections on those targets (destroyed unless re-sent in the PATCH):');
  for (const [k, n] of [...lineFields].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}x  ${k}`);
  console.log('\nTXN-level selections on those targets (NOT touched by a line_items PATCH):');
  for (const [k, n] of [...txnFields].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}x  ${k}`);
  if (classValues.size) { console.log('\n  Class values at risk:'); for (const [k, n] of classValues) console.log(`     ${n}x ${k}`); }
  if (deptValues.size) { console.log('\n  Location/Department values (txn-level, safe):'); for (const [k, n] of deptValues) console.log(`     ${n}x ${k}`); }
}
main().catch((e: Error) => { console.error(e); process.exit(1); });
