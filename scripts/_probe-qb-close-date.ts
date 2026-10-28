/** READ-ONLY: QuickBooks book-close date per company, and whether the correction accounts resolve. */
import './lib/load-env';
import { qbQueryAll } from '../src/lib/quickbooks-multi';
import { fetchDimensions } from '../src/lib/payroll/qb-journal';
import { QB_LOCATIONS } from '../src/lib/qb-links';
interface Prefs { AccountingInfoPrefs?: { BookCloseDate?: string; FirstMonthOfFiscalYear?: string } }
const NEEDED = [
  'Inventory Asset:Commercial Rx Inventory', 'Inventory Asset:Compound Ingredient Inventory',
  'Inventory Asset:Compound Packaging Inventory', 'Inventory Asset:Lab Supplies Inventory', 'Inventory Asset',
  'Cost of Goods Sold:Commercial RX', 'Cost of Goods Sold:Compound Ingredient', 'Cost of Goods Sold:Compound Packaging',
  'Cost of Goods Sold:Lab Supplies', 'Cost of Goods Sold', 'Cost of Goods Sold:Drug Waste & Shrinkage', 'Accrued Expenses',
];
async function main(): Promise<void> {
  for (const loc of QB_LOCATIONS) {
    const prefs = await qbQueryAll<Prefs>(loc, 'Preferences', '').catch((e: unknown) => { console.log(loc, 'prefs ERR', e instanceof Error ? e.message : e); return [] as Prefs[]; });
    const p = prefs[0]?.AccountingInfoPrefs;
    console.log(`\n${loc}: BookCloseDate=${p?.BookCloseDate ?? '(none)'}  FY starts ${p?.FirstMonthOfFiscalYear ?? '?'}`);
    const refs = await fetchDimensions(loc).catch((e: unknown) => { console.log('  dims ERR', e instanceof Error ? e.message : e); return null; });
    if (!refs) continue;
    for (const n of NEEDED) {
      const ok = n in refs.accounts;
      console.log(`  ${ok ? 'ok ' : 'MISSING'} ${(refs.accountNums?.[n] ?? '').padEnd(8)} ${n}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e: unknown) => { console.error(e); process.exit(1); });
