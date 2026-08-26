/**
 * Plain-English definitions for the inventory system's terms, with each
 * number's data source — ONE list, rendered by the Methodology page and
 * exported as the Definitions sheet of the FIFO workbook.
 */
export const GLOSSARY: ReadonlyArray<readonly [string, string, string]> = [
  [
    'FIFO (first-in, first-out)',
    'The costing rule: when stock is consumed, it always comes out of the OLDEST purchase still on hand, at the price we actually paid for that purchase. Nothing is valued at an average or an estimate.',
    'Method rule, implemented in the MedRock data pipeline’s FIFO transform (runs nightly on the loader server).',
  ],
  [
    'Lot',
    'One purchase receipt of one product — its quantity, its invoice cost, its date. The ledger is ~15,300 of these; every dollar on this page traces back to specific lots.',
    'LifeFile "Drug Receiving Record" report, pulled nightly per pharmacy → inventory.purchase_lots (2022-08 → present).',
  ],
  [
    'Roll-forward',
    'The monthly statement identity: Beginning + Purchases − COGS − Waste − Shrink = Ending. Each month’s ending is the next month’s beginning; every table here foots to it exactly.',
    'Computed — inventory.fifo_valuation_summary, one row per (month × pharmacy × category).',
  ],
  [
    'COGS (usage-driven)',
    'Cost of the stock consumed by recorded activity — dispensing and compounding usage the pharmacy system logged — valued at the FIFO lot costs. Posts to each category’s own COGS account.',
    'LifeFile "Drug Usage" reports 7847 (commercial) + 7848 (compound), pulled nightly per pharmacy → source.drug_usage_*.',
  ],
  [
    'Waste (documented disposal)',
    'Stock the pharmacy system explicitly recorded as removed: expirations, destruction, spillage, count corrections — each entry dated, lot-level, and attributed to the staff member who logged it. Written off on the date it happened.',
    'LifeFile "Lot Inventory Adjustment" report 8099, all seven adjustment reasons → source.lot_inventory_adjustment (7,835 entries, full four-year history).',
  ],
  [
    'Shrink (count residual)',
    'The gap that remains after usage and documented waste: stock the roll-forward says we should hold but the month-end count says we don’t. Consumption that never generated a record — compounding loss, breakage, unlogged disposal. Measured monthly, never estimated.',
    'Derived — the anchoring residual (count vs. roll-forward), stored as fifo_valuation_summary.shrink_value_in_month.',
  ],
  [
    'The count (Balance On Hand)',
    'The pharmacy system’s statement of what is on the shelf as of a date, per product per pharmacy. It is the system’s recorded position, not a physical hand count — a retroactive pull reproduces the independently-stored copy of the same month at 98.2%.',
    'LifeFile "Balance On Hand & Value as of Date" report 6958, pulled retroactively per pharmacy per month-end → source.balance_on_hand_commercial (11 month-ends, 2025-12 → current).',
  ],
  [
    'Anchoring / count-anchored month',
    'Forcing a month’s ending balance to match its real count instead of trusting our simulation. Each of the last nine month-ends is pinned to its own count; the difference becomes that month’s shrink. The current, unfinished month is anchored to the live lot report instead ("lot-anchored").',
    'Transform step (FIFO_ANCHOR_MONTHS=9); counts from report 6958, current-month lots from LifeFile lot reports 5354/5355.',
  ],
  [
    'Write-down only',
    'Anchoring only ever reduces the ledger. A count ABOVE the roll-forward is investigated, never booked as found inventory — the books can be conservative but never optimistic.',
    'Method rule (decision record §17.2); the counter-direction amount is instrumented and disclosed, never netted.',
  ],
  [
    'Settled stop point / postable window',
    'February 2026 and earlier are final — no entries are ever posted there. March 2026 forward is the postable window this method states. Older history exists only to walk the lots forward to a defensible opening.',
    'Accounting decision (Carson D., 2026-08-26), recorded in the correction proposal and the decision record.',
  ],
  [
    'Opening correction',
    'The one-time entry dated 2026-03-01 that moves each inventory sub-account from its old estimated balance to the FIFO opening. Posts once, to its own offset account, and is never repeated.',
    'QuickBooks balance sheets as of 2026-02-28 (live API pull) vs. the FIFO ledger at 2026-02; figures in docs/fifo-monthly-close/2026-08-26-correction-je-proposal.md.',
  ],
  [
    'Backward reconstruction (the control)',
    'A second, independent valuation that works BACKWARD from today’s counted position instead of forward from receipts. It shares none of the forward method’s steps, so the two agreeing (the ratio column above) is evidence the method found the real number.',
    'inventory.fifo_rollback_valuation — built from the CURRENT LifeFile lot report walked backward through usage.',
  ],
  [
    'Residual / Uncoded',
    'Purchases not yet assigned to a drug category. They are valued like everything else but post as one combined line on the parent accounts until they get coded.',
    'inventory.purchase_lots.qb_category — assigned at receiving; "Uncoded" until a drug code is applied.',
  ],
  [
    'Pre-conversion bucket (Florida)',
    'Florida compounded on a different system (Pioneer) until early 2025, so its LifeFile usage history starts late. The $2.45M of earlier Florida purchases is excluded as a flagged, auditable bucket — corroborated by Pioneer’s own records showing the stock was consumed.',
    'Flagged rows in the lot ledger (pre_floor_collapsed); corroboration from the Pioneer database extract’s fill records (2023-09 → 2025-02).',
  ],
  [
    'Draft / Approved / Posted / Dry run',
    'The workflow on the Close JEs tab: Generate freezes the numbers into a Draft; an accountant Approves it; a Dry run shows exactly what QuickBooks would receive without sending it; Post live writes the entry. Nothing reaches QuickBooks without an explicit approve and post.',
    'Journal store (accounting.payroll_journal_headers) + the QuickBooks Online API; every attempt — dry run or live — is audited.',
  ],
];
