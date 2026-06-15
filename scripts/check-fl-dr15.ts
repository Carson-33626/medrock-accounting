/** Verify computeFlDr15 against the calibration (Apr tax $8.06, May tax $10.54). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { computeFlDr15 } = await import('../src/lib/sales-tax-fl');
  for (const month of ['2026-04', '2026-05']) {
    const r = await computeFlDr15(month);
    console.log(`\n=== ${month} ===`);
    console.log('boxes:', r.boxes);
    console.log('inputs:', r.inputs);
    console.log(
      `diag: ${r.diagnostics.taxableTransactions}/${r.diagnostics.totalTransactions} taxable, ` +
        `summedSubtotal=${r.diagnostics.summedSubtotal}, flatBase=${r.diagnostics.flatRateTaxableBase}, ` +
        `unknownCounty=${r.diagnostics.unknownCountyRows}`,
    );
  }
  process.exit(0);
}
void main();
