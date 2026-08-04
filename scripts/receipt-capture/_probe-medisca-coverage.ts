// Medisca's GL rule is NOT Letco's. Letco is 98.4% one-of-two accounts; Medisca's top two cover
// only 85.8%, because Medisca also sells lab equipment (6200.75), lab supplies (1220.20), packaging
// (1220.15) and capital equipment (1500.02 — 14 lines, $59,617). Defaulting everything to 1220.10
// would mis-post roughly one line in seven, including mixers that belong in Fixed Assets. So a
// hardcoded product/shipping rule is off the table.
//
// The alternative: the accountant has already coded 1,150 Medisca lines by hand. This measures
// whether HER OWN HISTORY can classify the drafts she has not coded yet — i.e. what fraction of
// uncoded draft lines carry a description she has coded before, and how consistently she coded it.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-medisca-coverage.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { isGlCoded } from './bill-draft';
import type { RampDraftSelection } from './bill-draft';

const VENDOR_RE = /medisca/i;
const FREIGHT_RE = /shipping|freight|handling|hazmat/i;

interface DraftLine { memo?: string | null; amount?: { amount?: number } | null; accounting_field_selections?: RampDraftSelection[] }
interface Draft { id?: string; invoice_number?: string | null; vendor?: { name?: string | null } | null; line_items?: DraftLine[] }
interface DraftPage { data?: Draft[]; page?: { next?: string | null } }

interface QbLine { Amount?: number; Description?: string; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { VendorRef?: { name?: string }; Line?: QbLine[] }

// QB descriptions carry lot/expiry/qty tails the Ramp memo does not:
//   "Ascorbic Acid USP/EP:227724/A Exp:01/31/30 Qty:5"  ->  "ascorbic acid usp/ep"
// Cutting at the lot marker is what makes the two sides comparable at all.
export function normalizeItem(desc: string): string {
  let s = desc.trim();
  // Truncate at the FIRST lot/expiry/qty marker rather than stripping each pattern separately —
  // stripping ":233113/E Exp:..." out of "Itraconazole, USP Lot:233113/E Exp:..." left a dangling
  // "Lot" token behind, which is why 8 real matches read as no_history on the first pass.
  const cut = s.search(/\b(lot|exp|qty)\b\s*:|:\s*\d{5,}\/[A-Z]/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[*]+/g, ' ');
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type History = Map<string, Map<string, number>>;

function record(map: History, desc: string, code: string): void {
  const key = normalizeItem(desc);
  if (key === '' || code === '') return;
  const inner = map.get(key) ?? new Map<string, number>();
  inner.set(code, (inner.get(code) ?? 0) + 1);
  map.set(key, inner);
}

// QB is the deep source (years of her coding) but its Description text is QB-flavoured. Ramp's
// already-coded drafts are shallower yet EXACT-format — same memo strings the uncoded drafts carry —
// so they need no text bridging at all. Use both.
async function buildHistory(since: string): Promise<{ map: History; qbLines: number; rampLines: number }> {
  const map: History = new Map();
  let qbLines = 0;
  let rampLines = 0;

  for (const entity of ALL_ENTITIES) {
    const bills = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${since}'`);
    for (const b of bills) {
      if (!VENDOR_RE.test(b.VendorRef?.name ?? '')) continue;
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const desc = (l.Description ?? '').trim();
        if (!acct || desc === '') continue;
        qbLines++;
        record(map, desc, acct.split(' ')[0]);
      }
    }

    const token = await rampToken(entity, 'bills:read');
    let url: string | null = '/bills/drafts?page_size=100';
    for (let i = 0; i < 50 && url !== null; i++) {
      const res: { status: number; body: DraftPage } = await rampGet<DraftPage>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      for (const d of rows) {
        if (!VENDOR_RE.test(d.vendor?.name ?? '')) continue;
        for (const l of d.line_items ?? []) {
          const sel = (l.accounting_field_selections ?? []) as { external_code?: string | null }[];
          const code = sel[0]?.external_code ?? "";
          const memo = (l.memo ?? '').trim();
          if (code === '' || memo === '') continue;
          rampLines++;
          record(map, memo, code);
        }
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
  }
  return { map, qbLines, rampLines };
}

interface Verdict { account: string | null; reason: string }

function classify(memo: string, history: Map<string, Map<string, number>>): Verdict {
  if (FREIGHT_RE.test(memo)) return { account: '5000.45', reason: 'freight_memo' };
  const key = normalizeItem(memo);
  if (key === '') return { account: null, reason: 'empty_memo' };
  let hit = history.get(key);
  let via = 'history';
  if (hit === undefined) {
    // Ramp's memo and QB's description are the same item typed twice ("Boat, Anti-Static, 3.5 x 3.5"
    // vs "Weigh Boat, Anti-Static, 3.5 x 3.5"). A containment match recovers those, but ONLY when it
    // is unambiguous — several history items matching means we cannot tell which she meant.
    const cands = [...history.keys()].filter((k) => k.length >= 12 && (k.includes(key) || key.includes(k)));
    const accts = new Set(cands.flatMap((k) => [...(history.get(k) ?? new Map()).keys()]));
    if (cands.length === 0) return { account: null, reason: 'no_history' };
    if (accts.size > 1) return { account: null, reason: `fuzzy_ambiguous(${[...accts].join(',')})` };
    hit = history.get(cands[0]);
    via = 'fuzzy';
  }
  if (hit === undefined) return { account: null, reason: 'no_history' };
  const sorted = [...hit.entries()].sort((a, b) => b[1] - a[1]);
  const total = [...hit.values()].reduce((a, n) => a + n, 0);
  const [topAcct, topN] = sorted[0];
  // She is not always self-consistent; only an overwhelming majority is safe to replay.
  if (topN / total < 0.9) return { account: null, reason: `ambiguous(${sorted.map(([a, n]) => `${a}:${n}`).join(',')})` };
  return { account: topAcct, reason: `${via}(${topN}/${total})` };
}

async function main(): Promise<void> {
  const since = process.argv[2] ?? '2023-01-01';
  const { map: history, qbLines, rampLines } = await buildHistory(since);
  console.log(`history since ${since}: ${history.size} distinct items (${qbLines} QB lines + ${rampLines} already-coded Ramp draft lines)`);

  let drafts = 0, allLines = 0, classified = 0;
  let fullyClassifiable = 0, blocked = 0;
  const reasons = new Map<string, number>();
  const acctHits = new Map<string, number>();
  const blockedSamples: string[] = [];

  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'bills:read');
    let url: string | null = '/bills/drafts?page_size=100';
    const rows: Draft[] = [];
    for (let i = 0; i < 50 && url !== null; i++) {
      const res: { status: number; body: DraftPage } = await rampGet<DraftPage>(entity, url, token);
      if (res.status !== 200) break;
      const page = res.body.data ?? [];
      rows.push(...page);
      if (page.length === 0) break;
      url = res.body.page?.next ?? null;
    }
    for (const d of rows) {
      if (!VENDOR_RE.test(d.vendor?.name ?? '')) continue;
      const lines = d.line_items ?? [];
      if (lines.length === 0) continue;
      // Only the ones enrich would actually touch: drafts with no GL account on any line. NOT
      // "no selections" — Medisca drafts carry a Billable=false selection that is not GL coding,
      // and treating it as coding hid 54 of the 106 uncoded lines on the first pass.
      if (lines.some((l) => isGlCoded(l.accounting_field_selections))) continue;
      drafts++;
      let ok = true;
      for (const l of lines) {
        allLines++;
        const v = classify(l.memo ?? '', history);
        reasons.set(v.reason.split('(')[0], (reasons.get(v.reason.split('(')[0]) ?? 0) + 1);
        if (v.account === null) {
          ok = false;
          if (blockedSamples.length < 12) blockedSamples.push(`${d.invoice_number ?? '?'}: "${(l.memo ?? '').slice(0, 52)}" -> ${v.reason}`);
        } else {
          classified++;
          acctHits.set(v.account, (acctHits.get(v.account) ?? 0) + 1);
        }
      }
      if (ok) fullyClassifiable++; else blocked++;
    }
  }

  console.log(`\nUNCODED Medisca drafts: ${drafts} (${allLines} lines)`);
  console.log(`lines classifiable from her own history: ${classified}/${allLines} (${Math.round((classified / Math.max(allLines, 1)) * 1000) / 10}%)`);
  console.log(`drafts where EVERY line classifies (patchable under an all-or-nothing rule): ${fullyClassifiable}`);
  console.log(`drafts blocked by >=1 unknown line: ${blocked}`);
  console.log(`\nreasons: ${[...reasons].map(([r, n]) => `${r}=${n}`).join(' ')}`);
  console.log(`accounts proposed: ${[...acctHits].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}:${n}`).join(' ')}`);
  if (blockedSamples.length) {
    console.log('\nunmatched samples (these decide whether a portal/SKU source is needed):');
    for (const s of blockedSamples) console.log(`  ${s}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
