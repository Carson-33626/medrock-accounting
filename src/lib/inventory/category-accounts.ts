/**
 * RDS inventory category -> QuickBooks account pair.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *
 * This is the table an accountant will want to read and amend when the chart of
 * accounts changes. It is deliberately not buried in the close math.
 *
 * NAMING — READ BEFORE EDITING
 *
 * Every string here MUST be the QB `Account` entity's `FullyQualifiedName`
 * ('Inventory Asset:Commercial Rx Inventory'), because `buildJePayload` resolves
 * `JournalLine.accountName` against `refs.accounts`, which is keyed by exactly
 * that, and THROWS `unresolved account` on a miss. The BalanceSheet report calls
 * the same accounts '1220.05 Commercial Rx Inventory' — that form resolves to
 * nothing. Use `matchBalanceSheetAccount` to cross between the two.
 *
 * Verified live in FL, TN and TX on 2026-08-24: every pair below resolves to a
 * real account id in all three realms.
 */

/**
 * QB account names as the Account entity reports them (FullyQualifiedName) —
 * the ONLY form `buildJePayload` can resolve (`refs.accounts` is keyed by it).
 * The BalanceSheet report calls this same account '1220 Inventory Asset'; that
 * string resolves to nothing and made every close JE throw `unresolved account`
 * at post AND dry-run time. Never put a balance-sheet-style name here.
 */
export const INVENTORY_ACCOUNT = 'Inventory Asset';
export const COGS_ACCOUNT = 'Cost of Goods Sold';

/**
 * The dedicated line waste/shrink write-downs post to — NEVER commingled with
 * usage-driven COGS (close-package-method-note.md sec 2.4). Created in FL/TN/TX
 * 2026-08-26 (Ids 312/392/286) by scripts/create-qb-waste-accounts.ts; FOCAS has
 * no inventory operations and deliberately lacks it. Distinct from
 * '5000.43 Product Losses' (shipping) and TN's dead '6999.33 (DO NOT USE)'.
 */
export const WASTE_ACCOUNT = 'Cost of Goods Sold:Drug Waste & Shrinkage';

/**
 * The one-time offset for the 2026-03-01 opening correction (cutover to FIFO —
 * see docs/fifo-monthly-close/2026-08-26-correction-je-proposal.md §4). The
 * recommended `5000.60` account: used once, then never again. If Kristi picks a
 * different treatment, change it HERE — generation refuses to draft for a
 * company whose chart lacks this account, so a rename cannot post blind.
 */
export const CORRECTION_ACCOUNT = 'Cost of Goods Sold:Inventory Valuation Correction';

export interface CategoryAccounts {
  /** Inventory-asset account (FullyQualifiedName) this category adjusts. */
  inventory: string;
  /** COGS account (FullyQualifiedName) that takes the offset. */
  cogs: string;
  /** false when the category has no dedicated pair and fell back to the parents. */
  mapped: boolean;
}

export const CATEGORY_ACCOUNT_MAP: Readonly<Record<string, { inventory: string; cogs: string }>> = {
  'Commercial Rx': {
    inventory: 'Inventory Asset:Commercial Rx Inventory',
    cogs: 'Cost of Goods Sold:Commercial RX',
  },
  'Compound Ingredient': {
    inventory: 'Inventory Asset:Compound Ingredient Inventory',
    cogs: 'Cost of Goods Sold:Compound Ingredient',
  },
  'Lab Compound Packaging Inventory': {
    inventory: 'Inventory Asset:Compound Packaging Inventory',
    cogs: 'Cost of Goods Sold:Compound Packaging',
  },
  'Lab Supplies': {
    inventory: 'Inventory Asset:Lab Supplies Inventory',
    cogs: 'Cost of Goods Sold:Lab Supplies',
  },
};

/**
 * The account pair for one RDS category. 'Uncoded' and 'Opening Balance' have no
 * QB counterpart (they are our own buckets, not chart-of-accounts categories), and
 * an unrecognized category must never throw mid-close — both land on the parent
 * accounts with `mapped: false` so the caller can surface a warning and label the
 * line as a residual.
 */
export function accountsForCategory(qbCategory: string): CategoryAccounts {
  const pair = CATEGORY_ACCOUNT_MAP[qbCategory];
  if (!pair) return { inventory: INVENTORY_ACCOUNT, cogs: COGS_ACCOUNT, mapped: false };
  return { inventory: pair.inventory, cogs: pair.cogs, mapped: true };
}

/**
 * The point-in-time balance of one account, bridging QB's two naming conventions.
 *
 * `fetchDimensions` gives FullyQualifiedName -> AcctNum ('1220.05'); the
 * BalanceSheet leaf name is exactly `${AcctNum} ${leaf label}`. So an AcctNum
 * prefix match is deterministic. The trailing space matters: without it '1220.1'
 * would also match the '1220.10 …' row.
 *
 * Returns null when the account carries no AcctNum, or the balance sheet has no
 * row for it (e.g. a sub-account that has never been funded).
 */
export function matchBalanceSheetAccount(
  fullyQualifiedName: string,
  accountNums: Record<string, string>,
  bsAccounts: ReadonlyArray<{ name: string; value: number }>,
): number | null {
  const acctNum = accountNums[fullyQualifiedName];
  if (!acctNum) return null;
  const prefix = `${acctNum} `;
  const row = bsAccounts.find((a) => a.name.startsWith(prefix));
  return row ? row.value : null;
}
