// TASK 2 — re-export the worked/coded Amazon history and rebuild the item->GL classifier lookup.
// Source of truth = QuickBooks' Amazon-direct itemized feed: every line carries a product
// description AND the GL account staff coded it to. As more Amazon purchases get worked, this
// corpus grows and the phrase->GL rules improve. Read-only on QB; writes a FRESH lookup CSV + a
// diff report against the current one (does NOT overwrite the live classifier data — promote after review).
//
//   cd web && npx tsx scripts/amazon-enrich/rebuild-classifier.ts
import '../ramp-split-push/load-env';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readAllQbAmazonEntries } from '../ramp-split-push/qb-amazon-reader';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../docs/ramp-recon');

// Lines that would mis-train the model (per the original data-quality finding):
// - intercompany "Due to/from" accounts (entity cross-charges, not item categories)
// - Suspense is the FALLBACK class, not a learnable target — never train "-> Suspense"
const BAD_GL = /due (to|from)|intercompany|ramp card|paid ramp|suspense/i;
// Boilerplate that leaks into the QB description field on the LUMP "Amazon" (Ramp-pushed) feed:
// cardholder names, "Ramp pushed transaction", merchant descriptors (AMZN Mktp / amazon.com).
const BAD_DESC = /paid ramp card|cardholder|ramp pushed|pushed transaction|\bamzn\b|amazon\.com|mktp|prime video|amazon web|^\s*$/i;
// Only the ITEMIZED feed carries real product descriptions -> train on "Amazon Business" only.
const GOOD_VENDOR = /amazon business/i;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'pack', 'count', 'pcs', 'pack of', 'inch', 'inches', 'set', 'size',
  'new', 'oz', 'ct', 'ml', 'each', 'per', 'x', 'of', 'to', 'in', 'on', 'by', 'from', 'pcs.', 'pc',
  'large', 'small', 'medium', 'black', 'white', 'blue', 'red', 'clear', 'free', 'amazon', 'business',
  'com', 'llc', 'inc', 'co', 'brand', 'premium', 'quality', 'value', 'compatible with',
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(desc: string): string[] {
  const words = norm(desc).split(' ').filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w));
  const grams = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    grams.add(words[i]);
    if (i + 1 < words.length) grams.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...grams];
}

interface Agg { byGl: Map<string, number>; acct: Map<string, string> }

function loadExistingPhrases(): Set<string> {
  const p = resolve(DOCS, 'item_gl_lookup.csv');
  if (!existsSync(p)) return new Set();
  const out = new Set<string>();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/).slice(1)) {
    const phrase = line.split(',')[0];
    if (phrase) out.add(phrase.replace(/^"|"$/g, '').toLowerCase());
  }
  return out;
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  console.log('Pulling QB Amazon-direct itemized coding history (all 3 realms, read-only)...');
  const entries = await readAllQbAmazonEntries();
  let totalLines = 0;
  let kept = 0;
  let dropped = 0;
  const phrases = new Map<string, Agg>();
  const vendorBreakdown = new Map<string, number>();

  for (const e of entries) {
    vendorBreakdown.set(e.vendor ?? '(none)', (vendorBreakdown.get(e.vendor ?? '(none)') ?? 0) + 1);
    // Only the itemized "Amazon Business" feed carries real product descriptions; the lump "Amazon"
    // (Ramp-pushed) feed's description field is cardholder names / boilerplate -> skip entirely.
    if (!GOOD_VENDOR.test(e.vendor ?? '')) continue;
    for (const l of e.lines) {
      totalLines++;
      const gl = l.glAccountName;
      const desc = l.description ?? '';
      if (!gl || BAD_GL.test(gl) || BAD_DESC.test(desc) || desc.length < 8) { dropped++; continue; }
      kept++;
      for (const ph of tokens(desc)) {
        const a = phrases.get(ph) ?? { byGl: new Map(), acct: new Map() };
        a.byGl.set(gl, (a.byGl.get(gl) ?? 0) + 1);
        if (l.glAccountId) a.acct.set(gl, l.glAccountId);
        phrases.set(ph, a);
      }
    }
  }

  const MIN_EX = 3;
  const MIN_CONF = 0.5;
  const rows: { phrase: string; acct: string; gl: string; conf: number; ex: number }[] = [];
  for (const [phrase, a] of phrases) {
    let total = 0;
    let topGl = '';
    let topN = 0;
    for (const [gl, n] of a.byGl) { total += n; if (n > topN) { topN = n; topGl = gl; } }
    if (total < MIN_EX) continue;
    const conf = topN / total;
    if (conf < MIN_CONF) continue;
    rows.push({ phrase, acct: a.acct.get(topGl) ?? '', gl: topGl, conf: Number(conf.toFixed(2)), ex: total });
  }
  rows.sort((x, y) => y.ex - x.ex);

  const header = 'phrase,qb_acctnum,gl_account,confidence,examples';
  const body = rows.map((r) => [r.phrase, r.acct, r.gl, r.conf, r.ex].map(csv).join(',')).join('\n');
  const outPath = resolve(DOCS, 'item_gl_lookup.rebuilt.csv');
  writeFileSync(outPath, `${header}\n${body}\n`);

  const existing = loadExistingPhrases();
  const newPhrases = rows.filter((r) => !existing.has(r.phrase));
  console.log(`\nQB Amazon entries: ${entries.length}. Vendor breakdown:`);
  for (const [v, n] of [...vendorBreakdown].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${n.toString().padStart(5)}  ${v}`);
  console.log(`\nAmazon Business itemized lines: ${totalLines} (kept ${kept}, dropped ${dropped} intercompany/suspense/boilerplate)`);
  console.log(`Lookup rules: ${rows.length} (was ${existing.size}) | NEW phrases: ${newPhrases.length}`);
  console.log(`Wrote ${outPath} (fresh table — review, then promote over item_gl_lookup.csv)`);
  console.log('\nTop 15 NEW phrases (phrase | GL | conf | examples):');
  for (const r of newPhrases.slice(0, 15)) console.log(`  ${r.phrase}  ->  ${r.gl}  (${r.conf}, ${r.ex}x)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
