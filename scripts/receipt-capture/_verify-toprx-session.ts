// scripts/receipt-capture/_verify-toprx-session.ts
// Live check: withTopRxPage authenticates for all 3 entities and order history renders.
import '../ramp-split-push/load-env';
import { withTopRxPage } from './toprx-session';
import type { Entity } from '../ramp-split-push/types';

async function main(): Promise<void> {
  for (const entity of ['FL', 'TN', 'TX'] as Entity[]) {
    const banner = await withTopRxPage(entity, async (page) => {
      const t = (await page.textContent('body')) ?? '';
      const m = /Welcome,\s*([A-Z ]+)/.exec(t);
      return m ? m[1].trim() : '(no welcome banner)';
    });
    console.log(`${entity}: ${banner}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
