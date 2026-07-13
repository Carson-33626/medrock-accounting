// Item -> GL classifier, rebuilt from the committed history-mined assets:
//   docs/ramp-recon/item_gl_lookup.csv   (2,357 phrase -> GL rules, w/ confidence + example count)
//   docs/ramp-recon/item_corrections.json (user override rules, take precedence)
// Phrase-voting: each lookup phrase found in the description votes for its GL, weighted by
// confidence * specificity (multi-word phrases weigh more). Corrections override. Returns a GL
// NAME (portable across entities) + confidence; the caller resolves name -> entity option id.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../docs/ramp-recon');

interface LookupRow { phrase: string; acctnum: string; glName: string; confidence: number; examples: number }
interface Correction { id: string; match: string; and?: string; gl_name: string; note?: string }

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadLookup(): LookupRow[] {
  const text = readFileSync(resolve(DOCS, 'item_gl_lookup.csv'), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows: LookupRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 5) continue;
    const confidence = Number(c[3]);
    const examples = Number(c[4]);
    if (!c[0] || !c[2] || !Number.isFinite(confidence)) continue;
    rows.push({ phrase: c[0].toLowerCase().trim(), acctnum: c[1], glName: c[2], confidence, examples: Number.isFinite(examples) ? examples : 1 });
  }
  return rows;
}

function loadCorrections(): Correction[] {
  try {
    return JSON.parse(readFileSync(resolve(DOCS, 'item_corrections.json'), 'utf8')) as Correction[];
  } catch {
    return [];
  }
}

const LOOKUP = loadLookup();
const CORRECTIONS = loadCorrections();
// acctnum lookup by GL name (for corrections that only carry a name)
const NAME_TO_ACCT = new Map<string, string>();
for (const r of LOOKUP) if (!NAME_TO_ACCT.has(r.glName)) NAME_TO_ACCT.set(r.glName, r.acctnum);

function norm(s: string): string {
  return ' ' + s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
function phraseHit(hay: string, phrase: string): boolean {
  // word-boundary containment: phrase padded with spaces must appear in the padded desc
  return hay.includes(' ' + phrase + ' ') || hay.includes(' ' + phrase.replace(/ /g, ' ') + ' ');
}

export interface Classification {
  glName: string | null;
  acctnum: string | null;
  confidence: number;
  source: 'correction' | 'lookup' | 'none';
  correctionId?: string;
}

export function classify(desc: string): Classification {
  const hay = norm(desc);

  // 1) corrections take precedence
  for (const c of CORRECTIONS) {
    const m = new RegExp(c.match, 'i').test(desc);
    const a = c.and ? new RegExp(c.and, 'i').test(desc) : true;
    if (m && a) {
      return { glName: c.gl_name, acctnum: NAME_TO_ACCT.get(c.gl_name) ?? null, confidence: 0.99, source: 'correction', correctionId: c.id };
    }
  }

  // 2) phrase voting
  const votes = new Map<string, { weight: number; acct: string; bestConf: number }>();
  for (const r of LOOKUP) {
    if (!phraseHit(hay, r.phrase)) continue;
    const specificity = r.phrase.includes(' ') ? 2.2 : 1; // bigrams/phrases weigh more than single words
    const weight = r.confidence * Math.log2(1 + r.examples) * specificity;
    const v = votes.get(r.glName) ?? { weight: 0, acct: r.acctnum, bestConf: 0 };
    v.weight += weight;
    v.bestConf = Math.max(v.bestConf, r.confidence);
    votes.set(r.glName, v);
  }
  if (votes.size === 0) return { glName: null, acctnum: null, confidence: 0, source: 'none' };

  let topName = '';
  let top = { weight: 0, acct: '', bestConf: 0 };
  let total = 0;
  for (const [name, v] of votes) {
    total += v.weight;
    if (v.weight > top.weight) { top = v; topName = name; }
  }
  // confidence = vote share tempered by the best matching phrase's own confidence
  const share = total > 0 ? top.weight / total : 0;
  const confidence = Math.min(0.99, Number((share * 0.5 + top.bestConf * 0.5).toFixed(3)));
  return { glName: topName, acctnum: top.acct, confidence, source: 'lookup' };
}

export function classifierStats(): { lookupRows: number; corrections: number } {
  return { lookupRows: LOOKUP.length, corrections: CORRECTIONS.length };
}
