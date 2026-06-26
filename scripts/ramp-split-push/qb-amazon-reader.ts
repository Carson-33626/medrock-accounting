import type { Entity, QBEntry, QBLine } from './types';
import { ENTITY_TO_QB_LOCATION, ALL_ENTITIES } from './types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Location } from '../../src/lib/quickbooks-multi';

// Minimal shapes of the QB Vendor/Purchase/Bill objects we read (read-only).
interface QBRef { value: string; name?: string }
interface QBAccountLineDetail { AccountRef?: QBRef; ClassRef?: QBRef }
interface QBLineRaw {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: QBAccountLineDetail;
}
interface QBPurchaseRaw {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  EntityRef?: QBRef;       // payee on Purchase (NOT queryable — filtered client-side)
  VendorRef?: QBRef;       // vendor on Bill (queryable)
  DepartmentRef?: QBRef;   // Location
  Line?: QBLineRaw[];
}
interface QBVendorRaw { Id: string; DisplayName?: string }

function toLines(raw: QBLineRaw[] | undefined, locationId: string | null): QBLine[] {
  const lines: QBLine[] = [];
  for (const l of raw ?? []) {
    const detail = l.AccountBasedExpenseLineDetail;
    if (!detail?.AccountRef?.value) continue; // skip non-account lines (subtotals etc.)
    lines.push({
      description: l.Description ?? null,
      amountCents: Math.round((l.Amount ?? 0) * 100),
      glAccountId: detail.AccountRef.value,
      glAccountName: detail.AccountRef.name ?? null,
      classId: detail.ClassRef?.value ?? null,
      locationId,
    });
  }
  return lines;
}

function toEntry(entity: Entity, docType: 'Purchase' | 'Bill', r: QBPurchaseRaw): QBEntry {
  const locationId = r.DepartmentRef?.value ?? null;
  const vendor = r.VendorRef?.name ?? r.EntityRef?.name ?? null;
  return {
    realm: entity,
    qbEntryId: r.Id,
    docType,
    orderNo: r.DocNumber ?? null,
    txnDate: (r.TxnDate ?? '').slice(0, 10),
    totalCents: Math.round((r.TotalAmt ?? 0) * 100),
    vendor,
    lines: toLines(r.Line, locationId),
  };
}

// The "Amazon" vendor family (e.g. "Amazon", "Amazon Business") — ids differ per realm,
// so resolve them live from each company's Vendor list rather than hardcoding.
async function amazonVendorIds(location: Location): Promise<Set<string>> {
  const vendors = await qbQueryAll<QBVendorRaw>(location, 'Vendor', "WHERE DisplayName LIKE '%Amazon%'");
  return new Set(vendors.map((v) => v.Id));
}

export async function readQbAmazonEntries(entity: Entity): Promise<QBEntry[]> {
  const location = ENTITY_TO_QB_LOCATION[entity];
  const amazonIds = await amazonVendorIds(location);
  if (amazonIds.size === 0) return [];

  // Bill: VendorRef IS queryable — union per Amazon vendor id (cheap, targeted).
  const billArrays = await Promise.all(
    [...amazonIds].map((id) => qbQueryAll<QBPurchaseRaw>(location, 'Bill', `WHERE VendorRef = '${id}'`)),
  );
  const bills = billArrays.flat().map((r) => toEntry(entity, 'Bill', r));

  // Purchase: EntityRef is NOT queryable in QBO — pull all and filter client-side.
  const allPurchases = await qbQueryAll<QBPurchaseRaw>(location, 'Purchase', '');
  const purchases = allPurchases
    .filter((r) => r.EntityRef !== undefined && amazonIds.has(r.EntityRef.value))
    .map((r) => toEntry(entity, 'Purchase', r));

  return [...purchases, ...bills];
}

export async function readAllQbAmazonEntries(): Promise<QBEntry[]> {
  // Sequential per realm: concurrent QB token refresh across realms races and yields
  // transient "No QB tokens found" errors. Read-only preview tolerates the slower path.
  const all: QBEntry[] = [];
  for (const entity of ALL_ENTITIES) {
    const entries = await readQbAmazonEntries(entity);
    all.push(...entries);
  }
  return all;
}
