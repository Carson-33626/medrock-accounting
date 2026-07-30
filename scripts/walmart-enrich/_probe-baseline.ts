// Read-only: dump every distinct item description across the Walmart + Sam's preview splits with what
// classify() returns for it RIGHT NOW. This is the baseline a correction pass is measured against —
// re-run it after editing item_corrections.json and diff the two files to see every GL that moved.
//   npx tsx scripts/walmart-enrich/_probe-baseline.ts > <somewhere>/baseline.txt
import { readFileSync, existsSync } from 'node:fs';
import { classify } from '../amazon-enrich/classifier';

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

const PATHS = ['scripts/walmart-enrich/out/sams/preview_splits.csv', 'scripts/walmart-enrich/out/preview_splits.csv'];
const descs = new Set<string>();
for (const p of PATHS) {
  if (!existsSync(p)) continue;
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const iDesc = parseCsvLine(lines[0]).indexOf('line_desc');
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c[iDesc]) descs.add(c[iDesc]);
  }
}

const THRESHOLD = 0.8;
for (const d of [...descs].sort()) {
  const c = classify(d);
  const effective = c.glName !== null && c.confidence >= THRESHOLD ? c.glName : 'SUSPENSE';
  console.log(`${effective}\t${c.glName ?? '-'}\t${c.confidence}\t${c.source}\t${d}`);
}
console.error(`${descs.size} distinct descriptions`);
