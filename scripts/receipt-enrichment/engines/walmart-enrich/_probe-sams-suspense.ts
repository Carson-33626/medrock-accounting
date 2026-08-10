// Read-only probe: what do the Sam's Suspense lines actually say, and why did the classifier pass on
// them (no phrase vote at all vs. a vote below the 0.8 confidence threshold)? No writes anywhere.
//   npx tsx scripts/receipt-enrichment/engines/walmart-enrich/_probe-sams-suspense.ts scripts/receipt-enrichment/cache/walmart/out/sams/preview_splits.csv
import { readFileSync } from 'node:fs';
import { classify } from '../amazon-enrich/classifier';
import { WM } from '../../paths';

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

interface Row { desc: string; amt: number; gl: string; coded: boolean; conf: number }

const path = process.argv[2] ?? `${WM.out}/sams/preview_splits.csv`;
const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const hdr = parseCsvLine(lines[0]);
const col = (name: string): number => hdr.indexOf(name);
const iDesc = col('line_desc'), iAmt = col('split_amount'), iGl = col('gl_name'), iCoded = col('coded'), iConf = col('confidence');

const rows: Row[] = [];
for (let i = 1; i < lines.length; i++) {
  const c = parseCsvLine(lines[i]);
  if (c.length < hdr.length) continue;
  rows.push({ desc: c[iDesc], amt: Number(c[iAmt]) || 0, gl: c[iGl], coded: c[iCoded] === 'true', conf: Number(c[iConf]) || 0 });
}

const susp = rows.filter((r) => !r.coded);
console.log(`total lines ${rows.length} | coded ${rows.length - susp.length} | suspense ${susp.length} (${((susp.length / rows.length) * 100).toFixed(0)}%)`);
console.log(`suspense $${susp.reduce((a, b) => a + b.amt, 0).toFixed(2)} of $${rows.reduce((a, b) => a + b.amt, 0).toFixed(2)}`);

let noVote = 0;
const nearMiss: { desc: string; gl: string; conf: number }[] = [];
for (const r of susp) {
  const c = classify(r.desc);
  if (c.glName === null) noVote++;
  else nearMiss.push({ desc: r.desc, gl: c.glName, conf: c.confidence });
}
console.log(`suspense breakdown: no-vote ${noVote} | below-threshold ${nearMiss.length}`);

console.log('\n--- suspense descriptions by frequency (top 60) ---');
const freq = new Map<string, { n: number; amt: number }>();
for (const r of susp) {
  const v = freq.get(r.desc) ?? { n: 0, amt: 0 };
  v.n++; v.amt += r.amt;
  freq.set(r.desc, v);
}
[...freq.entries()].sort((a, b) => b[1].n - a[1].n || b[1].amt - a[1].amt).slice(0, 60)
  .forEach(([d, v]) => console.log(`${String(v.n).padStart(3)}  $${v.amt.toFixed(2).padStart(9)}  ${d}`));

console.log('\n--- below-threshold near-misses (top 30 by confidence) ---');
nearMiss.sort((a, b) => b.conf - a.conf).slice(0, 30)
  .forEach((s) => console.log(`${s.conf.toFixed(2)}  ${s.gl.padEnd(48)}  ${s.desc}`));

console.log('\n--- GLs the CODED lines landed on ---');
const glFreq = new Map<string, number>();
for (const r of rows.filter((x) => x.coded)) glFreq.set(r.gl, (glFreq.get(r.gl) ?? 0) + 1);
[...glFreq.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`${String(n).padStart(3)}  ${g}`));
