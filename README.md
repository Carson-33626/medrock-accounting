This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## The control panel (sweep-ui.ts)

The Sweep Control Panel is a local web interface for managing receipt-capture sessions and running sweeps without touching the terminal. It wraps the underlying CLI runners but adds a layer of UI safety: arming before live sweeps, vendor session health at a glance, and one-action-at-a-time locking to prevent concurrent runs.

### Starting the panel

```bash
npx tsx scripts/receipt-capture/sweep-ui.ts
```

This starts a loopback server on `127.0.0.1:4599` and opens a standalone Chrome app window (a dedicated, throwaway profile at `C:\sweep-ui-profile` — separate from your main browser). The server stays alive until you press Ctrl+C.

**Why a dedicated Chrome profile?** Vendor logins (Walmart, Amazon sign-in via CDP; TopRx/ULINE WebDriver bootstrap) and live Ramp writes all run on your machine. The dedicated profile ensures these actions never touch your main Chrome session or trigger restore-startup confusion.

**If Chrome isn't installed** at the default path, the panel falls back to your default browser (full tabbed window, not app mode).

### The three panels

1. **Sessions & sources** (left)
   - Per-vendor cards showing session health (green = ready, amber = warning, red = fix needed).
   - Click the fix button (e.g., "Bootstrap ULINE FL") to open a login window. The window closes and syncs automatically when storageState saves.
   - Shows cache ages (TopRx/ULINE vendor session files, Amazon vendor cache, Walmart cache, latest CSV extract) and open-receiptless transaction counts per entity.

2. **Run** (middle)
   - **Dry-run button** (default): simulates the sweep without writing to Ramp. Useful for testing and previewing the report.
   - **"Arm LIVE" toggle + Run LIVE sweep button**: to run a live sweep (writes to Ramp), first toggle the checkbox to arm it, then click. Two-step prevents accidental writes from a stray click.
   - Live console shows output from the running sweep (fed via Server-Sent Events). Console tail is preserved if you rejoin mid-run.
   - Banners show busy status (blue) or completion status (green for success, red for errors). Exit codes:
     - `2`: ULINE session expired — use the Sessions panel to re-bootstrap
     - `3`: Account mismatch — verify environment variables
     - `4`: Corrupt registry — check stored state files

3. **Results** (right)
   - Latest sweep report rendered as markdown (rows processed, split quality, any errors).
   - **Scan** button refreshes the open-receiptless transaction counts in real time (no child spawned; read-only Ramp API call).
   - List of recent reports for quick access.
   - Residual-queue summary (rows + dollar total of unprocessed transactions).

### Busy-lock and never-two-sweeps

The server enforces one action at a time: starting a second sweep while one is running returns a 409 conflict and is refused by the UI. Bootstrap windows, vendor Chrome launches, and scan operations don't trigger the lock — only real runners (sweeps, extracts, fetch-invoices) do.

Never start a second sweep manually in another terminal while the panel is running one. The panel's state.json is last-writer-wins; concurrent writes will corrupt it.

### Loopback-only, no auth

The server binds `127.0.0.1:4599` **only** (never 0.0.0.0). Loopback is the entire access boundary: it's only reachable from your machine, only while you're running the panel. There is no authentication because there is no network exposure.

### Vendor and limit filtering (v1 CLI-only)

The panel does not offer `--vendor` or `--limit` filtering from the UI in v1. To run a sweep for specific vendors or with row limits, use the CLI runners directly:

```bash
npx tsx scripts/receipt-capture/run-sweep.ts --vendor topx --limit 100 [--dry-run]
```

This will be added to the panel in a future release.

### Exit code meanings in banners

When a sweep completes, a banner appears with the exit code:
- `0`: Success.
- `2`: ULINE session expired (storageState stale; bootstrap a new session).
- `3`: Account mismatch (environment variable or mapped-region error).
- `4`: Corrupt registry (check `scripts/receipt-capture/out/` for stuck state files).
- Any other code: inspect the console output for details. Report persistent errors.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
