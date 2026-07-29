# Receipt Capture (TopRx + ULINE + Amazon)

Fills missing receipts on Ramp card transactions for two vendors — TopRx (Rx wholesale, net
terms) and ULINE (packaging/supplies, card-at-purchase) — by scraping each vendor's own order
history for the invoice PDF, matching it to the corresponding un-receipted Ramp transaction, and
(only in `--live` mode, capped) attaching the receipt + writing a memo + coding a GL split.

A third, structurally different stream — **Amazon (un-split + order-ID memo)** — reverses
Engine A's earlier itemized splitting for Amazon-family txns; see its own section below.

Both vendors follow the same **extract → match → plan → (live) write** shape, run per entity
(FL, TN, TX):

- **Extract**: scrape the vendor's order-history grid, fetch each order/invoice's PDF, parse it,
  cache the result. Resumable — only orders not already in the cache are fetched.
- **Match**: pair cached orders against the Ramp *worklist* (cleared, unsynced, receipt-less
  card txns for that vendor) by amount + date window.
- **Plan**: write a full itemized decision CSV (matched+reconciled, matched-but-not-reconciled,
  ambiguous, unmatched, over-limit) — always, dry-run or live.
- **Write (live only, capped by `--limit`)**: attach receipt PDF, PATCH memo, PATCH GL split.

Everything is a **dry-run by default**. Nothing writes to Ramp unless you pass `--live`.

## Env keys (`web/.env.local`)

| Key | Used by | Notes |
|---|---|---|
| `TopRX_{FL,TN,TX}` / `TopRX_{FL,TN,TX}_Pass` | `toprx-session.ts` | Scripted headless login. Proven safe for TopRx — no captcha/bot-defense observed (2026-07-27 probes: `toprx-screener-probe.ts`, `toprx-login-probe.ts`). Session auto-re-logs-in transparently whenever the saved `.state/toprx-<ENT>.json` has lapsed — no manual step needed once creds are in `.env.local`. |
| `Uline_{FL,TN,TX}` / `Uline_{FL,TN,TX}_Pass` | **nothing** at runtime | These exist in `.env.local` (used only by the one-off `uline-login-probe.ts` bot-defense probe) but the actual capture pipeline **never** logs in to ULINE with them. ULINE sits behind Akamai and a probe found scripted login triggers a challenge for some accounts — see "ULINE session bootstrap" below. |
| `ULINE_ACCOUNT_{FL,TN,TX}` | `run-uline.ts` (`assertAccountMatches`) | Expected company-name label (`#CompanyName` on ULINE's MyOrderHistory page) for that entity's ULINE account. Hard-stop guard — see below. |

## ULINE session bootstrap (human-gated, one-time per entity)

`--entity=FL` on `run-uline.ts` is a **label only** — it does not select which ULINE account
gets scraped. Account identity comes entirely from whichever `storageState` is signed in, so the
pipeline verifies it before doing anything else.

Run (headed browser opens, **you** do the entire login by hand — email, password, any captcha;
nothing here is scripted):

```
npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=FL
```

The script polls until you reach an authenticated Order History page (up to 10 minutes), reads
the `#CompanyName` header, and saves `storageState` to `scripts/receipt-capture/.state/uline-<ENT>.json`
for headless reuse by every subsequent run. Status as of 2026-07-27:

- **FL** — bootstrapped, account confirms as `MEDROCK PHARMACY` (also the hardcoded fallback
  default in `run-uline.ts` if `ULINE_ACCOUNT_FL` is unset).
- **TN / TX** — not yet bootstrapped. Until you run the bootstrap for each, `run-uline.ts
  --entity=TN` (or `TX`) exits 2 (`ULINE_SIGNIN_REQUIRED`). Once bootstrapped, also set
  `ULINE_ACCOUNT_TN` / `ULINE_ACCOUNT_TX` in `.env.local` to that entity's exact `#CompanyName`
  text — there is no hardcoded default for TN/TX, so a missing env var is a hard stop
  (`ULINE_ACCOUNT_ENV_MISSING`), not a silent guess.

If a saved session goes stale (ULINE signs it out), `run-uline.ts` detects the bounce back to
`/SignIn` and exits 2 — re-run the bootstrap for that entity.

## The weekly sweep (run-sweep.ts)

The receipt sweep is the orchestrated entrypoint: it scans all entities for open transactions
missing receipts, runs every vendor pipeline that has access, re-scans, and emits a week-over-week
report plus a residual queue for manual follow-up.

```
npx tsx scripts/receipt-capture/run-sweep.ts [--dry-run] [--vendor toprx,uline,amazon,walmart,amazon-csv] [--limit N] [--skip-scan]
```

**LIVE by default** (no `--live` flag — the sweep runs against your live Ramp account with no caps). Omit `--dry-run` only when you're ready for real writes.

Flags:

- `--dry-run` — read-only pass. All vendor runners still run and plan their work; nothing gets
  written to Ramp. Omit to go LIVE.
- `--vendor vendor1,vendor2,...` — comma-separated list of vendors to run (any combo of:
  `toprx`, `uline`, `amazon`, `walmart`, `amazon-csv`). Omit to run all five.
- `--limit N` — max number of transactions actually written by any one vendor runner (default
  999999). Confident matches beyond the limit are planned but marked `over_limit` and left dry.
- `--skip-scan` — skip S1 and S4 (before/after scans); reuse the last scan baseline and assume
  an empty "after". Useful for vendor-only re-runs or debugging. Does NOT update the residual
  queue or the baseline pointer (see caching below).

The sweep runs five stages sequentially:

1. **S0 preflight**: check TopRx creds, ULINE session, Walmart CDP port, Amazon-CSV cache
   readiness. Flags blockers and collects a "needs you" list.
2. **S1 scan**: fetch open (unsynced, receipt-less) transactions across all entities via Ramp's
   `transactions:read` API. Write `scan-<runId>-before.csv`.
3. **S2/S3 vendor jobs**: run applicable vendor runners sequentially (TopRx → ULINE → Amazon →
   Walmart → Amazon-CSV). Each logs its own result summary.
4. **S4 re-scan**: fetch open transactions again (captures progress made by the vendors). Write
   `scan-<runId>-after.csv`.
5. **Report + residual**: emit `report-<runId>.md` (scan summary, vendor results, top merchants
   by $, needs-you checklist) and `residual-queue.csv` (grouped by merchant → cardholder → date,
   full queue for operator follow-up).

**Caching**: The sweep itself never purges or modifies any cache. Vendor runners (TopRx, ULINE,
Amazon, Walmart, Amazon-CSV) are fully resumable — each keeps its own extraction/receipt cache
and only fetches what's missing. To clear caches and do a full re-extract, delete `out/toprx-*`,
`out/uline-*`, etc. by hand. Deleting `out/sweep/` only loses week-over-week report diffs; the
next sweep still has the full residual queue from the last real scan (stored separately in
`residual-queue.csv`).

**Outputs** (under `scripts/receipt-capture/out/sweep/`):

- `report-<runId>.md` — the full week's summary: scan counts before/after, vendor results, top
  merchants by $, needs-you checklist. One per run, never overwritten.
- `residual-queue.csv` — the current un-receipted worklist, grouped by merchant → cardholder →
  date. Rewritten on every real scan (not `--skip-scan` runs), so it's always the latest state
  for manual follow-up and next week's baseline.
- `scan-<runId>-before.csv`, `scan-<runId>-after.csv` — before and after txn snapshots (S1 and
  S4). One pair per run.
- `state.json` — internal state: pointer to the last real scan's "after" CSV (for diffing), and a
  history of all scans (run ID, txn count, total $). Updated on every real scan.

**"Needs you" items** (collected during preflight and vendor runs, flagged in the report):

- **ULINE bootstrap**: if `run-uline.ts` exits 2 for any entity, that session is stale or
  missing — re-run `npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=<ENT>` to sign
  in by hand and refresh the session. This is per-entity and one-time per session lapse.
- **Walmart CDP Chrome**: to extract Walmart order history, a headless Chrome instance must be
  running with remote debugging enabled (`chrome.exe --remote-debugging-port=9222
  --user-data-dir=C:\wm-chrome-profile`) and signed into walmart.com. Start it, then re-run the
  sweep (or run `npx tsx scripts/walmart-enrich/run-cdp.ts` directly).
- **Amazon-CSV extract per Business login**: each Amazon Business account must be extracted
  separately (outside the sweep). Sign into each Business account in a Chrome session, then run
  `npx tsx scripts/amazon-csv-enrich/run-extract.ts --account <label>` once per login. This
  captures the CSV order history and charge details for later attachment.
- **Fresh ULINE MyOrderHistory export**: for category-enriched GL splits, export your current
  account's full `MyOrderHistory.csv` from ULINE's Export tab, then pass `--csv <path>` to
  `run-uline.ts`. Not required for basic matching — category defaults are used if the CSV is
  absent.

**Exit codes**: The sweep itself exits 0 on success or 1 on an unhandled error. Child vendors may
exit non-zero — these are logged in the report. ULINE runners specifically exit 2 (sign-in
required) or 3 (account identity mismatch); both are "expected" failures that don't stop the
overall sweep or halt at an exit code — they're just flagged as needs-you items and other vendors
continue.

**Amazon**: The sweep runs two Amazon jobs: `run-amazon.ts` (un-split & order-ID memo) and
`amazon-csv-enrich run-attach.ts` (receipt + memo from charge pairing). Both enforce a
single-line policy — Amazon txns are never split further and are always synced to QBO as a plain
Suspense entry (with order ID in the memo for pairing). See the "Amazon" section below for
details.

## Running it

From the `web/` directory:

```
# TopRx — all 3 entities by default, or one via --entity
npx tsx scripts/receipt-capture/run-toprx.ts [--entity=FL] [--since 2025-09-01] [--live] [--limit 5]

# ULINE — --entity is REQUIRED (no all-entity default)
npx tsx scripts/receipt-capture/run-uline.ts --entity=FL [--since 2025-09-01] [--live] [--limit 5] [--csv path/to/MyOrderHistory.csv] [--window 3]
```

Flags:

- `--entity` — TopRx: optional, omit to run FL+TN+TX in one pass. ULINE: required, one entity
  per invocation.
- `--since` — only scrape/match orders on or after this date (`YYYY-MM-DD`). Default
  `2025-09-01` for both.
- `--live` — enables writes (see gating below). Omit for a pure read-only dry-run.
- `--limit` — max number of transactions actually written to in `--live` mode (default 5). Every
  confident+reconciled match beyond the limit still gets a full plan-CSV row, just tagged
  `over_limit` and left in `dry_run` mode.
- `--window` (ULINE only) — match-window days between the invoice date and the Ramp txn date.
  Default 3 (ULINE charges the card at purchase). Warns to stderr above 10 days — confirm with
  the team lead before trusting matches that wide. TopRx's window is not a flag: it's hardcoded
  to 60 days (`MATCH_WINDOW_DAYS` in `run-toprx.ts`) because TopRx bills on net terms — a
  2026-07-27 investigation against real FL data found a median 31-day / max 54-day gap between
  order date and card charge, and the walmart-derived 3-day default produced zero matches.
- `--csv` (ULINE only) — path to a ULINE `MyOrderHistory.csv` export (Export tab). When given,
  line items get enriched with ULINE's own Category column (used by the GL split rules in
  `gl-defaults.ts`) before matching/planning. **Not yet exercised against a real export** — see
  Known limitations.

### Exit codes

- `0` — normal completion (dry-run or live).
- `1` — uncaught error (bad args, unhandled exception).
- `2` (ULINE only) — sign-in required: no saved session, or the saved session bounced back to
  `/SignIn`. Re-run `uline-bootstrap.ts --entity=<ENT>`.
- `3` (ULINE only) — account identity guard tripped: either the signed-in ULINE account's
  `#CompanyName` doesn't match `ULINE_ACCOUNT_<ENT>` (`ULINE_ACCOUNT_MISMATCH`), or no env var
  and no hardcoded default exists for that entity (`ULINE_ACCOUNT_ENV_MISSING`). Hard stop —
  nothing else runs for that entity on that invocation.

TopRx has no equivalent 2/3 codes: session lapses are absorbed transparently by the scripted
auto-re-login in `toprx-session.ts`, and there's no per-entity account-identity ambiguity (each
`TopRX_<ENT>` credential pair logs straight into that entity's own account).

## Dry-run vs. live, and the write cap

Every run does the full extract+match+plan pass regardless of `--live`. The only thing `--live`
changes is whether *confident, reconciled* matches (parsed/invoice total equals the Ramp txn
amount, txn has a `userId`, no same-total collision) actually get written — and even then, only
up to `--limit` of them per invocation; the rest degrade to `dry_run` plan rows tagged
`over_limit`.

A live write for one matched txn is three calls, all audited:

1. `POST /receipts` (multipart, receipt PDF) — requires `user_id` + a stable
   `idempotency_key` (`rcpcap-<vendor>-<txnId>`), so a retried or re-run invocation dedupes
   instead of creating a duplicate.
2. `PATCH /transactions/{id}` with `{ memo }`.
3. `PATCH /transactions/{id}` with `{ line_items }` (GL split) — skipped (receipt+memo still
   applied) if `buildVendorSplit` couldn't build a split.

## Where things live

| Path | What | Committed? |
|---|---|---|
| `out/receipt-capture-audit.csv` | Append-only audit of every live action (both vendors share one file) — `ts,run_id,mode,vendor,entity,txn_id,action,invoice_key,amount_cents,status,detail`. Dry-runs never touch it. | No (`out/` gitignored) |
| `out/toprx-plan-<ENT>.csv`, `out/uline-plan-<ENT>.csv` | Full itemized plan for the most recent run of that vendor+entity — every match and every skip, with a `notes` reason. Overwritten each run. | No |
| `out/amazon-plan-<ENT>.csv` | Amazon un-split/memo plan for the most recent run — see the Amazon section above. Overwritten each run. | No |
| `out/amazon-receipt-gap.csv` | Combined (all entities in that invocation) list of Amazon txns with zero attached receipts. Overwritten each run. | No |
| `out/toprx-cache-<ENT>.json`, `out/uline-cache-<ENT>.json` | Resumable extraction cache (keyed by order id / invoice number). Re-running only fetches what's missing. | No |
| `out/uline-categories-<ENT>.json` | Parallel category array per ULINE invoice (from `--csv` enrichment), keyed by invoice number, aligned to the cached record's items by index. | No |
| `out/pdf/` | Fetched invoice PDFs (`toprx-<ENT>-<orderId>.pdf`, `uline-<ENT>-<invoiceNumber>.pdf`). | No |
| `.state/` | Playwright `storageState` — `toprx-<ENT>.json` (all 3 bootstrapped as of 2026-07-27, auto-refreshed), `uline-<ENT>.json` (FL only so far, human-bootstrapped, never auto-refreshed). | No |
| `.probe-shots/` | Screenshots from the one-off login/screener probes. | No |
| `fixtures/` | Sample roster JSON + invoice PDF/text pairs used by the `*.test.ts` unit tests. | **Yes** |

## Rollback

- **Splits are reversible**: `PATCH /transactions/{id}` with an empty `line_items: []` clears a
  split back out (same `patchSplit` helper in `../amazon-enrich/client.ts` used to write it).
- **Memos are rewritable**: `PATCH /transactions/{id}` with `{ memo }` any time.
- **Receipts have no delete API.** There is nothing to roll back for a wrongly-attached
  receipt short of contacting Ramp support. This is why: (a) the idempotency key
  (`rcpcap-<vendor>-<txnId>`) prevents ever attaching a duplicate on retry/re-run, and (b) the
  pipeline only attaches on an unambiguous, reconciled match (exact amount equality, no
  same-total collision from another order in the same window) — never on a fuzzy or best-guess
  pairing.

## Known limitations

- **FL ULINE**: 3 invoices consistently fail to parse and 1 consistently fails to fetch its PDF.
  These are retried on every run (the extraction cache only records *successful* fetches, so
  failures never get "stuck" as permanently skipped) but haven't been root-caused yet.
- **TopRx match window (60 days)**: wide enough to explain the observed net-terms billing gap
  without introducing amount-collision ambiguity at current order volume (~100/entity over 10
  months) — but has not been stress-tested at higher volume.
- **TopRx two-pass matching**: a match found via the roster-grid-total fallback pass
  (`matchedBy: 'roster'`) means the invoice PDF we captured does *not* reconcile with the actual
  Ramp charge (typically a partial/split-shipment invoice) — these are always routed to
  `no_reconcile` / manual review, never live-actioned automatically.
- **ULINE `--csv` category enrichment**: implemented and unit-tested against a synthetic fixture,
  but not yet exercised against a real `MyOrderHistory.csv` export. Treat the first real run with
  `--csv` as a validation pass, not a routine one.
- **TopRx credit/return rows are excluded by design** (`IsOrderTypeCredit` in
  `toprx-roster.ts`) — they represent money coming back, not a purchase with a receipt to
  capture, so they never enter matching at all.

## Amazon (un-split + order-ID memo)

**Why**: Barbara's flow makes QBO's Amazon-direct connection the itemization source of truth for
Amazon purchases — it already pulls order-level detail straight from Amazon. That means Ramp's
own itemized splits (Engine A's earlier `amazon-enrich` work) are now redundant and actively in
the way: they leave the Ramp-side txn looking coded when QBO's connection is the one doing the
real itemization. The reversed design: every un-synced Amazon-family Ramp txn should land in QBO
as a **plain single-line entry to Suspense**, with the Amazon order ID prepended to the memo.
Staff then pair the Suspense line to the corresponding QBO Amazon-direct order by that ID. Any
Suspense residue left over at month-end is the hunt list for orders that still need pairing (or
still need a receipt — see the gap CSV below).

**Commands** (from `web/`):

```
# Dry-run — all 3 entities by default, or one via --entity. Zero Ramp writes (read-only token).
npx tsx scripts/receipt-capture/run-amazon.ts [--entity=FL] [--pages 100]

# Live pilot — capped, audited. Get Carson's go-ahead first (see "Human-gated procedures" above).
npx tsx scripts/receipt-capture/run-amazon.ts --entity=FL --live --limit 5
```

Per eligible txn (cleared, `NOT_SYNC_READY`, Amazon-family, never AWS):

- If Engine A previously split it (`enriched: true`), **un-split**: `PATCH` `line_items: []`,
  collapsing it back to Ramp's single default line.
- Recover the Amazon order ID — cached/fresh receipt PDF first, then the existing memo, then
  line-item memos, then the merchant descriptor — and **prepend** `Amazon order# <id>` to the
  memo (existing human text is preserved below it, same policy as `amazon-memo.ts`'s
  `composeMemo`). No-op if the memo already carries every recovered ID.
- No receipt attached → routed to the receipt-gap CSV (C4 / Amazon-CSV-backfill workstream), not
  actioned further. No order ID recoverable from any source → flagged `no_order_id` in the plan
  row; still un-split if enriched, just without a memo write.
- Amazon digital orders (Prime Video, Kindle, subscriptions) use a `D01-xxxxxxx-xxxxxxx` id format
  that the 3-7-7 order-number regex intentionally doesn't match — these will always show up as
  `no_order_id`. Don't chase them in that bucket; there's no recoverable order-ID memo for them.

**Output CSVs** (`out/`, gitignored):

- `amazon-plan-<ENT>.csv` — one row per worklist txn: recovered order IDs + which source they
  came from, enriched flag, has-receipt flag, planned actions, dry-run/live mode, notes
  (`no_receipt`, `no_order_id`, `memo_already_current`, `over_limit`).
- `amazon-receipt-gap.csv` — combined across all entities run in that invocation: every txn with
  zero attached receipts, for the Amazon-CSV-backfill workstream or manual upload. These are left
  in QBO Suspense as designed until receipted.

**Audit trail**: `unsplit` rows in `out/receipt-capture-audit.csv` carry the txn's prior
`line_items` as a JSON snapshot in `prior_line_items` (same column Engine A's own splits used) —
rollback for an un-split done in error is re-`PATCH`ing those exact lines back via
`patchSplit(entity, txnId, <parsed prior_line_items>, token)`, done by hand. `memo` rows carry the
prior memo text in `prior_memo` for the same reason.

**Hard rules**:

- Never touches a txn with `sync_status` of `SYNCED` or `SYNC_READY` — only `NOT_SYNC_READY`
  (never pushed to QBO) is in scope, so nothing already reconciled in QBO is disturbed.
- AWS is explicitly excluded from the Amazon-family match (`isAmazonFamily` in
  `amazon-worklist.ts`) — it bills separately and was never itemized through the QBO
  Amazon-direct connection this workstream reverses.
- `--live` is gated the same as TopRx/ULINE: Carson's explicit per-run go-ahead, small `--limit`
  pilot first, audit CSV review before raising the limit. `weekly.ps1` only ever runs the
  dry-run form.

## Weekly wrapper

`weekly.ps1` runs a dry-run pass across TopRx (all entities), ULINE (FL, TN, TX — each skipped
cleanly if sign-in is required), and Amazon (all entities):

```
powershell -File scripts\receipt-capture\weekly.ps1
```

It stays dry-run on purpose. Flipping any command inside it to `--live` is a deliberate,
one-line edit you make by hand once standing live mode is green-lit — see the pilot procedure
below.

## Human-gated procedures

### TopRx / ULINE live pilot (first live run for a vendor)

1. Get Carson's explicit go-ahead for that vendor.
2. Pilot small: `npx tsx scripts/receipt-capture/run-toprx.ts --live --limit 5` (or the ULINE
   equivalent with `--entity=<ENT>`).
3. Open Ramp and manually verify, for each of the 5: receipt PDF attached, memo present and
   correct, split lines present and correctly GL-coded.
4. Review `out/receipt-capture-audit.csv` for the batch (statuses, any non-2xx responses).
5. If clean, raise `--limit` and clear the remaining backlog per entity, re-checking the audit
   CSV after each batch.
6. Only after backlog is cleared and spot-checks are clean should the weekly wrapper's
   `--live` flip be considered.

### Bootstrapping ULINE TN / TX

1. `npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=TN` (then `TX`) — log in by hand
   in the headed window, including any captcha.
2. Note the confirmed `#CompanyName` the script prints on success.
3. Add `ULINE_ACCOUNT_TN=<that name>` (and `_TX`) to `web/.env.local` — exact text, it's
   compared uppercase but otherwise verbatim.
4. Dry-run to confirm: `npx tsx scripts/receipt-capture/run-uline.ts --entity=TN` should log
   `[TN] ULINE account verified: "..."` and proceed past the account guard instead of exiting 3.
