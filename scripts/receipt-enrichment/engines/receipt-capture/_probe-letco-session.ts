// web/scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-session.ts
// Live smoke: can we log in and pull page 0 of the invoice roster? READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-letco-session.ts FL
import '../ramp-split-push/load-env';
import { LetcoSession } from './letco-session';
import type { Entity } from '../ramp-split-push/types';

async function main(): Promise<void> {
  const entity = (process.argv[2] ?? 'FL') as Entity;
  const session = await LetcoSession.login(entity);
  console.log(`[${entity}] authenticated`);
  const res = await session.postForm('/profile/orders/?OrderType=Invoice', {
    page: '0',
    OrderType: 'Invoice',
    StartDate: '5/1/2026',
    EndDate: '',
    OrderId: '',
    DocumentId: '',
  });
  console.log(`  roster page 0: HTTP ${res.status} ${res.contentType.split(';')[0]} ${res.text.length}B`);
  const parsed: { Items?: unknown[]; TotalCount?: number } = JSON.parse(res.text);
  console.log(`  items: ${parsed.Items?.length ?? 0}  TotalCount: ${parsed.TotalCount ?? '?'}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
