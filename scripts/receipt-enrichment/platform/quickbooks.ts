// scripts/receipt-enrichment/platform/quickbooks.ts
//
// The slice of the web app's src/lib/quickbooks-multi.ts that this program actually uses:
// token management plus qbQueryAll. QuickBooks is READ-ONLY here — bills are created through
// Ramp, not QBO — so there is no qbPost, no OAuth route helper, and no report reader.
//
// TOKENS ARE DELIBERATELY SHARED with the web app, in Supabase `accounting_quickbooks_tokens`.
// Intuit rotates the refresh token on every refresh, so a second, independent store would
// invalidate the web app's copy and QuickBooks would "randomly" stop working in the accounting
// site. This module reads and writes the same row the web app does.
//
// Unlike the original, every network and clock dependency is injectable (QbDeps), so the
// pagination and retry behaviour is unit-testable without touching Intuit or Supabase.
import { getAdminClient } from './supabase';

const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID ?? '';
const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET ?? '';
const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT ?? 'sandbox';

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_API_BASE =
  QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com/v3'
    : 'https://sandbox-quickbooks.api.intuit.com/v3';

/** Internal location name -> QuickBooks company name. Must match src/lib/quickbooks-multi.ts. */
export const LOCATION_MAPPING = {
  'MedRock FL': 'Medrock FLORIDA',
  'MedRock TN': 'Medrock TENNESSEE',
  'MedRock TX': 'Medrock TEXAS',
  'FOCAS': 'FOCAS Institute',
} as const;

export type Location = keyof typeof LOCATION_MAPPING;

export interface QbTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  realm_id: string;
  location: Location;
  company_name?: string;
}

/** A refresh that never reached Intuit. The stored refresh token is still good — retry, don't re-auth. */
export class QuickBooksUnreachableError extends Error {
  constructor(location: Location, cause: unknown) {
    super(`Could not reach QuickBooks to refresh the ${location} token — network problem, not an authorization problem. Retry shortly.`);
    this.name = 'QuickBooksUnreachableError';
    this.cause = cause;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injectable seams. Production passes none of these. */
export interface QbDeps {
  fetchImpl?: FetchLike;
  getTokens?: (location: Location) => Promise<QbTokens | null>;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function refreshAccessToken(refreshToken: string, location: Location, doFetch: FetchLike): Promise<QbTokens> {
  const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

  let response: Response;
  try {
    response = await doFetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authHeader}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
  } catch (networkError) {
    // fetch only throws on transport failure; an Intuit rejection arrives as !response.ok below.
    throw new QuickBooksUnreachableError(location, networkError);
  }

  if (!response.ok) throw new Error(`Failed to refresh token: ${await response.text()}`);

  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    realm_id: '',
    location,
  };
}

async function storeTokens(tokens: QbTokens): Promise<void> {
  const { error } = await getAdminClient()
    .from('accounting_quickbooks_tokens')
    .upsert(
      {
        location: tokens.location,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(tokens.expires_at).toISOString(),
        realm_id: tokens.realm_id,
        company_name: tokens.company_name || LOCATION_MAPPING[tokens.location],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'location' },
    );
  if (error) throw new Error(`Failed to store tokens: ${error.message}`);
}

/** Read the stored connection, refreshing when it is within 5 minutes of expiry. */
export async function getValidTokens(location: Location, doFetch: FetchLike = fetch): Promise<QbTokens | null> {
  const { data: row, error } = await getAdminClient()
    .from('accounting_quickbooks_tokens')
    .select('*')
    .eq('location', location)
    .single();

  if (error || !row) {
    console.log(`No QB tokens found for location: ${location}`);
    return null;
  }

  const tokens: QbTokens = {
    access_token: row.access_token as string,
    refresh_token: row.refresh_token as string,
    expires_at: new Date(row.expires_at as string).getTime(),
    realm_id: row.realm_id as string,
    location: row.location as Location,
    company_name: (row.company_name as string | null) ?? undefined,
  };

  if (tokens.expires_at >= Date.now() + 5 * 60 * 1000) return tokens;

  console.log(`Token expired for ${location}, refreshing...`);
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token, location, doFetch);
    // Neither value comes back from Intuit; losing them would blank the row.
    refreshed.realm_id = tokens.realm_id;
    refreshed.company_name = tokens.company_name;
    await storeTokens(refreshed);
    return refreshed;
  } catch (err) {
    if (err instanceof QuickBooksUnreachableError) throw err;
    console.error(`Token refresh failed for ${location} — connection needs re-authorization:`, err);
    return null;
  }
}

async function qbGet<T>(endpoint: string, location: Location, deps: QbDeps, retryCount = 0): Promise<T> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const getTokens = deps.getTokens ?? ((l: Location) => getValidTokens(l, doFetch));

  const tokens = await getTokens(location);
  if (!tokens) throw new Error(`QuickBooks not connected for location: ${location}. Please authorize first.`);

  const response = await doFetch(`${QB_API_BASE}/company/${tokens.realm_id}/${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 429) {
    const maxRetries = 3;
    if (retryCount >= maxRetries) {
      throw new Error(`QB API rate limit exceeded for ${location}. Please try again in a few moments.`);
    }
    const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000);
    console.log(`Rate limited for ${location}, retrying in ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
    await sleep(delayMs);
    return qbGet<T>(endpoint, location, deps, retryCount + 1);
  }

  if (!response.ok) throw new Error(`QB API error for ${location}: ${response.status} ${await response.text()}`);

  return (await response.json()) as T;
}

/**
 * Run a QBO data query (SELECT * FROM <entity> …), paginating via STARTPOSITION. The
 * QueryResponse payload keys the entity list by the entity name, so callers pass it explicitly.
 */
export async function qbQueryAll<T>(location: Location, entity: string, where: string, deps: QbDeps = {}): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  let start = 1;
  for (;;) {
    const q = `SELECT * FROM ${entity} ${where} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const data = await qbGet<{ QueryResponse?: Record<string, T[] | number | string> }>(
      `query?query=${encodeURIComponent(q)}&minorversion=75`,
      location,
      deps,
    );
    const ents = data.QueryResponse?.[entity];
    const page = Array.isArray(ents) ? ents : [];
    out.push(...page);
    if (page.length < pageSize) return out;
    start += pageSize;
  }
}
