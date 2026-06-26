import type { Entity, RampTxn } from './types';

const BASE = 'https://api.ramp.com/developer/v1';

function creds(entity: Entity): { id: string; secret: string } {
  const id = process.env[`RAMP_${entity}_CLIENT_ID`];
  const secret = process.env[`RAMP_${entity}_CLIENT_SECRET`];
  if (!id || !secret) throw new Error(`Missing RAMP_${entity}_CLIENT_ID/SECRET`);
  return { id, secret };
}

export async function rampToken(entity: Entity, scope: string): Promise<string> {
  const { id, secret } = creds(entity);
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const json = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Ramp token failed (${entity}): ${res.status} ${json.error_description ?? ''}`);
  }
  return json.access_token;
}

export async function rampGet<T>(entity: Entity, pathOrUrl: string, token: string): Promise<{ status: number; body: T }> {
  // Ramp's `page.next` is a full URL — follow it as-is; otherwise prepend the base path.
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

interface RawRampTxn {
  id: string;
  amount: number;
  user_transaction_time: string;
  card_id: string | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  memo: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  line_items: unknown;
}

// Amazon order#s are 3-7-7 digits: 111-2233445-6677889. Pull the first occurrence from text.
function parseOrderNo(...texts: (string | null | undefined)[]): string | null {
  const re = /\b\d{3}-\d{7}-\d{7}\b/;
  for (const t of texts) {
    if (!t) continue;
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

interface RampTxnPage {
  data: RawRampTxn[];
  page?: { next?: string };
}

export async function getRampTransactions(entity: Entity, token: string, pages = 30): Promise<RampTxn[]> {
  const out: RampTxn[] = [];
  let nextUrl: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && nextUrl !== null; i++) {
    const res: { status: number; body: RampTxnPage } = await rampGet<RampTxnPage>(entity, nextUrl, token);
    const body: RampTxnPage = res.body;
    const rows: RawRampTxn[] = body.data ?? [];
    for (const r of rows) {
      const holder = r.card_holder ? `${r.card_holder.first_name ?? ''} ${r.card_holder.last_name ?? ''}`.trim() : null;
      out.push({
        id: r.id,
        entity,
        amountCents: Math.round(r.amount * 100),
        date: (r.user_transaction_time ?? '').slice(0, 10),
        cardId: r.card_id,
        cardHolder: holder || null,
        memo: r.memo,
        merchantName: r.merchant_name,
        orderNo: parseOrderNo(r.memo, r.merchant_descriptor),
        priorLineItems: r.line_items,
      });
    }
    if (rows.length === 0) break;
    nextUrl = body.page?.next ?? null;
  }
  return out;
}

interface RawAccount { id: string; code: string | null; name: string }
interface AccountsPage { data: RawAccount[]; page?: { next?: string } }
export async function getRampAccounts(entity: Entity, token: string): Promise<RawAccount[]> {
  // The QB chart of accounts exceeds one page (100) — paginate so the coding map is complete,
  // otherwise valid expense accounts beyond the first page show as "not in coding map".
  const out: RawAccount[] = [];
  let url: string | null = '/accounting/accounts?page_size=100';
  for (let i = 0; i < 50 && url !== null; i++) {
    const res: { status: number; body: AccountsPage } = await rampGet<AccountsPage>(entity, url, token);
    const rows: RawAccount[] = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}

interface RawField { id: string; ramp_id: string; name: string }
export async function getRampFields(entity: Entity, token: string): Promise<{ id: string; rampId: string; name: string }[]> {
  const { body } = await rampGet<{ data: RawField[] }>(entity, '/accounting/fields?page_size=100', token);
  return (body.data ?? []).map((f) => ({ id: f.id, rampId: f.ramp_id, name: f.name }));
}

interface RawOption { id: string; value: string }
export async function getRampFieldOptions(entity: Entity, token: string, fieldRampId: string): Promise<RawOption[]> {
  const { body } = await rampGet<{ data: RawOption[] }>(
    entity,
    `/accounting/field-options?field_id=${fieldRampId}&page_size=100`,
    token,
  );
  return body.data ?? [];
}
