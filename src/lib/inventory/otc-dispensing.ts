/**
 * OTC items (QuickBooks 1220.25 / 5000.35) — the cost of goods MedRock dispenses
 * over the counter, separated out of the two accounts it is buried in today.
 *
 * Carson, 2026-09-04: *"OTC should be fully tracked in dispensing history since we
 * fill them and they get an RX entry so you should be able to get direct lines for
 * those."* He is right, and LifeFile is more helpful than we assumed.
 *
 * THE PREDICATE
 *
 * `source.lf_dispensing_history` stamps every fill with a `Schedule`:
 *
 *   L  legend (prescription-only)   308,958 fills
 *   O  OVER THE COUNTER               5,112 fills   <- this is the whole answer
 *   2/3/5  DEA controlled                68 fills
 *
 * Measured 2026-09-04 over the table's full span (2026-01-02 → 2026-09-04, all
 * three entities, 314,140 fills). Every single `Schedule='O'` row also carries
 * `Compounded='No'`, so an OTC line is never a compound — the two fields agree
 * without being told to.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS
 *
 * `ds-qb-inventory-account-coverage.md` §3 got stuck on a real problem: the same
 * jar of CeraVe is retail stock when it is handed over whole and a compounding
 * base when it is stirred into a cream, so no SKU-level recode can be right. Its
 * proposed workaround was a regex over the compound's name looking for ` in `
 * and `*BRAND*` markers, which it measured leaking on
 * `CLOBETASOL ITCH MIX *AQUAPHOR*`.
 *
 * None of that is needed. `Schedule` is on the FILL. CeraVe Moisturizing Lotion
 * (product 300987895) dispensed whole is 816 `Schedule='O'` fills; the same
 * product drawn into `ROSACEA *AZE15/IVE1/MET1* in CeraVe` is a different product
 * id, `Schedule='L'`, `Compounded='Yes'`. LifeFile has always kept them apart.
 *
 * WHAT THIS CONTRIBUTOR POSTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It posts a COGS RECLASS and nothing else:
 *
 *   Dr Cost of Goods Sold:OTC Items                  (5000.35)
 *   Cr Cost of Goods Sold:Commercial RX              (5000.05)
 *   Cr Cost of Goods Sold:Compound Ingredient        (5000.10)
 *
 * It does NOT credit `1220.25 OTC Items Inventory`, and that omission is the
 * considered decision, not an oversight. 1220.25 does not hold this stock. Every
 * document ever coded to it in all three realms is combs (Alibaba / Shenzhen
 * Speed Crown / two wires) plus $164.52 of miscoded silicone scar sheets in
 * Florida — read the account out with `_probe-otc-qb-1220-25.ts`. The CeraVe,
 * Aquaphor and Urea that make up the OTC dispensing were purchased into 1220.05
 * and 1220.10, and that is where the FIFO close already relieves them.
 *
 * Crediting 1220.25 for consumption whose cost was never debited there would
 * drive it negative by that amount every month. Florida's 1220.25 is ALREADY
 * negative (−$323.47 at 2026-08-31) from a hand-run version of exactly this
 * mistake. `lab-supplies-je.ts` refused the same pairing for the same reason.
 *
 * So this entry moves no balance-sheet value and changes no total. It takes cost
 * the close has already recognised and puts it on the account whose name matches
 * what was sold — which is the entire ask, and is safe to post on its own.
 *
 * Relieving 1220.25's comb balance is a SEPARATE, currently BLOCKED piece of
 * work: LifeFile receives combs at a placeholder $0.0002/unit while QuickBooks
 * paid real money for them, and no document states a comb count, so there is no
 * defensible $/comb. See §7 of the DS.
 *
 * Pure — no `pg`, no QuickBooks client. The caller supplies the measured cells.
 */
import type { JournalLine } from '@/lib/payroll/types';
import type { JeContribution } from './je-pool';
import { accountsForCategory } from './category-accounts';

/**
 * LifeFile's `Schedule` value for an over-the-counter product.
 *
 * A one-character code, and the only one that is not a prescription: 'L' is
 * legend, '2'/'3'/'5' are DEA schedules. Pinned by a test so a future "let's
 * also include Generic" cannot happen silently.
 */
export const OTC_SCHEDULE_CODE = 'O';

/**
 * QuickBooks `FullyQualifiedName`s. NOT account numbers — `buildJePayload`
 * resolves `JournalLine.accountName` against `refs.accounts`, which is keyed by
 * FullyQualifiedName and THROWS `unresolved account` on a miss. A bare '5000.35'
 * here would make the pooled entry unpostable, which is how the 2026-08-24 close
 * JEs broke (see `category-accounts.ts`).
 *
 * Both verified present in MedRock FL, TN and TX on 2026-09-04. 5000.35 has a
 * CurrentBalance of $0.00 in all three — it has never been used.
 */
export const OTC_COGS_ACCOUNT = 'Cost of Goods Sold:OTC Items';

/**
 * 1220.25's FullyQualifiedName. Exported so `CATEGORY_ACCOUNT_MAP` can gain an
 * `OTC Items` pair when (and only when) product coding grows that value — this
 * module never posts to it. See the header.
 */
export const OTC_INVENTORY_ACCOUNT = 'Inventory Asset:OTC Items Inventory';

/**
 * LifeFile product ids that carry `Schedule='O'` but are not real OTC sales.
 *
 * `305521403` is `TEST COMMERCIAL LF 01`, one fill of qty 1 in Florida — one of
 * the TEST records already on `docs/lifefile-pruning-list.md`. Listed by id
 * rather than by a `/TEST/i` name match: a name pattern would be a standing
 * invitation to swallow a real product called "Test Strips".
 */
export const EXCLUDED_OTC_PRODUCT_IDS: readonly string[] = ['305521403'];

/**
 * ⚠ `source.lf_dispensing_history` carries the location under TWO different JSONB
 * keys, and reading only the obvious one silently loses two fifths of August.
 *
 * Partway through 2026-08 the extract started writing a UTF-8 byte-order mark
 * into the CSV header, so the key became `<BOM>"Location"` — BOM, then a
 * literal double quote, then the word. Measured 2026-09-04:
 *
 *   2026-07  'Location'          40,741 rows   '<BOM>"Location"'       0
 *   2026-08  'Location'          21,724 rows   '<BOM>"Location"'  19,791
 *   2026-09  'Location'               0 rows   '<BOM>"Location"'   8,107
 *
 * Zero rows lack a location under BOTH keys, so the COALESCE is complete rather
 * than a best effort. Filtering on the plain key alone made August read 351 OTC
 * fills against a true 689 and dragged the measured OTC share of usage from
 * ~99% down to ~55% — plausible-looking, and wrong.
 *
 * `source.lf_dispensing_report` has the SAME defect and is missing the plain key
 * entirely; anything reading either table must use this expression.
 */
export const LF_BOM_LOCATION_KEY = '﻿"Location"';

/** The location expression for `source.lf_dispensing_history`. See above. */
export const LF_DISPENSING_LOCATION_SQL =
  `COALESCE(NULLIF(row_data->>'Location', ''), NULLIF(row_data->>'${LF_BOM_LOCATION_KEY}', ''))`;

/**
 * One (product, location, month) cell of OTC dispensing, with the two figures
 * needed to value it.
 *
 * `otcQty` and `totalUsageQty` are in the SAME units — LifeFile's dispensing
 * quantity. Checked 2026-09-04 on the two largest products: CeraVe Moisturizing
 * Lotion reads 70,820 OTC qty against 70,069 total 2026 usage, and the combs
 * 3,354 against 3,286, the differences being September fills that the usage
 * tables had not yet closed. Grams against grams, units against units.
 */
export interface OtcProductMonth {
  /** 'YYYY-MM' */
  month: string;
  /** `purchase_lots.location` form — 'MedRock Florida', not 'MedRock FL'. */
  location: string;
  /** LifeFile `Product ID`, = `purchase_lots.lifefile_id`. */
  productId: string;
  productName: string;
  /** The `qb_category` the ledger currently carries this product's lots under. */
  sourceCategory: string;
  /** Quantity dispensed as OTC in the cell (`Schedule='O'`). */
  otcQty: number;
  /** TOTAL quantity used in the cell — commercial + compound usage. */
  totalUsageQty: number;
  /** What the FIFO ledger consumed in value for this product's lots in the cell. */
  fifoConsumedValue: number;
}

export interface OtcBuildResult {
  lines: JournalLine[];
  warnings: string[];
  /** Σ of the OTC-attributed value, 2dp — what 5000.35 is debited. */
  otcCogs: number;
  /** Cells dropped by `EXCLUDED_OTC_PRODUCT_IDS`. */
  excludedCells: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The fraction of a cell's FIFO consumption that was dispensed over the counter.
 *
 * CLAMPED TO [0, 1] ON PURPOSE. The numerator and denominator come from two
 * different LifeFile extracts refreshed on their own schedules, so a month whose
 * dispensing feed is one day ahead of the usage feed can read above 1 — measured
 * on exactly that boundary in 2026-09. Letting it through would attribute MORE
 * cost to OTC than the ledger consumed, and the pool would post it. The caller
 * gets a warning instead (`buildOtcCogsLines`).
 *
 * A cell with no recorded usage but non-zero OTC quantity returns 1: everything
 * the ledger burned for that product in that month was the OTC dispense, because
 * that is the only draw we can see. This is the combs' normal state.
 */
export function otcShare(cell: OtcProductMonth): number {
  if (cell.otcQty <= 0) return 0;
  if (cell.totalUsageQty <= 0) return 1;
  const raw = cell.otcQty / cell.totalUsageQty;
  return raw > 1 ? 1 : raw;
}

/**
 * The reclass lines for ONE (entity, month).
 *
 * Debits are one combined line to 5000.35; credits are split by the COGS account
 * the close actually charged, so the entry reads as the reversal it is rather
 * than as a new cost. A category with no QuickBooks pair (`Uncoded`, or a
 * product with no lots at all) lands on the parent `Cost of Goods Sold` with
 * `mapped: false` and raises a warning, matching `residualWarning`'s convention
 * in `close-server.ts` — it never throws mid-close.
 *
 * Returns no lines at all when the total rounds to zero. A shelf of $0.00
 * entries is noise an accountant has to read past every month, the same
 * judgement `buildLabAccrualDrafts` makes.
 */
export function buildOtcCogsLines(
  cells: readonly OtcProductMonth[],
  month: string,
): OtcBuildResult {
  const warnings: string[] = [];
  let excludedCells = 0;

  const byCategory = new Map<string, number>();
  const productIdsByCategory = new Map<string, Set<string>>();
  const overAttributed: string[] = [];

  for (const cell of cells) {
    if (EXCLUDED_OTC_PRODUCT_IDS.includes(cell.productId)) {
      excludedCells += 1;
      continue;
    }
    if (cell.totalUsageQty > 0 && cell.otcQty / cell.totalUsageQty > 1.0001) {
      overAttributed.push(`${cell.productName} [${cell.productId}]`);
    }
    const value = cell.fifoConsumedValue * otcShare(cell);
    if (value === 0) continue;
    byCategory.set(cell.sourceCategory, (byCategory.get(cell.sourceCategory) ?? 0) + value);
    const set = productIdsByCategory.get(cell.sourceCategory) ?? new Set<string>();
    set.add(cell.productId);
    productIdsByCategory.set(cell.sourceCategory, set);
  }

  if (overAttributed.length > 0) {
    warnings.push(
      `${month}: OTC quantity exceeds total recorded usage for ${overAttributed.length} product-month cell(s) ` +
        `(${[...new Set(overAttributed)].slice(0, 3).join(', ')}${overAttributed.length > 3 ? ', …' : ''}) — ` +
        'the dispensing feed is ahead of the usage feed. Attribution was capped at 100%, so no cost is overstated.',
    );
  }

  const credits: JournalLine[] = [];
  let total = 0;
  for (const [category, raw] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    const amount = round2(raw);
    if (amount === 0) continue;
    const { cogs, mapped } = accountsForCategory(category);
    if (!mapped) {
      warnings.push(
        `${month}: OTC cost of ${amount.toFixed(2)} sits on lots categorised '${category}', which has no ` +
          'QuickBooks COGS account — credited to the parent Cost of Goods Sold. Code those products to clear it.',
      );
    }
    total += amount;
    credits.push({
      postingType: 'Credit',
      amount,
      accountName: cogs,
      departmentName: null,
      className: null,
      memo: `OTC dispensing reclassified out of ${category} — ${month}`,
      creditBucket: null,
      origin: 'generated',
      sourceRowKeys: [...(productIdsByCategory.get(category) ?? [])].sort(),
    });
  }

  const otcCogs = round2(total);
  if (otcCogs === 0) return { lines: [], warnings, otcCogs: 0, excludedCells };

  const debit: JournalLine = {
    postingType: 'Debit',
    amount: otcCogs,
    accountName: OTC_COGS_ACCOUNT,
    departmentName: null,
    className: null,
    memo: `OTC items dispensed — ${month} (LifeFile Schedule='${OTC_SCHEDULE_CODE}')`,
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: [],
  };

  return { lines: [debit, ...credits], warnings, otcCogs, excludedCells };
}

/**
 * The OTC reclass as a pool contributor, for `assemblePool`.
 *
 * `available` is the read question, not the amount question: a month with no OTC
 * dispensing is available and contributes nothing, exactly as
 * `assemblePool`'s doc comment wants ("the accrual ran and had nothing to
 * accrue" ≠ "the accrual never ran"). Pass `available: false` only when the
 * dispensing or ledger read actually failed.
 */
export function otcCogsContribution(
  cells: readonly OtcProductMonth[],
  month: string,
  available = true,
): JeContribution {
  if (!available) {
    return {
      source: 'otc-items',
      label: 'OTC items reclass',
      available: false,
      warnings: [`${month}: OTC dispensing could not be read — the entry is incomplete.`],
      lines: [],
    };
  }
  const built = buildOtcCogsLines(cells, month);
  return {
    source: 'otc-items',
    label: 'OTC items reclass',
    available: true,
    warnings: built.warnings,
    lines: built.lines,
  };
}
