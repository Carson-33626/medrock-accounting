/**
 * QuickBooks Online API Integration
 *
 * Handles OAuth 2.0 authentication and API calls to QuickBooks Online.
 * Tokens are stored in Supabase for persistence across requests.
 */

import { getAdminClient } from './supabase-admin';

const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID!;
const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET!;
const QB_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI!;
const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'

// QuickBooks API base URLs
const QB_AUTH_URL =
  QB_ENVIRONMENT === 'production'
    ? 'https://appcenter.intuit.com/connect/oauth2'
    : 'https://appcenter.intuit.com/connect/oauth2';

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const QB_API_BASE =
  QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com/v3'
    : 'https://sandbox-quickbooks.api.intuit.com/v3';

interface QuickBooksTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp
  realm_id: string; // Company ID
}

/**
 * Get OAuth authorization URL to initiate QB connection
 */
export function getAuthorizationUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    state: state || '',
  });

  return `${QB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<QuickBooksTokens> {
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
    realm_id: data.realmId || '', // QB returns realmId in response
  };
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(refreshToken: string): Promise<QuickBooksTokens> {
  const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(QB_TOKEN_URL, {
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
  };
}

/**
 * Store QB tokens in Supabase
 */
export async function storeTokens(tokens: QuickBooksTokens): Promise<void> {
  const supabase = getAdminClient();

  const { error } = await supabase
    .from('accounting_analytics_quickbooks_tokens')
    .upsert(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(tokens.expires_at).toISOString(),
        realm_id: tokens.realm_id,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'id', // Assuming single row with id=1
      }
    );

  if (error) {
    throw new Error(`Failed to store tokens: ${error.message}`);
  }
}

/**
 * Get valid QB tokens (refreshes if expired)
 */
export async function getValidTokens(): Promise<QuickBooksTokens | null> {
  const supabase = getAdminClient();

  const { data: tokenRow, error } = await supabase
    .from('accounting_analytics_quickbooks_tokens')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !tokenRow) {
    console.log('No QB tokens found in database');
    return null;
  }

  const tokens: QuickBooksTokens = {
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_at: new Date(tokenRow.expires_at).getTime(),
    realm_id: tokenRow.realm_id,
  };

  // Check if token is expired (with 5 min buffer)
  const now = Date.now();
  if (tokens.expires_at < now + 5 * 60 * 1000) {
    console.log('Token expired or expiring soon, refreshing...');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    refreshed.realm_id = tokens.realm_id; // Preserve realm_id

    await storeTokens(refreshed);
    return refreshed;
  }

  return tokens;
}

/**
 * Make authenticated API call to QuickBooks
 */
async function qbRequest<T>(
  endpoint: string,
  realmId: string,
  options: RequestInit = {}
): Promise<T> {
  const tokens = await getValidTokens();

  if (!tokens) {
    throw new Error('QuickBooks not connected. Please authorize first.');
  }

  const url = `${QB_API_BASE}/company/${realmId}/${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`QB API error: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Get Profit & Loss report from QuickBooks
 */
export async function getProfitAndLoss(params: {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  accounting_method?: 'Accrual' | 'Cash';
}) {
  const tokens = await getValidTokens();
  if (!tokens) throw new Error('QuickBooks not connected');

  const queryParams = new URLSearchParams({
    start_date: params.startDate,
    end_date: params.endDate,
    accounting_method: params.accounting_method || 'Accrual',
  });

  const endpoint = `reports/ProfitAndLoss?${queryParams.toString()}`;
  return qbRequest(endpoint, tokens.realm_id, { method: 'GET' });
}

/**
 * Get revenue summary by period
 * This queries the ProfitAndLoss report and extracts revenue data
 */
export async function getRevenueSummary(params: {
  startDate: string;
  endDate: string;
}): Promise<{
  period: string;
  revenue: number;
  cost_of_goods: number;
  gross_profit: number;
}> {
  const report = await getProfitAndLoss(params);

  // Parse QB report structure
  // The P&L report returns nested rows with Income, COGS, etc.
  // This is a simplified extraction - adjust based on actual QB response
  const revenue = extractRevenueFromReport(report);
  const cogs = extractCOGSFromReport(report);

  return {
    period: `${params.startDate} to ${params.endDate}`,
    revenue,
    cost_of_goods: cogs,
    gross_profit: revenue - cogs,
  };
}

/**
 * Get revenue data grouped by period (monthly/quarterly/yearly)
 */
export async function getRevenueByPeriod(params: {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  granularity: 'monthly' | 'quarterly' | 'yearly';
}): Promise<
  Array<{
    period: string;
    revenue: number;
    cost_of_goods: number;
    gross_profit: number;
  }>
> {
  const { startDate, endDate, granularity } = params;

  // Split date range into periods based on granularity
  const periods = generatePeriods(startDate, endDate, granularity);

  // Fetch P&L for each period
  const results = await Promise.all(
    periods.map(async ({ start, end, label }) => {
      const summary = await getRevenueSummary({ startDate: start, endDate: end });
      return {
        period: label,
        revenue: summary.revenue,
        cost_of_goods: summary.cost_of_goods,
        gross_profit: summary.gross_profit,
      };
    })
  );

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
    let periodEnd: Date;
    let label: string;

    if (granularity === 'yearly') {
      // Full year
      const year = current.getFullYear();
      periodEnd = new Date(year, 11, 31); // Dec 31
      label = `${year}`;
      current = new Date(year + 1, 0, 1); // Next year Jan 1
    } else if (granularity === 'quarterly') {
      // Quarter
      const year = current.getFullYear();
      const quarter = Math.floor(current.getMonth() / 3);
      const quarterMonth = quarter * 3;
      periodEnd = new Date(year, quarterMonth + 3, 0); // Last day of quarter
      label = `${year}-Q${quarter + 1}`;
      current = new Date(year, quarterMonth + 3, 1); // First day of next quarter
    } else {
      // Monthly
      const year = current.getFullYear();
      const month = current.getMonth();
      periodEnd = new Date(year, month + 1, 0); // Last day of month
      label = `${year}-${(month + 1).toString().padStart(2, '0')}`;
      current = new Date(year, month + 1, 1); // First day of next month
    }

    // Don't go past endDate
    if (periodEnd > end) {
      periodEnd = end;
    }

    periods.push({
      start: formatDate(current < start ? start : current),
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
 * Helper: Extract total revenue from P&L report
 * This needs to be customized based on your QB chart of accounts structure
 */
function extractRevenueFromReport(report: any): number {
  // QuickBooks P&L report structure:
  // report.Rows.Row[] - array of section rows
  // Each Row has a "group" attribute and may contain ColData for values
  // Revenue is typically in the first section labeled "Income" or "Revenue"

  try {
    const rows = report?.Rows?.Row || [];

    // Find the Income/Revenue section
    const incomeSection = rows.find(
      (row: any) =>
        row.group === 'Income' ||
        row.Header?.ColData?.[0]?.value?.includes('Income') ||
        row.Header?.ColData?.[0]?.value?.includes('Revenue')
    );

    if (!incomeSection) return 0;

    // Get total from Summary row (last column is typically the total)
    const summaryRow = incomeSection.Summary;
    if (summaryRow?.ColData) {
      // Last ColData is usually the total
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
 * Check if QuickBooks is connected
 */
export async function isConnected(): Promise<boolean> {
  const tokens = await getValidTokens();
  return tokens !== null;
}

/**
 * Disconnect QuickBooks (remove tokens)
 */
export async function disconnect(): Promise<void> {
  const supabase = getAdminClient();
  await supabase.from('accounting_analytics_quickbooks_tokens').delete().eq('id', 1);
}
