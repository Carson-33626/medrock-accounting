import { readFileSync } from 'node:fs';
function parseCsv(t: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"' && t[i+1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); } return rows;
}
const rows = parseCsv(readFileSync('scripts/amazon-enrich/out/preview_splits.csv', 'utf8')).slice(1).filter(r => r.length > 9);
const amt: Record<string, number> = {}, sum: Record<string, number> = {};
for (const r of rows) { const id = r[1]; amt[id] = Math.round(Number(r[4]) * 100); sum[id] = (sum[id] ?? 0) + Math.round(Number(r[8]) * 100); }
let bad = 0; for (const id in amt) if (amt[id] !== sum[id]) { bad++; if (bad <= 5) console.log('MISMATCH', id, amt[id], sum[id]); }
console.log(`txns=${Object.keys(amt).length} exact-sum-mismatches=${bad}`);
