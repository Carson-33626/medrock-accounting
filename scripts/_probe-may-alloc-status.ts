/** READ-ONLY: May-2026 directed-class (`Allocate - FL|TN|TX`) Purchases vs QBO's own BTS_ALLOCATION pairs.
 *  Use after the QBO-UI re-save to confirm each pair landed. GET/query only.
 *
 *    npx tsx scripts/_probe-may-alloc-status.ts list                           # current unpaired set (+ cache JSON)
 *    npx tsx scripts/_probe-may-alloc-status.ts verify --ids=FL:51147,TN:19595  # BTS pair lines for given purchases
 *
 *  Finding (2026-10-27): an API update cannot fire the allocation. An unchanged sparse or full update is a
 *  server no-op (SyncToken unchanged), and a content-changing API update (FL 53433, 2026-09-02) and an API
 *  create (FL 53514) got no pair until a QBO-UI save on 10/01. See local://may-alloc136.md.
 */
import './payroll/load-env-vercel-first';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface Ref { value?: string; name?: string }
interface PLine {
  Id?: string;
  Amount?: number;
  AccountBasedExpenseLineDetail?: { ClassRef?: Ref; AccountRef?: Ref };
  ItemBasedExpenseLineDetail?: { ClassRef?: Ref };
}
interface Purchase {
  Id: string;
  SyncToken?: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  EntityRef?: Ref;
  Line?: PLine[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}
interface JLine { Amount?: number; JournalEntryLineDetail?: { PostingType?: string; AccountRef?: Ref; ClassRef?: Ref } }
interface Je { Id: string; TxnDate?: string; TxnSource?: string; PrivateNote?: string; Line?: JLine[]; MetaData?: { CreateTime?: string } }

const LOCS: Record<string, Location> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
const CO_TO_KEY: Record<string, string> = { 'Medrock FLORIDA': 'FL', 'Medrock TENNESSEE': 'TN', 'Medrock TEXAS': 'TX' };
const OUT_DIR = resolve(__dirname, '..', '..', 'receipt-enrichment', 'cache', 'may-alloc');
const MAY = "WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31'";
const c2 = (n: number): string => n.toFixed(2);
const r2 = (n: number): number => Math.round(n * 100) / 100;

interface Bts { key: string; je: Je; srcKey: string; srcType: string; ref: string; due: number }

async function loadBts(): Promise<Bts[]> {
  const out: Bts[] = [];
  for (const key of ['FL', 'TN', 'TX']) {
    const jes = await qbQueryAll<Je>(LOCS[key], 'JournalEntry', "WHERE TxnDate >= '2026-04-15' AND TxnDate <= '2026-06-30'");
    for (const j of jes.filter((x) => x.TxnSource === 'BTS_ALLOCATION')) {
      const m = /created in (Medrock [A-Z]+)\s*Ref no\.\s*([A-Za-z ]+?)\s*#\s*(\S+)/.exec(j.PrivateNote ?? '');
      const due = (j.Line ?? [])
        .filter((l) => /Due (from|to)/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''))
        .reduce((s, l) => s + (l.Amount ?? 0), 0);
      out.push({ key, je: j, srcKey: m ? (CO_TO_KEY[m[1]] ?? '?') : '?', srcType: m?.[2] ?? '?', ref: m?.[3] ?? '?', due: r2(due) });
    }
  }
  return out;
}

/** Directed `Allocate - XX` amount per target entity on a purchase. */
function directed(p: Purchase): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of p.Line ?? []) {
    const c = l.AccountBasedExpenseLineDetail?.ClassRef?.name ?? l.ItemBasedExpenseLineDetail?.ClassRef?.name ?? '';
    const t = /^Allocate - (FL|TN|TX)$/.exec(c)?.[1];
    if (t) m.set(t, r2((m.get(t) ?? 0) + (l.Amount ?? 0)));
  }
  return m;
}

function pairsFor(bts: Bts[], key: string, p: Purchase): Bts[] {
  const refs = new Set([p.Id, p.DocNumber ?? '']);
  const hits = bts.filter((b) => b.srcKey === key && b.srcType === 'Expense' && refs.has(b.ref));
  if (hits.length) return hits;
  const tot = r2([...directed(p).values()].reduce((s, a) => s + a, 0));
  return bts.filter((b) => b.ref === '?' && b.je.TxnDate === p.TxnDate && Math.abs(b.due - tot) < 0.005);
}

async function list(): Promise<void> {
  const bts = await loadBts();
  const rows: { key: string; id: string; date: string; payee: string; target: string; amt: number }[] = [];
  for (const key of ['FL', 'TN', 'TX']) {
    const ps = await qbQueryAll<Purchase>(LOCS[key], 'Purchase', MAY);
    for (const p of ps) {
      const d = directed(p);
      if (d.size === 0 || pairsFor(bts, key, p).length) continue;
      for (const [t, a] of d) rows.push({ key, id: p.Id, date: p.TxnDate ?? '', payee: p.EntityRef?.name ?? '', target: t, amt: a });
    }
  }
  const by = new Map<string, { n: number; amt: number }>();
  for (const r of rows) {
    const k = `${r.key}->${r.target}`;
    const s = by.get(k) ?? { n: 0, amt: 0 };
    s.n++; s.amt = r2(s.amt + r.amt);
    by.set(k, s);
  }
  for (const [k, s] of by) console.log(`${k}: ${s.n} / ${c2(s.amt)}`);
  console.log(`TOTAL ${rows.length} / ${c2(rows.reduce((s, r) => s + r.amt, 0))}`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'unpaired.json'), JSON.stringify(rows, null, 1));
  console.log(`wrote ${resolve(OUT_DIR, 'unpaired.json')}`);
}

function parseIds(): { key: string; id: string }[] {
  const arg = process.argv.find((a) => a.startsWith('--ids='));
  if (!arg) throw new Error('--ids=FL:123,TN:456 required');
  return arg.slice(6).split(',').filter(Boolean).map((s) => {
    const [key, id] = s.split(':');
    if (!LOCS[key] || !/^\d+$/.test(id ?? '')) throw new Error(`bad id ${s}`);
    return { key, id };
  });
}

async function verify(): Promise<void> {
  const bts = await loadBts();
  for (const { key, id } of parseIds()) {
    const [p] = await qbQueryAll<Purchase>(LOCS[key], 'Purchase', `WHERE Id = '${id}'`);
    const d = directed(p);
    const hits = pairsFor(bts, key, p);
    console.log(`${key} Purchase ${id} ${p.TxnDate} ${c2(p.TotalAmt ?? 0)} directed ${[...d].map(([t, a]) => `${t}=${c2(a)}`).join(';')} sync ${p.SyncToken} upd ${p.MetaData?.LastUpdatedTime}`);
    if (!hits.length) console.log('   NO BTS PAIR');
    for (const h of hits) {
      console.log(`   ${h.key} JE ${h.je.Id} date ${h.je.TxnDate} created ${h.je.MetaData?.CreateTime} due ${c2(h.due)} note "${(h.je.PrivateNote ?? '').replace(/\s+/g, ' ')}"`);
      for (const l of h.je.Line ?? []) {
        const jd = l.JournalEntryLineDetail;
        console.log(`      ${jd?.PostingType} ${c2(l.Amount ?? 0)} ${jd?.AccountRef?.name} | ${jd?.ClassRef?.name ?? ''}`);
      }
    }
  }
}

const cmd = process.argv[2];
const run = cmd === 'list' ? list : cmd === 'verify' ? verify : null;
if (!run) { console.error('usage: list | verify --ids=FL:123,TN:456'); process.exit(1); }
run().catch((e: Error) => { console.error(e.message); process.exit(1); });
