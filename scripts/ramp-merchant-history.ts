// READ-ONLY: poll historical GL codings per merchant across all 3 Ramp entities to derive better
// merchant->GL mapping rules than Ramp's blunt sk_category. Separates MANUAL codings (human
// judgment) from WORKFLOW codings (existing auto-rules, which may be wrong) so we can see what the
// vendor SHOULD map to vs what a rule is currently forcing. Zero writes.
//   cd web && npx tsx scripts/ramp-merchant-history.ts
import './ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet } from './ramp-split-push/ramp-client';
import type { Entity } from './ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const OUT = 'scripts/ramp-memo-fill/out';
const MIN_TXNS = 3; // only surface recurring vendors

interface RawSel {
  name?: string | null;
  external_code?: string | null;
  type?: string | null;
  source?: { type?: string } | null;
  category_info?: { external_id?: string; type?: string } | null;
}
interface RawLine { accounting_field_selections?: RawSel[] }
interface RawTxn {
  id: string;
  amount: number;
  merchant_name: string | null;
  sk_category_name: string | null;
  accounting_field_selections?: RawSel[];
  line_items?: RawLine[];
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface GlHit { name: string; acct: string | null; workflow: boolean }
function glHits(sels: RawSel[] | undefined): GlHit[] {
  const out: GlHit[] = [];
  for (const s of sels ?? []) {
    if (s?.category_info?.external_id !== 'QuickbooksCategory') continue;
    if (s?.type !== 'GL_ACCOUNT' || !s.name) continue;
    out.push({ name: s.name, acct: s.external_code ?? null, workflow: (s.source?.type ?? '') === 'WORKFLOW' });
  }
  return out;
}

// leaf label for display, e.g. "Inventory Asset:Commercial Rx Inventory" -> "Commercial Rx Inventory"
function leaf(name: string): string { return name.replace(/^\d[\d.]*\s+/, '').split(':').pop()!.trim(); }

interface Agg {
  merchant: string;
  skCats: Set<string>;
  total: number; // # GL-coded line hits
  byGl: Map<string, { total: number; manual: number; acct: string | null }>;
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const agg = new Map<string, Agg>();

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'transactions:read accounting:read');
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 100 && next !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      if (rows.length === 0) break;
      for (const t of rows) {
        const m = (t.merchant_name ?? '').trim();
        if (!m) continue;
        const hits = [...glHits(t.accounting_field_selections), ...(t.line_items ?? []).flatMap((l) => glHits(l.accounting_field_selections))];
        if (hits.length === 0) continue;
        const a = agg.get(m) ?? { merchant: m, skCats: new Set<string>(), total: 0, byGl: new Map() };
        if (t.sk_category_name) a.skCats.add(t.sk_category_name);
        for (const h of hits) {
          a.total++;
          const g = a.byGl.get(h.name) ?? { total: 0, manual: 0, acct: h.acct };
          g.total++;
          if (!h.workflow) g.manual++;
          a.byGl.set(h.name, g);
        }
        agg.set(m, a);
      }
      next = res.body.page?.next ?? null;
    }
    console.error(`${entity}: aggregated`);
  }

  // Build ranked rows for recurring vendors
  interface Row { merchant: string; skCat: string; total: number; topGl: string; topAcct: string; agree: number; manualTop: string; manualN: number; }
  const rows: Row[] = [];
  for (const a of agg.values()) {
    if (a.total < MIN_TXNS) continue;
    const gls = [...a.byGl.entries()].sort((x, y) => y[1].total - x[1].total);
    const [topName, topStats] = gls[0];
    const manualGls = gls.filter(([, s]) => s.manual > 0).sort((x, y) => y[1].manual - x[1].manual);
    rows.push({
      merchant: a.merchant,
      skCat: [...a.skCats][0] ?? '',
      total: a.total,
      topGl: leaf(topName),
      topAcct: topStats.acct ?? '',
      agree: Math.round((topStats.total / a.total) * 100),
      manualTop: manualGls.length ? leaf(manualGls[0][0]) : '(none manual)',
      manualN: manualGls.length ? manualGls[0][1].manual : 0,
    });
  }
  rows.sort((x, y) => y.total - x.total);

  const header = 'merchant,ramp_category,coded_lines,top_gl,top_acct,agreement_pct,manual_top_gl,manual_lines';
  const csv = [header, ...rows.map((r) => [r.merchant, r.skCat, r.total, r.topGl, r.topAcct, r.agree, r.manualTop, r.manualN]
    .map((v) => { const s = String(v ?? ''); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(','))];
  writeFileSync(`${OUT}/merchant_gl_history.csv`, csv.join('\n'));

  console.log('\n=== TOP RECURRING VENDORS: historical GL coding (all entities) ===');
  console.log('vendor'.padEnd(30) + 'n   ramp_cat'.padEnd(24) + 'top_gl (agree%)'.padEnd(34) + 'manual_gl');
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.merchant.slice(0, 29).padEnd(30) +
      (String(r.total) + '  ' + r.skCat.slice(0, 18)).padEnd(24) +
      `${r.topAcct} ${r.topGl} (${r.agree}%)`.slice(0, 33).padEnd(34) +
      (r.manualN > 0 ? `${r.manualTop} [${r.manualN}]` : '—'),
    );
  }

  console.log('\n=== NAMED VENDORS (your call-outs) ===');
  for (const needle of ['oak', 'uline', 'kalchem']) {
    const hits = rows.filter((r) => r.merchant.toLowerCase().includes(needle));
    for (const r of hits) console.log(`  ${r.merchant}: history=${r.topAcct} ${r.topGl} (${r.agree}%, ${r.total} lines; manual=${r.manualTop} [${r.manualN}]) | ramp_cat=${r.skCat}`);
    if (hits.length === 0) console.log(`  (no "${needle}" vendor with >=${MIN_TXNS} coded lines)`);
  }
  console.log(`\nWrote ${OUT}/merchant_gl_history.csv (${rows.length} vendors)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
