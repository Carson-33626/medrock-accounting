// C3: order-ID collection + memo composition + the one memo write.
// Endpoint: POST /developer/v1/memos/{transaction_id} — verified 200 live on 2026-07-23 by the
// memo-backfill tool (scripts/ramp-memo-fill.ts); body is {"memo": "..."} and REPLACES the txn
// memo, which is why composeMemo re-carries the prior human text itself.
const BASE = 'https://api.ramp.com/developer/v1';

// Amazon order#s are 3-7-7 digits (same shape ramp-split-push/ramp-client.ts matches on).
const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/g;

export function collectOrderIds(texts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.match(ORDER_RE) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

// null = nothing to write: no ids recovered, or the existing memo already carries every id.
// Otherwise: "Amazon order# <missing ids space-separated>" PREPENDED, prior human text preserved
// on the following line(s) (spec C3 policy).
export function composeMemo(orderIds: string[], priorMemo: string | null): string | null {
  if (orderIds.length === 0) return null;
  const prior = (priorMemo ?? '').trim();
  const missing = orderIds.filter((id) => !prior.includes(id));
  if (missing.length === 0) return null;
  const line = `Amazon order# ${missing.join(' ')}`;
  return prior ? `${line}\n${prior}` : line;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Resilient memo POST (pattern proven by ramp-memo-fill.ts across 2,057 writes): retries
// transient network errors + 429/5xx with backoff and NEVER throws — returns status 0 on final
// failure so one blip can't kill a backlog run mid-stream.
export async function postMemo(txnId: string, memo: string, token: string, retries = 4): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/memos/${txnId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    } catch (e: unknown) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { status: 0, body: `fetch error: ${(e as Error).message}` };
    }
  }
}
