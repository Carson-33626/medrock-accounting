# walmart-enrich

Capture big-box order invoices → match to Ramp charges → itemized GL split + receipt attach.
Reuses the amazon-enrich splitter. See `docs/walmart-receipt-capture/` for the original DS, and
`docs/superpowers/specs/2026-07-30-walmart-multientity-sams-club-design.md` for the multi-entity fix and
the Sam's Club extension.

## The two phases

Extraction needs a signed-in browser; the split/attach phase never touches the retailer, only the cache.

```
# 1. EXTRACT — human login, then scrape order history into the cache
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\wm-chrome-profile   # sign into walmart.com
npx tsx scripts/receipt-enrichment/engines/walmart-enrich/run-cdp.ts

# 2. SPLIT + ATTACH — cache -> Ramp. Dry-run by default.
npx tsx scripts/receipt-enrichment/engines/walmart-enrich/run-cdp-split.ts
npx tsx scripts/receipt-enrichment/engines/walmart-enrich/run-cdp-split.ts --entity TN --cap 1 --live    # pilot one entity
npx tsx scripts/receipt-enrichment/engines/walmart-enrich/run-cdp-split.ts --live                        # all entities, uncapped
```

Flags: `--retailer walmart|sams`, `--entity FL[,TN]` (default: all three), `--since`, `--ramp-pages`,
`--cap N`, `--live`. Both `--flag value` and `--flag=value` work.

## What the runner guarantees

- **All entities.** Orders are pooled and matched ONCE against every entity's transactions, so each order
  and each transaction is claimed at most once, and the winning transaction's own entity supplies the
  token and chart of accounts. It was pinned to FL until 2026-07-30, which hid 45 of 49 matches.
- **An order whose same-amount candidates span two entities is refused**, never guessed — a wrong pick
  still balances, so nothing downstream would catch it.
- **Writes are gated on live transaction state** (`write-gate.ts`): CLEARED, not synced, and re-read from
  Ramp immediately before writing. Split and attach are decided separately. Unknown state blocks.
- **`--cap` bounds attempts, not successes**, so a run whose writes keep failing still stops.
- **Receipts are keyed per transaction** (`receiptIdempotencyKey`) and skipped when one already exists.
  Ramp has no receipt-delete API, so a duplicate is permanent.
- **Every split appends to `out/rollback.json` the moment it succeeds**, so a crash or a kill mid-run
  still leaves a complete undo trail.

## Recovery

`reattach.ts` re-uploads receipts for rows in `rollback.json` (attach-only, re-reads each transaction and
skips any that already has a receipt).

## Retired

`run.ts` is the pre-CDP single-entity pipeline, superseded by `run-cdp.ts` + `run-cdp-split.ts`. Its live
writes are refused: it has no state gate, no receipt gate, and shares output paths with the current runner.
Dry-run remains for inspection.
