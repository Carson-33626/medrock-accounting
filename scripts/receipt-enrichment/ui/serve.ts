// scripts/receipt-enrichment/ui/serve.ts
//
// Entrypoint for the Sweep Control Panel. Normally launched by double-clicking
// `Receipt Capture.cmd` in the program root; equivalently, from web/:
//   npx tsx scripts/receipt-enrichment/ui/serve.ts
//
// Starts the loopback server (127.0.0.1:4599), opens a standalone Chrome app window, and stays
// alive until Ctrl+C (or until the launcher's console window is closed). Loads web/.env.local
// first, same as every other runner in this program, so the status panel's credential checks
// (checkTopRx et al) see real env vars.
import '../engines/ramp-split-push/load-env';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startSweepUiServer } from './server';
import { readIndexHtml } from './assets';

const PORT = 4599;
const URL = `http://127.0.0.1:${PORT}`;
// Same exe as the chrome-walmart/chrome-amazon actions (actions.ts), but its own profile dir --
// this is a throwaway "app window" profile, never signed into anything, kept fully separate from
// the Walmart/Amazon-signed-in profiles those actions launch.
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_APP_PROFILE = 'C:\\sweep-ui-profile';

function openPanel(): void {
  // Carson's first smoke (2026-07-29): `cmd /c start <url>` opened his DEFAULT browser profile,
  // restoring his whole startup-tab set on top of the panel -- not what a "control panel" should
  // do. --app gives a chromeless standalone window (no tabs, no session restore) in a dedicated
  // profile dir, so the panel never touches his main profile. Falls back to `start` (default
  // browser, a full tabbed window) only when Chrome isn't at the expected path.
  if (existsSync(CHROME_EXE)) {
    spawn(CHROME_EXE, [`--app=${URL}`, `--user-data-dir=${CHROME_APP_PROFILE}`], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  console.log(`Chrome not found at ${CHROME_EXE} -- falling back to your default browser (full window, not app mode).`);
  spawn('cmd', ['/c', 'start', URL], { detached: true }).unref();
}

async function main(): Promise<void> {
  // Read once at startup: a missing index.html should fail loudly here, not as a blank page.
  // Fine to hold in memory -- styles.css and app.js are still re-read per request (assets.ts), so
  // iterating on the page's look or behaviour only needs a browser refresh, not a restart.
  const page = readIndexHtml();

  const handle = await startSweepUiServer({ port: PORT, page });
  console.log(`Sweep Control Panel listening on ${URL}`);
  console.log('Close this window (or press Ctrl+C) to stop the panel.');

  openPanel();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down Sweep Control Panel...');
    handle
      .close()
      .then(() => process.exit(0))
      .catch((e: Error) => {
        console.error('Error while closing server:', e.message);
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: Error) => {
  console.error('Sweep Control Panel failed to start:', e.message);
  process.exit(1);
});
