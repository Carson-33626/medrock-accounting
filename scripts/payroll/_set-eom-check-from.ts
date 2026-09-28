// Move the month-end difference check's start month (same as the End of Month tab's lever),
// then recheck. Carson 2026-09-28: skip March. Writes only eom_diff_settings / runs / checks;
// READ-ONLY against QuickBooks. Posts nothing.
import './load-env-vercel-first';
import { updateSettings } from '../../src/lib/payroll/eom-diff-store';
import { runEomDiff, getEomDiffStatus } from '../../src/lib/payroll/eom-diff-server';

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-04';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const saved = await updateSettings({ checkFromMonth: month }, 'carson (via claude, 2026-09-28)');
  console.log('settings:', JSON.stringify(saved));
  const run = await runEomDiff('manual');
  console.log('run:', JSON.stringify(run));
  const status = await getEomDiffStatus();
  console.log('flagged:', JSON.stringify(status.flagged));
  for (const c of status.checks) {
    console.log(`${c.month} ${c.entity}: delta Dr $${c.deltaDebits.toFixed(2)} flagged=${c.flagged}${c.error ? ` ERROR=${c.error}` : ''}`);
  }
}
void main().then(() => process.exit(0)).catch((e: Error) => { console.error(e); process.exit(1); });
