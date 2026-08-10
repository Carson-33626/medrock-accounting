// READ-ONLY probe for the accounting-meeting ask:
//   "All amazon on Ramp must be filed into suspense / Override anything that is not synced /
//    Don't change memos / fix the vendor to be just amazon"
//
// Zero writes. Answers, per entity (FL/TN/TX):
//   1. how many Amazon-ish txns exist, by sync_status and by state
//   2. the DISTINCT merchant_name variants (so we can see what "just amazon" has to collapse),
//      deliberately using a WIDE net (aws/audible/kindle/whole foods/zappos/twitch/prime) so that
//      non-retail Amazon businesses surface and can be EXCLUDED rather than silently swept in
//   3. the GL account each currently carries (txn-level + line-level selections, with the coding
//      SOURCE so workflow-rule codings are distinguishable from human ones)
//   4. every accounting FIELD the entity exposes (is there a writable vendor field at all?)
//   5. the entity-specific Suspense (acct 8220) option id, resolved live — never hardcoded
//
// Run from web/:  npx tsx scripts/probe-ramp-amazon-suspense.ts
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet, getRampAccounts, getRampFields } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE = 'transactions:read accounting:read';
const OUT = 'scripts/out';
const SUSPENSE_CODE = '8220';

// WIDE on purpose — the point is to SEE the variants, not to pre-filter them. Classification into
// retail-Amazon vs a different Amazon business happens after, explicitly, in classifyVariant().
const AMAZON_NET =
  /amazon|amzn|\baws\b|audible|kindle|zappos|twitch|abebooks|goodreads|\bwoot\b|whole\s*foods|prime\s*video|ring\.com|\bimdb\b/i;

// Businesses that share the Amazon brand but are NOT retail Amazon purchases. These must never be
// swept into a blanket "code all Amazon to Suspense" rule — AWS in particular is infrastructure
// spend that already has a real GL home.
const NOT_RETAIL_AMAZON: { label: string; test: RegExp }[] = [
  { label: 'AWS / infrastructure', test: /\baws\b|amazon\s*web\s*services/i },
  { label: 'Whole Foods (grocery)', test: /whole\s*foods/i },
  { label: 'Audible (subscription)', test: /audible/i },
  { label: 'Kindle (content)', test: /kindle/i },
  { label: 'Prime Video (content)', test: /prime\s*video/i },
  { label: 'Twitch', test: /twitch/i },
  { label: 'Zappos', test: /zappos/i },
  { label: 'Ring', test: /ring\.com/i },
  { label: 'IMDb', test: /\bimdb\b/i },
];

function classifyVariant(name: string): string {
  for (const g of NOT_RETAIL_AMAZON) if (g.test.test(name)) return g.label;
  return 'retail Amazon';
}

interface RawSel {
  name?: string | null;
  external_code?: string | null;
  type?: string | null;
  source?: { type?: string | null } | null;
  category_info?: { external_id?: string | null; type?: string | null; name?: string | null } | null;
}
interface RawLine {
  amount?: number | null;
  memo?: string | null;
  accounting_field_selections?: RawSel[] | null;
}
interface RawTxn {
  id: string;
  amount: number;
  state?: string | null;
  sync_status?: string | null;
  user_transaction_time?: string | null;
  memo?: string | null;
  merchant_name?: string | null;
  merchant_descriptor?: string | null;
  merchant_id?: string | null;
  sk_category_name?: string | null;
  card_holder?: { first_name?: string | null; last_name?: string | null } | null;
  accounting_field_selections?: RawSel[] | null;
  line_items?: RawLine[] | null;
  receipts?: string[] | null;
}
interface Page {
  data: RawTxn[];
  page?: { next?: string };
}

interface Hit {
  entity: Entity;
  txn: RawTxn;
}

function money(cents: number): string {
  return (cents < 0 ? '-$' : '$') + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function cents(t: RawTxn): number {
  return Math.round((t.amount ?? 0) * 100);
}
function holder(t: RawTxn): string {
  const h = t.card_holder;
  return h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() : '';
}
function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function pullAll(entity: Entity, token: string): Promise<RawTxn[]> {
  const out: RawTxn[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 200 && next !== null; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
    if (res.status !== 200) {
      console.error(`  ${entity} page ${i}: HTTP ${res.status}`);
      break;
    }
    const rows = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    next = res.body.page?.next ?? null;
  }
  return out;
}

// Every accounting selection on the txn, flattened (txn-level AND line-level) so we can see both
// which FIELD ids exist in the wild and what each Amazon txn is currently coded to.
interface FlatSel {
  fieldExternalId: string;
  fieldType: string;
  selType: string;
  name: string;
  code: string;
  source: string;
  level: 'txn' | 'line';
}
function flatten(t: RawTxn): FlatSel[] {
  const out: FlatSel[] = [];
  const push = (s: RawSel, level: 'txn' | 'line'): void => {
    out.push({
      fieldExternalId: s.category_info?.external_id ?? '(none)',
      fieldType: s.category_info?.type ?? '',
      selType: s.type ?? '',
      name: s.name ?? '',
      code: s.external_code ?? '',
      source: s.source?.type ?? '',
      level,
    });
  };
  for (const s of t.accounting_field_selections ?? []) push(s, 'txn');
  for (const l of t.line_items ?? []) for (const s of l.accounting_field_selections ?? []) push(s, 'line');
  return out;
}

function glOf(t: RawTxn): { name: string; code: string; source: string } {
  const gl = flatten(t).find((s) => s.selType === 'GL_ACCOUNT' || s.fieldExternalId === 'QuickbooksCategory');
  return gl ? { name: gl.name, code: gl.code, source: gl.source } : { name: '(uncoded)', code: '', source: '' };
}

function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const hits: Hit[] = [];
  const totalsByEntity = new Map<Entity, number>();
  const suspense = new Map<Entity, { id: string; name: string } | null>();
  const fieldsByEntity = new Map<Entity, { id: string; rampId: string; name: string }[]>();

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPE);

    // Suspense id, resolved live from THIS entity's chart (ids differ per QB company).
    const accounts = await getRampAccounts(entity, token);
    const sus = accounts.find((a) => a.code === SUSPENSE_CODE) ?? null;
    suspense.set(entity, sus ? { id: sus.id, name: sus.name } : null);

    // What accounting fields does the connection even expose? (is a vendor field writable?)
    fieldsByEntity.set(entity, await getRampFields(entity, token));

    const txns = await pullAll(entity, token);
    totalsByEntity.set(entity, txns.length);
    for (const t of txns) {
      const name = `${t.merchant_name ?? ''} ${t.merchant_descriptor ?? ''}`;
      if (AMAZON_NET.test(name)) hits.push({ entity, txn: t });
    }
    console.error(`${entity}: ${txns.length} txns pulled, ${hits.filter((h) => h.entity === entity).length} Amazon-net matches`);
  }

  // ---------- 5. Suspense account per entity ----------
  console.log('\n================ SUSPENSE ACCOUNT (Ramp option id per entity, acct 8220) ================');
  for (const e of ENTITIES) {
    const s = suspense.get(e) ?? null;
    console.log(`  ${e}: ${s ? `option_id=${s.id}  name="${s.name}"` : 'NOT FOUND (no account with code 8220)'}`);
  }

  // ---------- 4. accounting fields ----------
  console.log('\n================ ACCOUNTING FIELDS EXPOSED BY THE CONNECTION ================');
  for (const e of ENTITIES) {
    const fs = fieldsByEntity.get(e) ?? [];
    console.log(`  ${e}: ${fs.map((f) => `${f.name}[${f.id}]`).join(' | ') || '(none)'}`);
  }

  // ---------- 2. merchant variants ----------
  interface VarAgg { count: number; cents: number; byEntity: Map<Entity, number>; bySync: Map<string, number>; kind: string; descriptors: Set<string> }
  const variants = new Map<string, VarAgg>();
  for (const h of hits) {
    const key = (h.txn.merchant_name ?? '(null merchant_name)').trim();
    const v = variants.get(key) ?? {
      count: 0, cents: 0, byEntity: new Map<Entity, number>(), bySync: new Map<string, number>(),
      kind: classifyVariant(`${key} ${h.txn.merchant_descriptor ?? ''}`), descriptors: new Set<string>(),
    };
    v.count++;
    v.cents += cents(h.txn);
    bump(v.byEntity as Map<string, number>, h.entity);
    bump(v.bySync, h.txn.sync_status ?? '(null)');
    if (h.txn.merchant_descriptor) v.descriptors.add(h.txn.merchant_descriptor);
    variants.set(key, v);
  }

  console.log('\n================ MERCHANT NAME VARIANTS (wide Amazon net) ================');
  console.log('kind                 | count |         amount | FL/TN/TX      | merchant_name');
  console.log('---------------------|-------|----------------|---------------|--------------');
  for (const [name, v] of [...variants.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const ent = `${v.byEntity.get('FL') ?? 0}/${v.byEntity.get('TN') ?? 0}/${v.byEntity.get('TX') ?? 0}`;
    console.log(
      `${v.kind.padEnd(20)} | ${String(v.count).padStart(5)} | ${money(v.cents).padStart(14)} | ${ent.padEnd(13)} | ${name}`,
    );
  }

  // ---------- 1. counts by entity x sync_status (retail Amazon only) ----------
  const retail = hits.filter((h) => classifyVariant(`${h.txn.merchant_name ?? ''} ${h.txn.merchant_descriptor ?? ''}`) === 'retail Amazon');
  const excluded = hits.filter((h) => !retail.includes(h));

  console.log('\n================ RETAIL AMAZON: entity x sync_status ================');
  const grid = new Map<string, { n: number; cents: number }>();
  const syncStates = new Set<string>();
  for (const h of retail) {
    const ss = h.txn.sync_status ?? '(null)';
    syncStates.add(ss);
    const k = `${h.entity}|${ss}`;
    const g = grid.get(k) ?? { n: 0, cents: 0 };
    g.n++; g.cents += cents(h.txn);
    grid.set(k, g);
  }
  const states = [...syncStates].sort();
  console.log('entity | ' + states.map((s) => s.padEnd(18)).join(' | '));
  for (const e of ENTITIES) {
    const row = states.map((s) => {
      const g = grid.get(`${e}|${s}`);
      return (g ? `${g.n} / ${money(g.cents)}` : '-').padEnd(18);
    });
    console.log(`${e.padEnd(6)} | ` + row.join(' | '));
  }
  console.log(`\nRETAIL AMAZON TOTAL: ${retail.length} txns / ${money(retail.reduce((s, h) => s + cents(h.txn), 0))}`);
  console.log(`EXCLUDED (non-retail Amazon brands): ${excluded.length} txns / ${money(excluded.reduce((s, h) => s + cents(h.txn), 0))}`);

  // state (CLEARED/PENDING) matters too — pending txns can still change amount
  const byState = new Map<string, number>();
  for (const h of retail) bump(byState, h.txn.state ?? '(null)');
  console.log('  txn state: ' + [...byState.entries()].map(([k, n]) => `${k}=${n}`).join(', '));

  // ---------- 3. current GL coding ----------
  console.log('\n================ RETAIL AMAZON: current GL coding ================');
  const byGl = new Map<string, { n: number; cents: number; sources: Map<string, number> }>();
  for (const h of retail) {
    const gl = glOf(h.txn);
    const key = gl.code ? `${gl.code} ${gl.name}` : gl.name;
    const g = byGl.get(key) ?? { n: 0, cents: 0, sources: new Map<string, number>() };
    g.n++; g.cents += cents(h.txn);
    bump(g.sources, gl.source || '(none)');
    byGl.set(key, g);
  }
  for (const [k, g] of [...byGl.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const src = [...g.sources.entries()].map(([s, n]) => `${s}:${n}`).join(' ');
    console.log(`  ${String(g.n).padStart(4)}x ${money(g.cents).padStart(13)}  ${k}   [${src}]`);
  }

  // which field external_ids actually appear on Amazon txns (vendor field discovery)
  const fieldIds = new Map<string, number>();
  for (const h of retail) for (const s of flatten(h.txn)) bump(fieldIds, `${s.fieldExternalId} (${s.selType}, ${s.level})`);
  console.log('\n  accounting field ids seen on retail Amazon txns:');
  for (const [k, n] of [...fieldIds.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}x  ${k}`);

  // ---------- 4. what "override anything that is not synced" touches ----------
  const notSynced = retail.filter((h) => h.txn.sync_status === 'NOT_SYNC_READY');
  const syncReady = retail.filter((h) => h.txn.sync_status === 'SYNC_READY');
  const synced = retail.filter((h) => h.txn.sync_status === 'SYNCED');
  const otherSync = retail.filter((h) => !['NOT_SYNC_READY', 'SYNC_READY', 'SYNCED'].includes(h.txn.sync_status ?? ''));

  const alreadySuspense = notSynced.filter((h) => glOf(h.txn).code === SUSPENSE_CODE);
  const wouldChange = notSynced.filter((h) => glOf(h.txn).code !== SUSPENSE_CODE);
  const multiLine = notSynced.filter((h) => (h.txn.line_items?.length ?? 0) > 1);

  console.log('\n================ BLAST RADIUS: "override anything that is not synced" ================');
  console.log(`  NOT_SYNC_READY (writable)        : ${notSynced.length} / ${money(notSynced.reduce((s, h) => s + cents(h.txn), 0))}`);
  console.log(`     already coded 8220 Suspense   : ${alreadySuspense.length}  (no-op)`);
  console.log(`     WOULD BE RECODED to Suspense  : ${wouldChange.length} / ${money(wouldChange.reduce((s, h) => s + cents(h.txn), 0))}`);
  console.log(`     of those, still multi-line    : ${multiLine.length}  (split would collapse to 1 line)`);
  console.log(`  SYNC_READY (split LOCKED, 403)   : ${syncReady.length} / ${money(syncReady.reduce((s, h) => s + cents(h.txn), 0))}  -> LEFT ALONE`);
  console.log(`  SYNCED (already in QBO)          : ${synced.length} / ${money(synced.reduce((s, h) => s + cents(h.txn), 0))}  -> LEFT ALONE`);
  if (otherSync.length) {
    const m = new Map<string, number>();
    for (const h of otherSync) bump(m, h.txn.sync_status ?? '(null)');
    console.log(`  OTHER sync_status                : ${[...m.entries()].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }

  // ---------- CSVs ----------
  const rows = hits.map((h) => {
    const gl = glOf(h.txn);
    return [
      h.entity,
      (h.txn.user_transaction_time ?? '').slice(0, 10),
      h.txn.merchant_name ?? '',
      h.txn.merchant_descriptor ?? '',
      classifyVariant(`${h.txn.merchant_name ?? ''} ${h.txn.merchant_descriptor ?? ''}`),
      (cents(h.txn) / 100).toFixed(2),
      h.txn.state ?? '',
      h.txn.sync_status ?? '',
      gl.code,
      gl.name,
      gl.source,
      String(h.txn.line_items?.length ?? 0),
      String(h.txn.receipts?.length ?? 0),
      holder(h.txn),
      h.txn.sk_category_name ?? '',
      (h.txn.memo ?? '').replace(/\s+/g, ' ').slice(0, 200),
      h.txn.id,
    ];
  });
  const header = 'entity,date,merchant_name,merchant_descriptor,kind,amount,state,sync_status,gl_code,gl_name,coding_source,line_count,receipt_count,cardholder,ramp_category,memo,ramp_txn_id';
  writeFileSync(`${OUT}/amazon-suspense-probe.csv`, [header, ...rows.map((r) => r.map(csvCell).join(','))].join('\n'));
  console.log(`\nWrote ${OUT}/amazon-suspense-probe.csv (${rows.length} rows)`);

  console.log('\nTOTAL txns scanned per entity: ' + ENTITIES.map((e) => `${e}=${totalsByEntity.get(e) ?? 0}`).join(', '));
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
