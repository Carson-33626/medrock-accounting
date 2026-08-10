# Receipt Enrichment

Everything that turns a vendor invoice into a coded, receipted, reconcilable entry — the four
vendor engines, the shared Ramp/QuickBooks base they run on, their caches, and the control panel
that drives all of it. One folder.

## Launch the panel

**Double-click `Receipt Capture.cmd`.**

It starts a loopback server on `127.0.0.1:4599` and opens the panel in a standalone Chrome window.
**That console window *is* the server** — close it to stop the panel.

Equivalent from a terminal, run from `web/`:

```
npx tsx scripts/receipt-enrichment/ui/serve.ts
```

## ⚠️ Never zip, copy, or share this folder

`cache/` contains **live authenticated vendor sessions** — Playwright `storageState` for TopRx
(FL/TN/TX), ULINE (FL/TN/TX), and Walmart. Anyone who receives a copy of this folder can sign in
as MedRock to those vendor portals. It also holds ~360 MB of real invoice PDFs and cardholder-PII
CSVs.

`.gitignore` keeps `cache/` out of git, but nothing stops a manual copy. If you need to share the
tool, share the repo — never the `cache/` directory.

## Layout

```
receipt-enrichment/
  Receipt Capture.cmd   ← double-click this
  paths.ts              ← single source of truth for every cache location
  ui/                   ← the control panel
    index.html  styles.css  app.js     ← the page: real, editable files
    serve.ts                            ← entrypoint (server + Chrome app window)
    server.ts  actions.ts  status.ts  assets.ts
  engines/
    receipt-capture/    ← TopRx, ULINE, Letco, Medisca + the sweep orchestrator
    amazon-enrich/      ← Engine A: receipt parser, splitter, GL classifier
    amazon-csv-enrich/  ← charge-level Amazon Business pipeline
    walmart-enrich/     ← Walmart + Sam's Club
    ramp-split-push/    ← shared base: ramp-client, types, load-env, run-migration
  cache/                ← gitignored. Sessions, invoice PDFs, extraction caches, plans, audit
```

`ramp-split-push` is **not** an engine — it's the shared base every engine imports. It sits
alongside them rather than above them so that intra-program imports (`../ramp-split-push/types`)
resolve without a level of indirection.

Each engine keeps its own README with the operational detail:
[receipt-capture](engines/receipt-capture/README.md) is the one to read first.

## Editing the panel

`styles.css` and `app.js` are re-read on every request — edit, refresh the panel, done. No
restart. `index.html` is read once at startup, so changing it needs a restart.

The page is deliberately framework-free and build-free. Two rules if you touch `app.js`:

- **Never `innerHTML`.** Vendor detail strings and child-process output flow into the DOM; they
  are written with `textContent` only.
- **Never hard-code an action name's label or risk.** Both come from `ACTION_META`, served by
  `/api/status` and derived from the same definitions in `actions.ts` that enforce arming. That
  coupling is what keeps the panel from showing live buttons that can't work.

## Safety model

- **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`, and additionally checks the
  `Host` header (defeats DNS rebinding), the `Origin` header on POSTs (defeats cross-origin
  form/fetch), and requires an exact `application/json` content type (forces a CORS preflight that
  always fails).
- **Closed action registry.** Every button maps to one entry in `actions.ts`, and every entry's
  argv is a hard-coded literal. No caller-supplied string ever reaches an argv array.
- **Arming.** Actions that write to Ramp or QuickBooks are declared with `live()`, which both
  marks them in `ACTION_META` and rejects any call without `armed: true`. The panel renders them
  as danger buttons behind a per-card arm toggle; the server-side check is the real boundary.
- **Allowlisted assets.** `/styles.css` and `/app.js` are a fixed map, not a path join — there is
  no traversal surface.

## Cache locations

Everything is derived from `paths.ts`. If you add a runner, import from there rather than writing
a path literal — a literal that misses a future move fails *silently* (the runner recreates the
directory and the panel reads a stale cache), which is exactly how this consolidation could have
gone wrong.

| Constant | Holds |
|---|---|
| `RC.out` / `RC.pdf` / `RC.sweep` / `RC.audit` | receipt-capture plans, invoice PDFs, sweep reports, the shared audit CSV |
| `RC.state` | **Live TopRx/ULINE sessions** |
| `AMZ.out` / `AMZ.receipts` | Engine A output; shared Amazon receipt PDFs |
| `ACSV.out` / `ACSV.sharedPdf` | per-account `transactions.csv`; Amazon invoice PDFs by order id |
| `WM.out` / `WM.receipts` / `WM.session` | Walmart + Sam's extraction caches, PDFs, **live session** |
| `RSP.out` | ramp-split-push preview output (cardholder PII) |

## Verifying a change

Run from `scripts/receipt-enrichment/` itself — the program has its own toolchain, no parent
config:

```
npx tsc --noEmit      # typechecks the whole program, no parent config
npx vitest run        # 63 files, 569 tests
```
