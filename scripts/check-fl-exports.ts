/** Verify FL DR-15 exports generate: source fetch + PDF bytes. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { computeFlDr15, fetchFlSourceRows } = await import('../src/lib/sales-tax-fl');
  const { buildFlDr15Pdf } = await import('../src/lib/sales-tax-pdf');
  const month = '2026-05';
  const result = await computeFlDr15(month);
  const source = await fetchFlSourceRows(month);
  console.log(`source rows: ${source.length}, taxable: ${source.filter((r) => r.tax > 0).length}`);
  console.log('sample taxable:', source.filter((r) => r.tax > 0).slice(0, 2));
  const pdf = await buildFlDr15Pdf(result, source);
  const out = resolve(process.env.TEMP || '.', `fl-dr15-${month}.pdf`);
  writeFileSync(out, pdf);
  console.log(`PDF bytes: ${pdf.length} -> ${out}`);
  process.exit(0);
}
void main();
