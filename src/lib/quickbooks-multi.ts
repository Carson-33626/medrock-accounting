/**
 * QuickBooks Online API Integration - Multi-Location Support
 *
 * Handles OAuth 2.0 authentication and API calls to QuickBooks Online.
 * Supports multiple QB companies (one per location: FL, TN, TX).
 * Tokens are stored in Supabase keyed by location.
 */

import { getAdminClient } from './supabase-admin';
import type { JsonValue } from './payroll/store';

const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID!;
const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET!;
const QB_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI!;
const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'

// QuickBooks API base URLs
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const QB_API_BASE =
  QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com/v3'
    : 'https://sandbox-quickbooks.api.intuit.com/v3';

// Location mapping: Internal name -> QuickBooks company name
export const LOCATION_MAPPING = {
  'MedRock FL': 'Medrock FLORIDA',
  'MedRock TN': 'Medrock TENNESSEE',
  'MedRock TX': 'Medrock TEXAS',
  // Display default only — the callback stores the realm's real CompanyName at connect time.
  'FOCAS': 'FOCAS Institute',
} as const;

// Reverse mapping: QuickBooks company name -> Internal name
export const QB_TO_LOCATION_MAPPING = {
  'Medrock FLORIDA': 'MedRock FL',
  'Medrock TENNESSEE': 'MedRock TN',
  'Medrock TEXAS': 'MedRock TX',
  'FOCAS Institute': 'FOCAS',
} as const;

export type Location = keyof typeof LOCATION_MAPPING;
export type QBCompanyName = keyof typeof QB_TO_LOCATION_MAPPING;

interface QuickBooksTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp
  realm_id: string; // Company ID
  location: Location; // MedRock FL | MedRock TN | MedRock TX | FOCAS
  company_name?: string; // Medrock FLORIDA | TENNESSEE | TEXAS | FOCAS Institute
}

/**
 * Get the OAuth authorization URL to initiate a QB connection.
 *
 * @param state - A signed, single-use CSRF state from `createOAuthState`. It also CARRIES the
 *   location, which is why this no longer takes one: the callback must read the location out of
 *   a value it has verified, never out of an unauthenticated query param.
 */
export function getAuthorizationUrl(state: string): string {
  if (!state) {
    // `state` used to default to the location key, which made it guessable and therefore useless
    // as CSRF protection. It is now a required, signed, single-use value minted by
    // createOAuthState — see src/lib/quickbooks-oauth-state.ts. Refusing to build a URL without
    // one keeps a future caller from silently reintroducing the hole.
    throw new Error('getAuthorizationUrl requires a signed CSRF state — see quickbooks-oauth-state.ts');
  }
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    state,
  });

  return `${QB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens
 */
export async function exchangeCodeForTokens(code: string, location: Location): Promise<QuickBooksTokens> {
  const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: QB_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code: ${error}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    realm_id: data.realmId || '',
    location,
  };
}

/**
 * Real company name from QBO CompanyInfo — called once at OAuth connect so the
 * token row records what the realm actually is, not the LOCATION_MAPPING guess.
 * Never throws: connect must succeed even if this lookup fails.
 */
export async function fetchCompanyName(accessToken: string, realmId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${QB_API_BASE}/company/${realmId}/companyinfo/${realmId}?minorversion=75`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { CompanyInfo?: { CompanyName?: string } };
    return data.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

/**
 * Thrown when a token refresh could not REACH Intuit (DNS, TLS, connect timeout). Distinct from
 * Intuit rejecting the refresh token, because the two need opposite responses: this one is
 * transient and the caller should retry, whereas a rejection genuinely requires re-authorization.
 * Conflating them told accounting "connection needs re-authorization" every time the network
 * hiccuped, which is alarming and wrong — nobody needs to reconnect anything.
 */
export class QuickBooksUnreachableError extends Error {
  constructor(location: Location, cause: unknown) {
    super(`Could not reach QuickBooks to refresh the ${location} token — network problem, not an authorization problem. Retry shortly.`);
    this.name = 'QuickBooksUnreachableError';
    this.cause = cause;
  }
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(refreshToken: string, location: Location): Promise<QuickBooksTokens> {
  const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

  let response: Response;
  try {
    response = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authHeader}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
  } catch (networkError) {
    // fetch() only throws for transport failures; an Intuit rejection arrives as !response.ok
    // below. So reaching here means we never got an answer, and the stored refresh token is
    // still perfectly good.
    throw new QuickBooksUnreachableError(location, networkError);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    realm_id: '', // Keep existing realm_id from DB
    location,
  };
}

/**
 * Store QB tokens in Supabase (upserts by location)
 */
export async function storeTokens(tokens: QuickBooksTokens): Promise<void> {
  const supabase = getAdminClient();

  const { error } = await supabase
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
      {
        onConflict: 'location',
      }
    );

  if (error) {
    throw new Error(`Failed to store tokens: ${error.message}`);
  }
}

/**
 * Get valid QB tokens for a specific location (refreshes if expired)
 */
export async function getValidTokens(location: Location): Promise<QuickBooksTokens | null> {
  const supabase = getAdminClient();

  const { data: tokenRow, error } = await supabase
    .from('accounting_quickbooks_tokens')
    .select('*')
    .eq('location', location)
    .single();

  if (error || !tokenRow) {
    console.log(`No QB tokens found for location: ${location}`);
    return null;
  }

  const tokens: QuickBooksTokens = {
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_at: new Date(tokenRow.expires_at).getTime(),
    realm_id: tokenRow.realm_id,
    location: tokenRow.location as Location,
    company_name: tokenRow.company_name ?? undefined,
  };

  // Check if token is expired (with 5 min buffer)
  const now = Date.now();
  if (tokens.expires_at < now + 5 * 60 * 1000) {
    console.log(`Token expired for ${location}, refreshing...`);
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token, location);
      refreshed.realm_id = tokens.realm_id; // Preserve realm_id
      // Preserve the real company name — refreshAccessToken never sets it, and
      // storeTokens falls back to the LOCATION_MAPPING placeholder when absent.
      refreshed.company_name = tokens.company_name;

      await storeTokens(refreshed);
      return refreshed;
    } catch (error) {
      // A network failure is NOT a dead connection. Propagate it so the caller can retry and so
      // the accountant is never told to re-authorize a connection that is actually fine — the
      // "connection needs re-authorization" message used to fire on any transient blip.
      if (error instanceof QuickBooksUnreachableError) throw error;
      // Dead refresh token (e.g. invalid_grant after Intuit's 100-day expiry).
      // Treat as disconnected so status pages render a re-auth prompt instead of 500ing.
      console.error(`Token refresh failed for ${location} — connection needs re-authorization:`, error);
      return null;
    }
  }

  return tokens;
}

/**
 * Get all connected locations
 */
export async function getConnectedLocations(): Promise<Location[]> {
  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from('accounting_quickbooks_tokens')
    .select('location')
    .order('location');

  if (error) {
    console.error('Error fetching connected locations:', error);
    return [];
  }

  return (data?.map(row => row.location as Location) || []) as Location[];
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make authenticated API call to QuickBooks with retry logic for rate limiting
 */
async function qbRequest<T>(
  endpoint: string,
  location: Location,
  options: RequestInit = {},
  retryCount = 0
): Promise<T> {
  const tokens = await getValidTokens(location);

  if (!tokens) {
    throw new Error(`QuickBooks not connected for location: ${location}. Please authorize first.`);
  }

  const url = `${QB_API_BASE}/company/${tokens.realm_id}/${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle rate limiting (429) with exponential backoff
  if (response.status === 429) {
    const maxRetries = 3;
    if (retryCount < maxRetries) {
      const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000); // 1s, 2s, 4s (max 10s)
      console.log(`Rate limited for ${location}, retrying in ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await sleep(delayMs);
      return qbRequest<T>(endpoint, location, options, retryCount + 1);
    } else {
      throw new Error(`QB API rate limit exceeded for ${location}. Please try again in a few moments.`);
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`QB API error for ${location}: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Make authenticated POST call to QuickBooks with a JSON body, with the same
 * rate-limit retry behavior as qbRequest. Used for writes (e.g. JournalEntry).
 */
export async function qbPost<T>(
  location: Location,
  endpoint: string,
  body: JsonValue,
  retryCount = 0
): Promise<T> {
  const tokens = await getValidTokens(location);

  if (!tokens) {
    throw new Error(`QuickBooks not connected for location: ${location}. Please authorize first.`);
  }

  const url = `${QB_API_BASE}/company/${tokens.realm_id}/${endpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Handle rate limiting (429) with exponential backoff
  if (response.status === 429) {
    const maxRetries = 3;
    if (retryCount < maxRetries) {
      const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000); // 1s, 2s, 4s (max 10s)
      console.log(`Rate limited for ${location}, retrying in ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await sleep(delayMs);
      return qbPost<T>(location, endpoint, body, retryCount + 1);
    } else {
      throw new Error(`QB API rate limit exceeded for ${location}. Please try again in a few moments.`);
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`QB API error for ${location}: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Run a QBO data query (SELECT * FROM <entity> ...), transparently paginating
 * via STARTPOSITION. The QueryResponse payload keys the entity list by the
 * entity name, so callers pass it explicitly.
 */
export async function qbQueryAll<T>(location: Location, entity: string, where: string): Promise<T[]> {
  const out: T[] = [];
  let start = 1;
  const pageSize = 1000;
  for (;;) {
    const q = `SELECT * FROM ${entity} ${where} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const data = await qbRequest<{ QueryResponse?: Record<string, T[] | number | string> }>(
      `query?query=${encodeURIComponent(q)}&minorversion=75`,
      location,
      { method: 'GET' },
    );
    const ents = data.QueryResponse?.[entity];
    const page = Array.isArray(ents) ? ents : [];
    out.push(...page);
    if (page.length < pageSize) return out;
    start += pageSize;
  }
}

/**
 * Get Profit & Loss report from QuickBooks
 */
export async function getProfitAndLoss(params: {
  location: Location;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  accounting_method?: 'Accrual' | 'Cash';
  summarize_column_by?: 'Month' | 'Quarter' | 'Year';
}) {
  const queryParams = new URLSearchParams({
    start_date: params.startDate,
    end_date: params.endDate,
    // Use Cash basis to match LifeFile's cash collection timing (total_pt_paid)
    // Accrual would record revenue when earned, Cash records when actually received
    accounting_method: params.accounting_method || 'Cash',
  });
  if (params.summarize_column_by) {
    queryParams.set('summarize_column_by', params.summarize_column_by);
  }

  const endpoint = `reports/ProfitAndLoss?${queryParams.toString()}`;
  return qbRequest(endpoint, params.location, { method: 'GET' });
}

// ── Monthly P&L (one call/location via summarize_column_by=Month) ──
// Minimal typed view of the QB ProfitAndLoss report shape we read.
interface QbColMeta {
  Name: string;
  Value: string;
}
interface QbColumn {
  ColTitle?: string;
  ColType?: string;
  MetaData?: QbColMeta[];
}
interface QbColData {
  value?: string;
}
interface QbReportRow {
  group?: string;
  Summary?: { ColData?: QbColData[] };
}
interface QbMonthlyReport {
  Columns?: { Column?: QbColumn[] };
  Rows?: { Row?: QbReportRow[] };
}

export interface MonthlyPnl {
  month: string; // 'YYYY-MM'
  revenue: number;
  cogs: number;
  grossProfit: number;
  netIncome: number;
}

/** Column index → 'YYYY-MM' for the report's month columns (skips label + Total columns). */
function monthColumns(report: QbMonthlyReport): Array<{ index: number; month: string }> {
  const cols = report.Columns?.Column ?? [];
  const out: Array<{ index: number; month: string }> = [];
  cols.forEach((col, index) => {
    if ((col.ColTitle ?? '').toLowerCase() === 'total') return;
    const start = col.MetaData?.find((m) => m.Name === 'StartDate')?.Value;
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      out.push({ index, month: start.slice(0, 7) });
    }
  });
  return out;
}

/** Per-column values from a top-level section's Summary row, keyed by group. */
function sectionSummaryByColumn(report: QbMonthlyReport, group: string): QbColData[] | null {
  const section = (report.Rows?.Row ?? []).find((r) => r.group === group);
  return section?.Summary?.ColData ?? null;
}

/**
 * Monthly P&L for one location in a single QB call (summarize_column_by=Month).
 * Throws if the report has no recognizable month columns / section summaries —
 * callers surface the error rather than silently zero-filling.
 */
export async function getMonthlyProfitAndLoss(params: {
  location: Location;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  accounting_method?: 'Cash' | 'Accrual';
}): Promise<MonthlyPnl[]> {
  const report = (await getProfitAndLoss({ ...params, summarize_column_by: 'Month' })) as QbMonthlyReport;

  const months = monthColumns(report);
  if (months.length === 0) {
    throw new Error(`QB monthly P&L for ${params.location} returned no month columns`);
  }

  const incomeCols = sectionSummaryByColumn(report, 'Income');
  const cogsCols = sectionSummaryByColumn(report, 'COGS');
  const netIncomeCols = sectionSummaryByColumn(report, 'NetIncome');
  if (!incomeCols && !netIncomeCols) {
    throw new Error(`QB monthly P&L for ${params.location} returned no section summaries`);
  }

  const valAt = (cols: QbColData[] | null, index: number): number =>
    cols ? parseFloat(cols[index]?.value || '0') || 0 : 0;

  return months.map(({ index, month }) => {
    const revenue = valAt(incomeCols, index);
    const cogs = valAt(cogsCols, index);
    const netIncome = valAt(netIncomeCols, index);
    return { month, revenue, cogs, grossProfit: revenue - cogs, netIncome };
  });
}

/**
 * Get revenue summary by period for a specific location
 */
export async function getRevenueSummary(params: {
  location: Location;
  startDate: string;
  endDate: string;
  accounting_method?: 'Cash' | 'Accrual';
}): Promise<{
  period: string;
  revenue: number;
  product_revenue: number;
  shipping_revenue: number;
  cost_of_goods: number;
  gross_profit: number;
}> {
  const report = await getProfitAndLoss(params);

  // QuickBooks combines all revenue in account 4000 (includes product + shipping)
  const totalRevenue = extractAccountFromReport(report, '4000', 'Revenue');

  // Note: QB doesn't separate product vs shipping revenue in the P&L
  // Account 4100 (Shipping Revenue) either doesn't exist or has no transactions
  // We'll put all revenue in product_revenue since it's combined in QB
  const productRevenue = totalRevenue;
  const shippingRevenue = 0; // Not tracked separately in QB

  const cogs = extractCOGSFromReport(report);

  console.log(`[QB Revenue] Account 4000 Total: $${totalRevenue.toLocaleString()}`);

  return {
    period: `${params.startDate} to ${params.endDate}`,
    revenue: totalRevenue,
    product_revenue: productRevenue,
    shipping_revenue: shippingRevenue,
    cost_of_goods: cogs,
    gross_profit: totalRevenue - cogs,
  };
}

/**
 * Get revenue data grouped by period (monthly/quarterly/yearly) for a specific location
 * Processes periods sequentially to avoid rate limiting
 */
export async function getRevenueByPeriod(params: {
  location: Location;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  granularity: 'monthly' | 'quarterly' | 'yearly';
  accounting_method?: 'Cash' | 'Accrual';
}): Promise<
  Array<{
    period: string;
    revenue: number;
    product_revenue: number;
    shipping_revenue: number;
    cost_of_goods: number;
    gross_profit: number;
  }>
> {
  const { location, startDate, endDate, granularity } = params;

  // Split date range into periods based on granularity
  const periods = generatePeriods(startDate, endDate, granularity);

  // Fetch P&L for each period SEQUENTIALLY to avoid rate limiting
  const results = [];
  for (const { start, end, label } of periods) {
    try {
      const summary = await getRevenueSummary({
        location,
        startDate: start,
        endDate: end,
        accounting_method: params.accounting_method
      });
      results.push({
        period: label,
        revenue: summary.revenue,
        product_revenue: summary.product_revenue,
        shipping_revenue: summary.shipping_revenue,
        cost_of_goods: summary.cost_of_goods,
        gross_profit: summary.gross_profit,
      });
      // Small delay between requests to be respectful to API limits
      await sleep(250);
    } catch (error) {
      console.error(`Error fetching ${location} data for period ${label}:`, error);
      // Include period with zero values on error
      results.push({
        period: label,
        revenue: 0,
        product_revenue: 0,
        shipping_revenue: 0,
        cost_of_goods: 0,
        gross_profit: 0,
      });
    }
  }

  return results;
}

/**
 * Get revenue for ALL connected locations, grouped by period
 * Processes locations sequentially to avoid rate limiting
 */
export async function getRevenueAllLocations(params: {
  startDate: string;
  endDate: string;
  granularity: 'monthly' | 'quarterly' | 'yearly';
  accounting_method?: 'Cash' | 'Accrual';
}): Promise<Record<string, Array<{
  period: string;
  revenue: number;
  product_revenue: number;
  shipping_revenue: number;
  cost_of_goods: number;
  gross_profit: number;
}>>> {
  const locations = await getConnectedLocations();

  const results: Record<string, any[]> = {};

  // Process locations SEQUENTIALLY to avoid overwhelming the API
  for (const location of locations) {
    try {
      console.log(`Fetching QB data for ${location}...`);
      const revenue = await getRevenueByPeriod({ ...params, location });
      results[location] = revenue;
      console.log(`Successfully fetched QB data for ${location}`);
    } catch (error) {
      console.error(`Error fetching revenue for ${location}:`, error);
      results[location] = [];
    }
  }

  return results;
}

/**
 * Helper: Generate period ranges based on granularity
 */
function generatePeriods(
  startDate: string,
  endDate: string,
  granularity: 'monthly' | 'quarterly' | 'yearly'
): Array<{ start: string; end: string; label: string }> {
  const periods: Array<{ start: string; end: string; label: string }> = [];

  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start);

  while (current <= end) {
    const periodStart = new Date(current); // Save period start before modifying current
    let periodEnd: Date;
    let label: string;

    if (granularity === 'yearly') {
      const year = current.getFullYear();
      periodEnd = new Date(year, 11, 31);
      label = `${year}`;
      current = new Date(year + 1, 0, 1);
    } else if (granularity === 'quarterly') {
      const year = current.getFullYear();
      const quarter = Math.floor(current.getMonth() / 3);
      const quarterMonth = quarter * 3;
      periodEnd = new Date(year, quarterMonth + 3, 0);
      label = `${year}-Q${quarter + 1}`;
      current = new Date(year, quarterMonth + 3, 1);
    } else {
      const year = current.getFullYear();
      const month = current.getMonth();
      periodEnd = new Date(year, month + 1, 0);
      label = `${year}-${(month + 1).toString().padStart(2, '0')}`;
      current = new Date(year, month + 1, 1);
    }

    if (periodEnd > end) {
      periodEnd = end;
    }

    periods.push({
      start: formatDate(periodStart < start ? start : periodStart),
      end: formatDate(periodEnd),
      label,
    });

    if (periodEnd >= end) break;
  }

  return periods;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper: Extract specific account value from P&L report
 */
function extractAccountFromReport(report: any, accountNumber: string, accountName: string): number {
  try {
    const rows = report?.Rows?.Row || [];

    // Find the Income section
    const incomeSection = rows.find(
      (row: any) =>
        row.group === 'Income' ||
        row.Header?.ColData?.[0]?.value?.includes('Income') ||
        row.Header?.ColData?.[0]?.value?.includes('Revenue')
    );

    if (!incomeSection?.Rows?.Row) {
      console.log(`[QB Extract] No income section found for account ${accountNumber}`);
      return 0;
    }

    // DEBUG: Log all accounts found in Income section
    console.log(`[QB Extract] Looking for account ${accountNumber} (${accountName})`);
    console.log(`[QB Extract] Found ${incomeSection.Rows.Row.length} account rows in Income section`);
    incomeSection.Rows.Row.forEach((row: any, idx: number) => {
      const colData = row.ColData?.[0];
      console.log(`[QB Extract] Row ${idx}:`, {
        id: colData?.id,
        value: colData?.value,
        amount: row.ColData?.[row.ColData?.length - 1]?.value
      });
    });

    // Search for the specific account by number or name
    const accountRow = incomeSection.Rows.Row.find((row: any) => {
      const colData = row.ColData?.[0];
      const value = (colData?.value || '').toString();
      const id = (colData?.id || '').toString();

      // Match by:
      // 1. Exact account number in ID field
      // 2. Account number anywhere in value (e.g., "4000 Revenue")
      // 3. Account name in value
      const matchesId = id === accountNumber;
      const matchesNumber = value.includes(accountNumber);
      const matchesName = value.includes(accountName);

      const matched = matchesId || matchesNumber || matchesName;

      if (matched) {
        console.log(`[QB Extract] MATCH FOUND for ${accountNumber}:`, { id, value, matchesId, matchesNumber, matchesName });
      }

      return matched;
    });

    if (accountRow?.ColData) {
      // The last column typically contains the amount
      const totalCol = accountRow.ColData[accountRow.ColData.length - 1];
      const amount = parseFloat(totalCol?.value || '0');
      console.log(`[QB Extract] ✓ Found ${accountNumber}: $${amount.toLocaleString()}`);
      return amount;
    }

    console.log(`[QB Extract] ✗ Account ${accountNumber} (${accountName}) NOT FOUND`);
    return 0;
  } catch (error) {
    console.error(`Error parsing QB account ${accountNumber} (${accountName}):`, error);
    return 0;
  }
}

/**
 * Helper: Extract total revenue from P&L report
 */
function extractRevenueFromReport(report: any): number {
  try {
    const rows = report?.Rows?.Row || [];
    const incomeSection = rows.find(
      (row: any) =>
        row.group === 'Income' ||
        row.Header?.ColData?.[0]?.value?.includes('Income') ||
        row.Header?.ColData?.[0]?.value?.includes('Revenue')
    );

    if (!incomeSection) return 0;

    const summaryRow = incomeSection.Summary;
    if (summaryRow?.ColData) {
      const totalCol = summaryRow.ColData[summaryRow.ColData.length - 1];
      return parseFloat(totalCol?.value || '0');
    }

    return 0;
  } catch (error) {
    console.error('Error parsing QB revenue:', error);
    return 0;
  }
}

/**
 * Helper: Extract cost of goods sold from P&L report
 */
function extractCOGSFromReport(report: any): number {
  try {
    const rows = report?.Rows?.Row || [];
    const cogsSection = rows.find(
      (row: any) =>
        row.group === 'COGS' ||
        row.Header?.ColData?.[0]?.value?.includes('Cost of Goods Sold')
    );

    if (!cogsSection) return 0;

    const summaryRow = cogsSection.Summary;
    if (summaryRow?.ColData) {
      const totalCol = summaryRow.ColData[summaryRow.ColData.length - 1];
      return parseFloat(totalCol?.value || '0');
    }

    return 0;
  } catch (error) {
    console.error('Error parsing QB COGS:', error);
    return 0;
  }
}

/**
 * Helper: Recursively search rows for payroll accounts
 * Returns total of all matching accounts
 *
 * MedRock account structure:
 * - 5010.xx: COGS - Payroll Expense (Lab Wages, Pharmacist Wages, Employer Taxes)
 * - 6500.xx: Payroll Expense (Admin, Customer Service, Data Entry, Marketing, etc.)
 * - 6800.15: Payroll - Car Allowance (in Sales & Marketing)
 */
function findPayrollInRows(rows: any[], depth = 0): number {
  let total = 0;
  const indent = '  '.repeat(depth);

  for (const row of rows) {
    // Check if this is a section header with nested rows
    if (row.Header?.ColData) {
      const headerValue = (row.Header.ColData[0]?.value || '').toString().toLowerCase();

      // If this is a payroll-related section (5010 or 6500), use its summary total
      const isPayrollSection =
        headerValue.includes('5010') ||
        headerValue.includes('6500') ||
        (headerValue.includes('payroll') && !headerValue.includes('car allowance'));

      if (isPayrollSection) {
        // Use the Summary row total for the entire section
        if (row.Summary?.ColData) {
          const summaryAmount = parseFloat(row.Summary.ColData[row.Summary.ColData.length - 1]?.value || '0');
          if (summaryAmount !== 0) {
            console.log(`${indent}[QB Payroll] Section total: ${row.Header.ColData[0]?.value} = $${summaryAmount.toLocaleString()}`);
            total += summaryAmount;
          }
        }
      } else if (row.Rows?.Row) {
        // Not a payroll section, but recurse to find payroll accounts within
        total += findPayrollInRows(row.Rows.Row, depth + 1);
      }
    }

    // Check individual account rows (for accounts like 6800.15 Payroll - Car Allowance)
    if (row.ColData && !row.Header) {
      const colData = row.ColData[0];
      const value = (colData?.value || '').toString().toLowerCase();

      // Match individual payroll accounts (not sections)
      // This catches things like "6800.15 Payroll - Car Allowance"
      const isPayrollAccount =
        (value.includes('payroll') && !value.includes('processing fee')) ||
        value.includes('wages') ||
        value.includes('salaries');

      if (isPayrollAccount) {
        const amount = parseFloat(row.ColData[row.ColData.length - 1]?.value || '0');
        if (amount !== 0) {
          console.log(`${indent}[QB Payroll] Found: ${colData?.value} = $${amount.toLocaleString()}`);
          total += amount;
        }
      }
    }

    // Also check for nested Rows without Header (some QB formats)
    if (row.Rows?.Row && !row.Header) {
      total += findPayrollInRows(row.Rows.Row, depth + 1);
    }
  }

  return total;
}

/**
 * Helper: Extract payroll expenses from P&L report
 * Searches BOTH COGS section (5010) and Expenses section (6500) for payroll
 * Returns absolute value since expenses may be recorded as negative credits
 */
function extractPayrollFromReport(report: any): number {
  try {
    const rows = report?.Rows?.Row || [];
    let payrollTotal = 0;

    console.log('[QB Payroll] Searching for payroll in COGS and Expenses sections...');

    // Search COGS section for 5010 COGS - Payroll Expense
    const cogsSection = rows.find(
      (row: any) =>
        row.group === 'COGS' ||
        row.Header?.ColData?.[0]?.value?.includes('Cost of Goods Sold')
    );

    if (cogsSection?.Rows?.Row) {
      console.log('[QB Payroll] Searching COGS section...');
      const cogsPayroll = findPayrollInRows(cogsSection.Rows.Row);
      payrollTotal += cogsPayroll;
    }

    // Search Expenses section for 6500 Payroll Expense and other payroll accounts
    const expensesSection = rows.find(
      (row: any) =>
        row.group === 'Expenses' ||
        row.Header?.ColData?.[0]?.value?.includes('Expenses')
    );

    if (expensesSection?.Rows?.Row) {
      console.log('[QB Payroll] Searching Expenses section...');
      const expensesPayroll = findPayrollInRows(expensesSection.Rows.Row);
      payrollTotal += expensesPayroll;
    }

    // Return absolute value since expenses are often recorded as negative credits
    const absolutePayroll = Math.abs(payrollTotal);
    console.log(`[QB Extract] Total payroll: $${absolutePayroll.toLocaleString()} (raw: ${payrollTotal})`);
    return absolutePayroll;
  } catch (error) {
    console.error('Error parsing QB payroll:', error);
    return 0;
  }
}

/**
 * Helper: Extract operating expenses from P&L report (excluding payroll)
 * Gets total expenses minus ONLY the expenses-section payroll (not COGS payroll)
 */
function extractOperatingExpensesFromReport(report: any): number {
  try {
    const rows = report?.Rows?.Row || [];

    // Find the Expenses section
    const expensesSection = rows.find(
      (row: any) =>
        row.group === 'Expenses' ||
        row.Header?.ColData?.[0]?.value?.includes('Expenses')
    );

    if (!expensesSection) {
      console.log('[QB Extract] No expenses section found');
      return 0;
    }

    // Get total expenses from summary
    let totalExpenses = 0;
    const summaryRow = expensesSection.Summary;
    if (summaryRow?.ColData) {
      const totalCol = summaryRow.ColData[summaryRow.ColData.length - 1];
      totalExpenses = Math.abs(parseFloat(totalCol?.value || '0'));
    }

    // Get ONLY the expenses-section payroll (6500, not 5010 COGS payroll)
    let expensesPayroll = 0;
    if (expensesSection?.Rows?.Row) {
      expensesPayroll = Math.abs(findPayrollInRows(expensesSection.Rows.Row));
    }

    // Operating expenses = total expenses - payroll from expenses section
    const operatingExpenses = totalExpenses - expensesPayroll;

    console.log(`[QB Extract] Total expenses: $${totalExpenses.toLocaleString()}`);
    console.log(`[QB Extract] Expenses-section payroll: $${expensesPayroll.toLocaleString()}`);
    console.log(`[QB Extract] Operating expenses (excl. payroll): $${operatingExpenses.toLocaleString()}`);

    return operatingExpenses;
  } catch (error) {
    console.error('Error parsing QB operating expenses:', error);
    return 0;
  }
}

/**
 * Helper: Extract net income from P&L report
 */
function extractNetIncomeFromReport(report: any): number {
  try {
    const rows = report?.Rows?.Row || [];

    // Find the Net Income row (usually at the end)
    const netIncomeRow = rows.find(
      (row: any) =>
        row.group === 'NetIncome' ||
        row.Header?.ColData?.[0]?.value?.includes('Net Income')
    );

    if (!netIncomeRow) {
      console.log('[QB Extract] No net income found');
      return 0;
    }

    const summaryRow = netIncomeRow.Summary;
    if (summaryRow?.ColData) {
      const totalCol = summaryRow.ColData[summaryRow.ColData.length - 1];
      const netIncome = parseFloat(totalCol?.value || '0');
      console.log(`[QB Extract] Net income: $${netIncome.toLocaleString()}`);
      return netIncome;
    }

    return 0;
  } catch (error) {
    console.error('Error parsing QB net income:', error);
    return 0;
  }
}

/**
 * Get complete company financials (revenue, COGS, payroll, operating expenses, net income)
 */
export async function getCompanyFinancials(params: {
  location: Location;
  startDate: string;
  endDate: string;
  accounting_method?: 'Cash' | 'Accrual';
}): Promise<{
  location: string;
  period: string;
  revenue: number;
  product_revenue: number;
  shipping_revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_percent: number;
  payroll_total: number;
  operating_expenses_total: number;
  net_income: number;
  net_margin_percent: number;
  accounting_method: 'Cash' | 'Accrual';
  cached: boolean;
}> {
  const report = await getProfitAndLoss(params);

  const revenue = extractAccountFromReport(report, '4000', 'Revenue');
  const productRevenue = revenue; // QB combines all revenue
  const shippingRevenue = 0;
  const cogs = extractCOGSFromReport(report);
  const grossProfit = revenue - cogs;
  const grossMarginPercent = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  const payrollTotal = extractPayrollFromReport(report);
  const operatingExpensesTotal = extractOperatingExpensesFromReport(report);
  const netIncome = extractNetIncomeFromReport(report);
  const netMarginPercent = revenue > 0 ? (netIncome / revenue) * 100 : 0;

  return {
    location: params.location,
    period: `${params.startDate} to ${params.endDate}`,
    revenue,
    product_revenue: productRevenue,
    shipping_revenue: shippingRevenue,
    cogs,
    gross_profit: grossProfit,
    gross_margin_percent: grossMarginPercent,
    payroll_total: payrollTotal,
    operating_expenses_total: operatingExpensesTotal,
    net_income: netIncome,
    net_margin_percent: netMarginPercent,
    accounting_method: params.accounting_method || 'Cash',
    cached: false,
  };
}

// ── Balance Sheet: inventory-asset book balance (monthly close) ──
// Minimal typed view of the QB BalanceSheet report tree we walk. The report is
// a nested Rows/Row tree: Section rows carry a Header + child Rows + a Summary;
// leaf Data rows carry ColData ([label, ..., amount]).
interface QbBsColData {
  value?: string;
  id?: string;
}
interface QbBsRow {
  Header?: { ColData?: QbBsColData[] };
  Rows?: { Row?: QbBsRow[] };
  Summary?: { ColData?: QbBsColData[] };
  ColData?: QbBsColData[];
  type?: string;
  group?: string;
}
interface QbBalanceSheetReport {
  Rows?: { Row?: QbBsRow[] };
}

/** Inventory-asset section total + its sub-account breakdown. */
export interface InventoryAssetBreakdown {
  total: number;
  accountName: string; // section header literal, e.g. '1220 Inventory Asset'
  accounts: Array<{ name: string; value: number }>;
}

function bsAmount(cols: QbBsColData[] | undefined): number {
  if (!cols || cols.length === 0) return 0;
  const raw = cols[cols.length - 1]?.value ?? '';
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Depth-first: first Section whose Header label ends with "Inventory Asset". */
function findInventorySection(rows: QbBsRow[]): QbBsRow | null {
  for (const row of rows) {
    const header = row.Header?.ColData?.[0]?.value?.trim();
    if (header && header.endsWith('Inventory Asset')) return row;
    const nested = row.Rows?.Row;
    if (nested) {
      const found = findInventorySection(nested);
      if (found) return found;
    }
  }
  return null;
}

/** Collect leaf Data rows (name + amount) under a section, recursing sub-sections. */
function collectLeafAccounts(rows: QbBsRow[]): Array<{ name: string; value: number }> {
  const out: Array<{ name: string; value: number }> = [];
  for (const row of rows) {
    const nested = row.Rows?.Row;
    if (nested && nested.length > 0) {
      out.push(...collectLeafAccounts(nested));
      continue;
    }
    const name = row.ColData?.[0]?.value?.trim();
    if (name) out.push({ name, value: bsAmount(row.ColData) });
  }
  return out;
}

/**
 * Parse the Inventory-Asset section out of a QB BalanceSheet report. Pure and
 * exported so it can be unit-tested against fixture JSON (local dev cannot make
 * live QB calls — the local client id is stale). Returns null when the section
 * is absent (e.g. a realm without inventory). Observed literals across all three
 * realms: header "1220 Inventory Asset", summary "Total 1220 Inventory Asset".
 */
export function parseInventoryAssetSection(report: QbBalanceSheetReport): InventoryAssetBreakdown | null {
  const top = report.Rows?.Row;
  if (!top) return null;
  const section = findInventorySection(top);
  if (!section) return null;

  const accountName = section.Header?.ColData?.[0]?.value?.trim() ?? 'Inventory Asset';
  const total = bsAmount(section.Summary?.ColData);
  const accounts = collectLeafAccounts(section.Rows?.Row ?? []);
  return { total, accountName, accounts };
}

/**
 * A `start_date` that predates every transaction in every realm.
 *
 * ⚠ NOT COSMETIC, AND NOT OPTIONAL. QuickBooks **silently ignores `end_date` on
 * the BalanceSheet report when `start_date` is absent** and answers with its own
 * default period instead. The request still returns 200 and a well-formed report,
 * so nothing downstream can tell it got the wrong date — which is exactly how this
 * went unnoticed: from 2026-03 through 2026-06 the close page asked for six
 * different month-ends and QuickBooks returned the *same* balances every time
 * (verified live 2026-09-03: TN `qbBookBalance` 976,579.84 and 1220.10 Compound
 * Ingredient 630,754.05 for both `month=2026-03` and `month=2026-06`, while the
 * FIFO target moved 652,419.72 → 830,532.09 as it should).
 *
 * The fix is to send a `start_date` — proven by `_sweep-L9-balance-sheet.ts`,
 * which passes one and does get distinct, correct balances per date. A balance
 * sheet is cumulative, so the start date does not affect the reported balances;
 * it only makes QuickBooks honour `end_date`. Do not remove it, and do not
 * "simplify" it away.
 */
/**
 * January 1 of the as-of year — the ONLY `start_date` shape proven to work.
 *
 * A far-past epoch does NOT work. Deployed 2026-09-03 with `start_date=2000-01-01`
 * and QuickBooks still returned its default balances (TN 1220.10 stayed at
 * 630,754.05 for `month=2026-06`, which is the 07/31 figure). QuickBooks ignores an
 * out-of-range start date exactly as it ignores a missing one, and either way
 * answers 200 with a well-formed report — there is no error to catch.
 *
 * `<year>-01-01` mirrors `_sweep-L9-balance-sheet.ts`, which passes 2026-01-01 and
 * demonstrably gets distinct, correct balances per end_date (06/30 vs 07/31), and
 * whose totals tie to QuickBooks' own BalanceSheet report to $0.00. A balance sheet
 * is cumulative, so this does not turn the figures into year-to-date movement — it
 * only makes QuickBooks honour `end_date`.
 */
export function balanceSheetStartDate(asOfDate: string): string {
  return `${asOfDate.slice(0, 4)}-01-01`;
}

/**
 * The BalanceSheet report endpoint for an as-of date. Extracted and exported ONLY
 * so the `start_date` above is covered by a test that fails loudly if anyone drops
 * it — the live symptom is silent and looks like correct data.
 */
export function buildBalanceSheetEndpoint(asOfDate: string): string {
  return (
    `reports/BalanceSheet?start_date=${balanceSheetStartDate(asOfDate)}` +
    `&end_date=${encodeURIComponent(asOfDate)}` +
    '&accounting_method=Accrual&minorversion=75'
  );
}

/**
 * Read a location's inventory-asset book balance from QuickBooks as of a
 * month-end date (point-in-time BalanceSheet, Accrual). Returns null — never
 * throws — when the realm is disconnected or the section is missing, so callers
 * degrade to "book balance unavailable — reconnect QuickBooks".
 *
 * @param asOfDate month-end 'YYYY-MM-DD'.
 */
export async function getBalanceSheetInventory(
  location: Location,
  asOfDate: string,
): Promise<InventoryAssetBreakdown | null> {
  // Quiet path for a disconnected realm (avoids qbRequest throwing + logging).
  const tokens = await getValidTokens(location);
  if (!tokens) return null;

  try {
    const endpoint = buildBalanceSheetEndpoint(asOfDate);
    const report = await qbRequest<QbBalanceSheetReport>(endpoint, location, { method: 'GET' });
    return parseInventoryAssetSection(report);
  } catch (error) {
    console.error(`Error fetching QB balance-sheet inventory for ${location}:`, error);
    return null;
  }
}

/**
 * Check if a specific location is connected
 */
export async function isConnected(location: Location): Promise<boolean> {
  const tokens = await getValidTokens(location);
  return tokens !== null;
}

/**
 * Check connection status for all locations
 */
export async function getConnectionStatus(): Promise<Record<Location, boolean>> {
  const locations = Object.keys(LOCATION_MAPPING) as Location[];
  const status: Record<string, boolean> = {};

  await Promise.all(
    locations.map(async (location) => {
      status[location] = await isConnected(location);
    })
  );

  return status as Record<Location, boolean>;
}

/**
 * Disconnect QuickBooks for a specific location
 */
export async function disconnect(location: Location): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('accounting_quickbooks_tokens')
    .delete()
    .eq('location', location);
}
