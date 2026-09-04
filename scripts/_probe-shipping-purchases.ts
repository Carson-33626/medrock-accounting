/**
 * READ-ONLY: what was actually BOUGHT for shipping packaging, and what relieves it.
 *
 * Carson's ruling for 1220.30, 2026-09-04: *"include the cold chain, for these it's
 * hard to say since not every package gets it, so you'll have to treat it the same
 * way we did lab supplies, check the buy orders and draft the differences."*
 *
 * So the question is not "how many mailers per shipment" — it is what the buy
 * orders say. This proves:
 *   1. every Bill/Purchase line coded to 1220.30 (and the shipping COGS accounts)
 *      per entity per month, with vendor, description, qty and QuickBooks entry
 *      time — the "check the buy orders" half;
 *   2. every JournalEntry line touching 1220.30 — the relief half, i.e. whether
 *      anything ever comes back OFF the asset;
 *   3. distinct shipments per entity per month from `source.lifefile_fulfillment`
 *      (`LG Number` is the package grain), for the order-of-magnitude sanity check.
 *
 * Item-based lines are resolved too, not just account-based: an inventory asset
 * account is reachable through an Item's AssetAccountRef, and reading only
 * `AccountBasedExpenseLineDetail` (what the lab-supplies read does) would silently
 * lose them.
 *
 * Writes two CSVs under docs/fifo-monthly-close/. Touches nothing else.
 *
 * Run from web/:  npx tsx scripts/_probe-shipping-purchases.ts
 */
import './lib/load-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRdsPool } from '../src/lib/rds';
import { qbQueryAll, type Location } from '../src/lib/quickbooks-multi';

const LOCATIONS: readonly Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

/** Asset account under study, plus every COGS account that could be its offset. */
const ASSET_ACCT = '1220.30';
const COGS_ACCTS: readonly string[] = ['5000.20', '5000.40', '5000.45'];

const SINCE = '2023-01-01';
const DOCS_DIR = resolve(process.cwd(), '..', 'docs', 'fifo-monthly-close');

interface AccountRow {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
}

interface ItemRow {
  Id: string;
  Name?: string;
  AssetAccountRef?: { value?: string };
  ExpenseAccountRef?: { value?: string };
  IncomeAccountRef?: { value?: string };
}

interface DocLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string }; ClassRef?: { value?: string } };
  ItemBasedExpenseLineDetail?: { ItemRef?: { value?: string }; Qty?: number; UnitPrice?: number };
}

interface PurchaseDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: DocLine[];
  VendorRef?: { name?: string };
  EntityRef?: { name?: string };
  MetaData?: { CreateTime?: string };
}

interface JeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string };
  };
}

interface JeDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: JeLine[];
  PrivateNote?: string;
}

/** One extracted spend line, flattened for the CSV. */
interface SpendLine {
  location: Location;
  docType: 'Bill' | 'Purchase';
  docId: string;
  docNumber: string;
  txnDate: string;
  month: string;
  createTime: string;
  entryLagDays: number | '';
  vendor: string;
  acctNum: string;
  acctName: string;
  lineKind: 'account' | 'item';
  itemName: string;
  qty: number | '';
  unitPrice: number | '';
  amount: number;
  description: string;
}

interface ReliefLine {
  location: Location;
  docId: string;
  docNumber: string;
  txnDate: string;
  month: string;
  postingType: string;
  amount: number;
  description: string;
  privateNote: string;
}

interface ShipmentRow {
  location: string;
  month: string;
  shipments: number;
  fills: number;
  blank_lg_fills: number;
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

function daysBetween(fromIso: string, toIso: string): number | '' {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return '';
  return Math.round((to - from) / 86_400_000);
}

/** Pull one realm's shipping-account spend lines and 1220.30 journal relief. */
async function pullLocation(
  location: Location,
): Promise<{ spend: SpendLine[]; relief: ReliefLine[]; accountNames: Map<string, string> }> {
  const accounts = await qbQueryAll<AccountRow>(location, 'Account', '');
  const wanted = new Map<string, { num: string; name: string }>();
  for (const a of accounts) {
    const num = a.AcctNum ?? '';
    if (num === ASSET_ACCT || COGS_ACCTS.includes(num)) {
      wanted.set(a.Id, { num, name: a.FullyQualifiedName ?? a.Name ?? '' });
    }
  }
  const assetIds = new Set(
    [...wanted.entries()].filter(([, v]) => v.num === ASSET_ACCT).map(([id]) => id),
  );

  // Items whose asset/expense account is one of ours — item-based lines reach the
  // account indirectly and would otherwise be invisible.
  const items = await qbQueryAll<ItemRow>(location, 'Item', '');
  const itemToAccount = new Map<string, string>();
  const itemNames = new Map<string, string>();
  for (const it of items) {
    itemNames.set(it.Id, it.Name ?? '');
    const acct = it.AssetAccountRef?.value ?? it.ExpenseAccountRef?.value;
    if (acct !== undefined && wanted.has(acct)) itemToAccount.set(it.Id, acct);
  }

  const where = `WHERE TxnDate >= '${SINCE}'`;
  const [bills, purchases, jes] = await Promise.all([
    qbQueryAll<PurchaseDoc>(location, 'Bill', where),
    qbQueryAll<PurchaseDoc>(location, 'Purchase', where),
    qbQueryAll<JeDoc>(location, 'JournalEntry', where),
  ]);

  const spend: SpendLine[] = [];
  for (const [docType, docs] of [
    ['Bill', bills],
    ['Purchase', purchases],
  ] as ReadonlyArray<['Bill' | 'Purchase', PurchaseDoc[]]>) {
    for (const doc of docs) {
      const txnDate = doc.TxnDate ?? '';
      if (txnDate === '') continue;
      const createTime = (doc.MetaData?.CreateTime ?? '').slice(0, 10);
      for (const line of doc.Line ?? []) {
        const acctDirect = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
        const itemRef = line.ItemBasedExpenseLineDetail?.ItemRef?.value;
        const acctViaItem = itemRef === undefined ? undefined : itemToAccount.get(itemRef);
        const acctId = acctDirect !== undefined && wanted.has(acctDirect) ? acctDirect : acctViaItem;
        if (acctId === undefined) continue;
        const acct = wanted.get(acctId);
        if (acct === undefined) continue;
        spend.push({
          location,
          docType,
          docId: doc.Id,
          docNumber: doc.DocNumber ?? '',
          txnDate,
          month: txnDate.slice(0, 7),
          createTime,
          entryLagDays: createTime === '' ? '' : daysBetween(txnDate, createTime),
          vendor: doc.VendorRef?.name ?? doc.EntityRef?.name ?? '',
          acctNum: acct.num,
          acctName: acct.name,
          lineKind: acctDirect !== undefined && wanted.has(acctDirect) ? 'account' : 'item',
          itemName: itemRef === undefined ? '' : itemNames.get(itemRef) ?? '',
          qty: line.ItemBasedExpenseLineDetail?.Qty ?? '',
          unitPrice: line.ItemBasedExpenseLineDetail?.UnitPrice ?? '',
          amount: line.Amount ?? 0,
          description: (line.Description ?? '').replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }

  const relief: ReliefLine[] = [];
  for (const je of jes) {
    const txnDate = je.TxnDate ?? '';
    if (txnDate === '') continue;
    for (const line of je.Line ?? []) {
      const acctId = line.JournalEntryLineDetail?.AccountRef?.value;
      if (acctId === undefined || !assetIds.has(acctId)) continue;
      relief.push({
        location,
        docId: je.Id,
        docNumber: je.DocNumber ?? '',
        txnDate,
        month: txnDate.slice(0, 7),
        postingType: line.JournalEntryLineDetail?.PostingType ?? '',
        amount: line.Amount ?? 0,
        description: (line.Description ?? '').replace(/\s+/g, ' ').trim(),
        privateNote: (je.PrivateNote ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }

  const accountNames = new Map<string, string>();
  for (const [, v] of wanted) accountNames.set(v.num, v.name);
  return { spend, relief, accountNames };
}

async function pullShipments(): Promise<ShipmentRow[]> {
  const pool = getRdsPool();
  const { rows } = await pool.query<ShipmentRow>(
    `SELECT row_data->>'Location' AS location,
            to_char(NULLIF(row_data->>'Fill Date','')::timestamp, 'YYYY-MM') AS month,
            count(DISTINCT NULLIF(trim(row_data->>'LG Number'), ''))::int AS shipments,
            count(*)::int AS fills,
            count(*) FILTER (WHERE NULLIF(trim(row_data->>'LG Number'), '') IS NULL)::int
              AS blank_lg_fills
     FROM (
       SELECT DISTINCT ON (row_data->>'Fill ID') row_data
       FROM source."lifefile_fulfillment"
       ORDER BY row_data->>'Fill ID', id ASC
     ) f
     WHERE NULLIF(row_data->>'Fill Date','') IS NOT NULL
       AND to_char(NULLIF(row_data->>'Fill Date','')::timestamp, 'YYYY-MM') >= '2026-01'
       AND row_data->>'Location' IS NOT NULL
       AND row_data->>'Location' <> 'Total Commercial'
     GROUP BY 1, 2
     ORDER BY 1, 2`,
  );
  return rows;
}

function monthlyTable(spend: readonly SpendLine[], acctNum: string): Map<string, Map<string, number>> {
  const byLoc = new Map<string, Map<string, number>>();
  for (const s of spend) {
    if (s.acctNum !== acctNum) continue;
    const m = byLoc.get(s.location) ?? new Map<string, number>();
    m.set(s.month, Math.round(((m.get(s.month) ?? 0) + s.amount) * 100) / 100);
    byLoc.set(s.location, m);
  }
  return byLoc;
}

async function main(): Promise<void> {
  const allSpend: SpendLine[] = [];
  const allRelief: ReliefLine[] = [];
  const unreachable: string[] = [];

  for (const location of LOCATIONS) {
    try {
      const { spend, relief } = await pullLocation(location);
      allSpend.push(...spend);
      allRelief.push(...relief);
      console.log(`${location}: ${spend.length} spend lines, ${relief.length} JE lines on ${ASSET_ACCT}`);
    } catch (error) {
      unreachable.push(location);
      console.log(`${location}: UNREACHABLE — ${String(error)}`);
    }
  }
  console.log('');

  // --- 1. 1220.30 purchases by month -------------------------------------
  console.log(`=== ${ASSET_ACCT} Bill/Purchase spend by month ===\n`);
  const assetMonthly = monthlyTable(allSpend, ASSET_ACCT);
  const months = [...new Set(allSpend.filter((s) => s.acctNum === ASSET_ACCT).map((s) => s.month))].sort();
  console.log(`${'month'.padEnd(9)} ${'FL'.padStart(12)} ${'TN'.padStart(12)} ${'TX'.padStart(12)}`);
  for (const month of months) {
    const cells = LOCATIONS.map((l) => (assetMonthly.get(l)?.get(month) ?? 0).toFixed(2));
    console.log(`${month.padEnd(9)} ${cells[0].padStart(12)} ${cells[1].padStart(12)} ${cells[2].padStart(12)}`);
  }
  console.log('');

  // --- 2. vendors --------------------------------------------------------
  console.log(`=== ${ASSET_ACCT} vendors (2026 only) ===\n`);
  for (const location of LOCATIONS) {
    const byVendor = new Map<string, { docs: Set<string>; total: number; first: string; last: string }>();
    for (const s of allSpend) {
      if (s.location !== location || s.acctNum !== ASSET_ACCT || s.month < '2026-01') continue;
      const key = s.vendor === '' ? '(no vendor)' : s.vendor;
      const v = byVendor.get(key) ?? { docs: new Set<string>(), total: 0, first: s.txnDate, last: s.txnDate };
      v.docs.add(s.docId);
      v.total = Math.round((v.total + s.amount) * 100) / 100;
      if (s.txnDate < v.first) v.first = s.txnDate;
      if (s.txnDate > v.last) v.last = s.txnDate;
      byVendor.set(key, v);
    }
    const sorted = [...byVendor.entries()].sort((a, b) => b[1].total - a[1].total);
    const total = sorted.reduce((acc, [, v]) => acc + v.total, 0);
    console.log(`${location} — 2026 total $${total.toFixed(2)} across ${sorted.length} vendors:`);
    for (const [vendor, v] of sorted) {
      console.log(
        `   ${vendor.padEnd(34)} ${String(v.docs.size).padStart(4)} docs  ` +
          `$${v.total.toFixed(2).padStart(11)}   ${v.first} .. ${v.last}`,
      );
    }
    console.log('');
  }

  // --- 3. what the lines say they are ------------------------------------
  console.log(`=== ${ASSET_ACCT} 2026 line descriptions, largest first (top 40 per entity) ===\n`);
  for (const location of LOCATIONS) {
    const lines = allSpend
      .filter((s) => s.location === location && s.acctNum === ASSET_ACCT && s.month >= '2026-01')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 40);
    console.log(`${location}:`);
    for (const l of lines) {
      const qty = l.qty === '' ? '' : ` qty=${l.qty}`;
      const unit = l.unitPrice === '' ? '' : ` @${l.unitPrice}`;
      console.log(
        `   ${l.txnDate} ${l.vendor.slice(0, 22).padEnd(23)} $${l.amount.toFixed(2).padStart(10)}` +
          `${qty}${unit}  ${(l.itemName === '' ? l.description : `${l.itemName} | ${l.description}`).slice(0, 88)}`,
      );
    }
    console.log('');
  }

  // --- 4. COGS accounts, to find the real offset -------------------------
  console.log('=== shipping COGS accounts — do they carry anything? (2026) ===\n');
  for (const num of COGS_ACCTS) {
    for (const location of LOCATIONS) {
      const lines = allSpend.filter(
        (s) => s.location === location && s.acctNum === num && s.month >= '2026-01',
      );
      const total = lines.reduce((a, s) => a + s.amount, 0);
      console.log(
        `   ${num}  ${location.padEnd(12)} ${String(lines.length).padStart(5)} lines  $${total.toFixed(2)}`,
      );
    }
  }
  console.log('');

  // --- 5. relief: JEs against 1220.30 ------------------------------------
  console.log(`=== JournalEntry lines against ${ASSET_ACCT} (all time from ${SINCE}) ===\n`);
  if (allRelief.length === 0) {
    console.log('   NONE — nothing has ever been journalled off this asset.\n');
  } else {
    for (const r of allRelief.sort((a, b) => a.txnDate.localeCompare(b.txnDate))) {
      console.log(
        `   ${r.location.padEnd(12)} ${r.txnDate} ${r.postingType.padEnd(7)} ` +
          `$${r.amount.toFixed(2).padStart(12)}  #${r.docNumber.padEnd(14)} ${r.description.slice(0, 60)}`,
      );
    }
    console.log('');
  }

  // --- 6. entry lag, the completeness input ------------------------------
  console.log(`=== ${ASSET_ACCT} entry lag (TxnDate -> CreateTime), by txn month, 2026 ===\n`);
  console.log(`${'month'.padEnd(9)} ${'loc'.padEnd(12)} ${'docs'.padStart(5)} ${'median lag'.padStart(11)}`);
  for (const location of LOCATIONS) {
    const byMonth = new Map<string, number[]>();
    const seen = new Set<string>();
    for (const s of allSpend) {
      if (s.location !== location || s.acctNum !== ASSET_ACCT || s.month < '2026-01') continue;
      if (s.entryLagDays === '') continue;
      const key = `${s.month}|${s.docId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = byMonth.get(s.month) ?? [];
      arr.push(s.entryLagDays);
      byMonth.set(s.month, arr);
    }
    for (const month of [...byMonth.keys()].sort()) {
      const lags = (byMonth.get(month) ?? []).sort((a, b) => a - b);
      const median = lags[Math.floor(lags.length / 2)];
      console.log(
        `${month.padEnd(9)} ${location.padEnd(12)} ${String(lags.length).padStart(5)} ${String(median).padStart(9)}d`,
      );
    }
  }
  console.log('');

  // --- 7. shipments ------------------------------------------------------
  let shipments: ShipmentRow[] = [];
  try {
    shipments = await pullShipments();
    console.log('=== distinct shipments (LG Number) per location per month, 2026 ===\n');
    console.log(
      `${'month'.padEnd(9)} ${'location'.padEnd(14)} ${'shipments'.padStart(10)} ${'fills'.padStart(8)} ${'blank LG'.padStart(9)}`,
    );
    for (const r of shipments) {
      console.log(
        `${r.month.padEnd(9)} ${r.location.padEnd(14)} ${String(r.shipments).padStart(10)} ` +
          `${String(r.fills).padStart(8)} ${String(r.blank_lg_fills).padStart(9)}`,
      );
    }
    console.log('');
  } catch (error) {
    console.log(`RDS shipment pull failed: ${String(error)}\n`);
  }

  // --- CSVs --------------------------------------------------------------
  const spendCsv = toCsv(
    [
      'location', 'doc_type', 'doc_id', 'doc_number', 'txn_date', 'month', 'create_time',
      'entry_lag_days', 'vendor', 'acct_num', 'acct_name', 'line_kind', 'item_name',
      'qty', 'unit_price', 'amount', 'description',
    ],
    allSpend.map((s) => [
      s.location, s.docType, s.docId, s.docNumber, s.txnDate, s.month, s.createTime,
      s.entryLagDays, s.vendor, s.acctNum, s.acctName, s.lineKind, s.itemName,
      s.qty, s.unitPrice, s.amount, s.description,
    ]),
  );
  writeFileSync(resolve(DOCS_DIR, 'shipping-packaging-bill-lines-2026-09-04.csv'), spendCsv, 'utf8');

  const shipCsv = toCsv(
    ['location', 'month', 'shipments', 'fills', 'blank_lg_fills'],
    shipments.map((r) => [r.location, r.month, r.shipments, r.fills, r.blank_lg_fills]),
  );
  writeFileSync(resolve(DOCS_DIR, 'shipping-packaging-shipments-2026-09-04.csv'), shipCsv, 'utf8');

  console.log(`Wrote ${allSpend.length} spend lines and ${shipments.length} shipment rows to ${DOCS_DIR}`);
  if (unreachable.length > 0) console.log(`UNREACHABLE realms: ${unreachable.join(', ')}`);

  await getRdsPool().end().catch(() => undefined);
}

void main();
