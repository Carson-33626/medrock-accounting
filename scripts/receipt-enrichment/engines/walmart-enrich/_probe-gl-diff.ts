// Read-only: diff two _probe-baseline.ts dumps and group every description whose effective GL moved.
// This is the audit for a classifier/corrections change — nothing ships without reading it.
//   npx tsx scripts/receipt-enrichment/engines/walmart-enrich/_probe-gl-diff.ts <before.tsv> <after.tsv>
import { readFileSync } from 'node:fs';

function load(path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 5) continue;
    m.set(c[4], c[0]);
  }
  return m;
}

const before = load(process.argv[2]);
const after = load(process.argv[3]);

const moved: [string, string, string][] = [];
let same = 0;
for (const [desc, b] of before) {
  const a = after.get(desc);
  if (a === b) { same++; continue; }
  moved.push([b, a ?? '(missing)', desc]);
}
console.log(`unchanged ${same} | changed ${moved.length} of ${before.size}`);

const groups = new Map<string, string[]>();
for (const [b, a, desc] of moved) {
  const key = `${b}  ==>  ${a}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(desc);
}
for (const [key, descs] of [...groups.entries()].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`\n### ${key}   (${descs.length})`);
  for (const d of descs) console.log(`    ${d.slice(0, 105)}`);
}
