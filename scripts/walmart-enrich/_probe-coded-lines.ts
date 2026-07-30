// Read-only probe: what descriptions did each GL actually receive in the preview splits? Used to check
// that a classifier change does not contradict lines that are already coding correctly — and to spot
// existing mis-codes (e.g. paper goods landing in an inventory account). No writes anywhere.
//   npx tsx scripts/walmart-enrich/_probe-coded-lines.ts
import { readFileSync, existsSync } from 'node:fs';

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

const TARGETS: { tag: string; path: string }[] = [
  { tag: "SAM'S", path: 'scripts/walmart-enrich/out/sams/preview_splits.csv' },
  { tag: 'WALMART', path: 'scripts/walmart-enrich/out/preview_splits.csv' },
];

for (const t of TARGETS) {
  if (!existsSync(t.path)) { console.log(`(skip ${t.tag}: no ${t.path})`); continue; }
  const lines = readFileSync(t.path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const hdr = parseCsvLine(lines[0]);
  const iDesc = hdr.indexOf('line_desc'), iGl = hdr.indexOf('gl_name'), iCoded = hdr.indexOf('coded');
  const byGl = new Map<string, Set<string>>();
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < hdr.length || c[iCoded] !== 'true') continue;
    if (!byGl.has(c[iGl])) byGl.set(c[iGl], new Set());
    byGl.get(c[iGl])!.add(c[iDesc]);
  }
  console.log(`\n===== ${t.tag} — CODED lines, distinct descriptions per GL =====`);
  for (const [gl, set] of [...byGl.entries()].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`\n## ${gl}  (${set.size} distinct)`);
    for (const d of [...set].slice(0, 16)) console.log(`   ${d.slice(0, 95)}`);
  }
}
