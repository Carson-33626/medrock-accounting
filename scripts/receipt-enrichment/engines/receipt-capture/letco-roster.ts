// web/scripts/receipt-enrichment/engines/receipt-capture/letco-roster.ts
// Roster shaping and paging control for the Fagron Shop invoice list.
//
// The Knockout grid POSTs to the PAGE URL ITSELF with {page, OrderId, DocumentId, OrderType,
// StartDate, EndDate} and receives {Items, TotalCount}, 10 rows per page, `page` 0-based
// (verified live 2026-08-04 — see the design spec). StartDate filters server-side, so
// PERIOD_FLOOR bounds the fetch rather than being applied afterwards.
import { parseMoneyCents, parsePortalDate } from './letco-values';

export interface RawRosterItem {
  DocumentId?: string;
  OrderId?: string;
  DocumentDate?: string;
  DueDate?: string;
  TotalAmount?: string;
  Url?: string;
}

export interface RosterItem {
  documentId: string;
  orderId: string;
  documentDate: string;
  dueDate: string | null;
  totalCents: number;
  detailUrl: string;
}

export function normalizeRosterItem(raw: RawRosterItem): RosterItem | null {
  const documentId = (raw.DocumentId ?? '').trim();
  const orderId = (raw.OrderId ?? '').trim();
  if (documentId === '' || orderId === '') return null;

  const documentDate = parsePortalDate(raw.DocumentDate ?? '');
  if (documentDate === null) return null;

  const totalCents = parseMoneyCents(raw.TotalAmount ?? '');
  if (totalCents === null) return null;

  return {
    documentId,
    orderId,
    documentDate,
    dueDate: parsePortalDate(raw.DueDate ?? ''),
    totalCents,
    detailUrl: (raw.Url ?? '').trim(),
  };
}

/**
 * An empty page always stops the loop: TotalCount has been observed to describe the filtered set,
 * and trusting it alone would spin forever if the server ever disagreed with itself.
 */
export function shouldFetchNextPage(
  collected: number,
  totalCount: number,
  lastPageSize: number,
  pagesFetched: number,
  maxPages: number,
): boolean {
  if (pagesFetched >= maxPages) return false;
  if (lastPageSize === 0) return false;
  return collected < totalCount;
}
