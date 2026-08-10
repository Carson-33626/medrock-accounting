// ONE-TXN diagnostic: attempt a memo write via POST /developer/v1/memos/{transaction_id}.
// Approval-gated per dry-run mandate (Carson said "try now"). Run from web/:
//   npx tsx scripts/ramp-memo-test.ts
import './lib/load-env';
import { rampToken, rampGet } from './lib/ramp';

const BASE = 'https://api.ramp.com/developer/v1';
const ENTITY = 'FL' as const;
const SCOPE = 'transactions:read memos:write';

interface RawTxn {
  id: string;
  amount: number;
  memo: string | null;
  merchant_name: string | null;
  all_requirements_met_and_approved: boolean;
  state: string | null;
  user_transaction_time: string | null;
  card_holder: { first_name?: string; last_name?: string } | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

async function main(): Promise<void> {
  // 1. token with memos:write
  let token: string;
  try {
    token = await rampToken(ENTITY, SCOPE);
    console.log(`✓ token minted with scope "${SCOPE}"`);
  } catch (e) {
    console.log(`✗ token FAILED (scope likely not enabled): ${(e as Error).message}`);
    return;
  }

  // 2. find one open, memo-less FL Darik Carson txn (low $ to minimize impact)
  let candidate: RawTxn | null = null;
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 40 && next !== null && !candidate; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(ENTITY, next, token);
    for (const t of res.body.data ?? []) {
      const h = `${t.card_holder?.first_name ?? ''} ${t.card_holder?.last_name ?? ''}`.trim();
      if (
        t.state === 'CLEARED' &&
        t.all_requirements_met_and_approved === false &&
        (!t.memo || t.memo.trim() === '') &&
        h.toLowerCase().includes('darik') &&
        t.amount > 0
      ) {
        candidate = t;
        break;
      }
    }
    next = res.body.page?.next ?? null;
  }
  if (!candidate) {
    console.log('✗ no open memo-less Darik Carson FL txn found to test on');
    return;
  }
  console.log(
    `\nTarget txn: ${candidate.id}\n  ${candidate.user_transaction_time?.slice(0, 10)} | $${candidate.amount.toFixed(2)} | ${candidate.merchant_name} | memo=${JSON.stringify(candidate.memo)}`,
  );

  // 3. POST the memo
  const memoText = 'Memo added via Ramp API (automated backlog fill) — verify business purpose';
  const postRes = await fetch(`${BASE}/memos/${candidate.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ memo: memoText }),
  });
  const postText = await postRes.text();
  console.log(`\nPOST /memos/${candidate.id}`);
  console.log(`  HTTP ${postRes.status} ${postRes.statusText}`);
  console.log(`  response body: ${postText.slice(0, 800)}`);

  // 4. read it back
  const { status, body } = await rampGet<{ data?: { memo?: string }[] } & { memo?: string }>(
    ENTITY,
    `/memos/${candidate.id}`,
    token,
  );
  console.log(`\nGET /memos/${candidate.id} -> HTTP ${status}`);
  console.log(`  ${JSON.stringify(body).slice(0, 600)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
