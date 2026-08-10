// scripts/receipt-enrichment/ui/actions.ts
//
// Closed action registry for the Sweep Control Panel (DS 2026-07-29, §2-§3): every button in the
// page maps to exactly one entry here, and every entry's argv/exe/args is a HARD-CODED literal —
// resolveAction takes only an action NAME (looked up in this fixed set) plus an `armed` flag for
// the actions that need it. No caller-supplied string, path, or flag from the client ever reaches
// an argv array. Unknown name -> 400. A live action without armed:true -> 400. There is no
// fallthrough "build argv from the request" path anywhere in this module.
//
// 2026-08-07: each entry now also carries its own display metadata, and `live()` is the single
// construct that makes an action live — it sets `risk: 'live'` / `requiresArm: true` AND installs
// the armed check. The page can therefore render live buttons honestly (distinct styling behind a
// per-card arm toggle) instead of guessing from the action name, and the metadata cannot drift
// from the enforcement because both come from the same call. Server-side gating remains the real
// boundary; ACTION_META is presentation only.
export type ResolvedAction =
  | { kind: 'child'; label: string; argv: string[] }
  | { kind: 'chrome'; exe: string; args: string[] }
  | { kind: 'scan' };

export interface ActionRequestBody {
  armed?: boolean;
}

export interface ActionError {
  error: string;
  code: 400;
}

export interface ActionMeta {
  /** Human label for the button. Replaces the old kebab-case-to-Title-Case guess in the page. */
  label: string;
  /** 'live' means this action writes to Ramp/QuickBooks. Rendered as a danger button. */
  risk: 'safe' | 'live';
  /** True iff resolveAction rejects this action without `armed: true`. */
  requiresArm: boolean;
  /**
   * `api` means the action can complete on a machine with no browser available — no load-time
   * Playwright import in the module its argv targets, and no runtime spawn of a child that needs
   * one either (`run-sweep.ts` orchestrates browser-driving children via `runChild`, so it's
   * `browser` even though it never imports Playwright itself). `browser` means it drives a real
   * Chrome and cannot run on a headless server — vendor-portal bot protection is the usual reason,
   * but it also covers CDP-attach actions that launch Chrome directly with no Playwright import at
   * all (`chrome-walmart`, `chrome-amazon`).
   *
   * `api` is a necessary condition for running on Dokploy, not a sufficient one: a vendor portal
   * reachable over plain HTTP from a laptop may still reject a server IP, an unfamiliar ASN, or a
   * different rate limit. This tag narrows "which of these could possibly move?" down to "which
   * are worth actually testing there" — it does not answer that question by itself.
   */
  surface: 'browser' | 'api';
}

// Per README "Running it" / DS §3: same chrome.exe, same CDP port, distinct profile dirs so a
// Walmart-signed-in profile and an Amazon-Business-signed-in profile never collide.
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const cdpArgs = (profileDir: string): string[] => ['--remote-debugging-port=9222', `--user-data-dir=${profileDir}`];

type ActionBuilder = (body: ActionRequestBody) => ResolvedAction | ActionError;

interface ActionDef {
  meta: ActionMeta;
  build: ActionBuilder;
}

/** A read-only or dry-run action: no arming, rendered as an ordinary button. */
function safe(label: string, resolved: ResolvedAction, surface: 'browser' | 'api' = 'browser'): ActionDef {
  return { meta: { label, risk: 'safe', requiresArm: false, surface }, build: () => resolved };
}

/**
 * A writing action. This is the ONLY way to declare one, so `requiresArm: true` in the metadata
 * and the `armed !== true` rejection below can never disagree — the bug this replaces was the page
 * rendering these as plain buttons that always 400'd, because it had no way to know they differed.
 */
function live(name: string, label: string, resolved: ResolvedAction, surface: 'browser' | 'api' = 'browser'): ActionDef {
  return {
    meta: { label, risk: 'live', requiresArm: true, surface },
    build: (body) => (body.armed === true ? resolved : { error: `${name} requires armed:true`, code: 400 }),
  };
}

const ENTITIES = ['FL', 'TN', 'TX'] as const;

function perEntity(prefix: string, make: (entity: 'FL' | 'TN' | 'TX') => ActionDef): Record<string, ActionDef> {
  return Object.fromEntries(ENTITIES.map((e) => [`${prefix}-${e}`, make(e)]));
}

const REGISTRY: Record<string, ActionDef> = {
  ...perEntity('bootstrap-uline', (e) =>
    safe(`Bootstrap session — ${e}`, {
      kind: 'child',
      label: `ULINE bootstrap ${e}`,
      argv: ['engines/receipt-capture/uline-bootstrap.ts', `--entity=${e}`],
    })),

  'chrome-walmart': safe("Launch Chrome (Walmart / Sam's)", { kind: 'chrome', exe: CHROME_EXE, args: cdpArgs('C:\\wm-chrome-profile') }),
  'chrome-amazon': safe('Launch Chrome (Amazon Business)', { kind: 'chrome', exe: CHROME_EXE, args: cdpArgs('C:\\amz-chrome-profile') }),

  // run-extract-txns.ts (the Transactions-report extractor), not run-extract.ts (the older
  // Items-report one) -- DS addendum 2026-07-22 (main repo docs/amazon-receipt-capture): the
  // Transactions report is the charge-level source that pairs 1:1 with Ramp txns.
  ...perEntity('extract-amazon', (e) =>
    safe(`Extract transactions — ${e}`, {
      kind: 'child',
      label: `Amazon-CSV extract ${e}`,
      argv: ['engines/amazon-csv-enrich/run-extract-txns.ts', '--account', e],
    })),

  'fetch-invoices': safe('Fetch invoice PDFs', {
    kind: 'child',
    label: 'Amazon-CSV fetch invoices',
    argv: ['engines/amazon-csv-enrich/fetch-invoices.ts'],
  }),

  // run-attach.ts is dry unless --live is passed (README) — omitting it entirely is the dry mode.
  // Plain HTTP (Ramp API + local caches), no browser involved.
  'attach-amazon-csv-dry': safe('Attach receipts (dry run)', {
    kind: 'child',
    label: 'Amazon-CSV attach (dry)',
    argv: ['engines/amazon-csv-enrich/run-attach.ts'],
  }, 'api'),

  // Letco = the "invoice -> draft bill" job category: no Ramp card txns, no browser, no bootstrap.
  // Enrich GL-codes draft bills the bookkeeper already entered and creates nothing, so the dry
  // action is genuinely read-only and the live one cannot produce a duplicate bill. The Fagron Shop
  // portal is Sana Commerce on IIS and REJECTS headless Chromium (letco-http.ts), so it's driven
  // over plain HTTP with a cookie jar instead — hence `api`.
  'letco-enrich-dry': safe('Enrich bills (dry run)', {
    kind: 'child',
    label: 'Letco enrich (dry-run, all entities)',
    argv: ['engines/receipt-capture/run-letco.ts', '--entity=FL', '--mode=enrich'],
  }, 'api'),
  // Writes GL coding onto bills a human owns — same arming rule as the sweep.
  ...perEntity('letco-enrich', (e) =>
    live(`letco-enrich-${e}`, `Enrich bills — ${e}`, {
      kind: 'child',
      label: `Letco enrich ${e} (LIVE)`,
      argv: ['engines/receipt-capture/run-letco.ts', `--entity=${e}`, '--mode=enrich', '--live', '--limit', '50'],
    }, 'api')),

  // Medisca refresh is READ-ONLY (portal -> local cache, no Ramp/QB writes), so unlike every other
  // per-entity action it needs no arming — that safety-by-construction is the point of the cache
  // seam. Enrich/create dry-runs are also unarmed; the LIVE variants require armed:true.
  //
  // Despite "portal" in the name, medisca-session.ts drives it entirely over HTTP: NextAuth
  // credentials login (fetch to /api/auth/csrf + /api/auth/callback/credentials) plus a cookie jar,
  // no Playwright anywhere in the chain — its own header comment says "NO BROWSER and no captcha".
  // So every medisca-* action here is `api`, same as Letco, just for a different reason (no bot
  // wall encountered rather than one actively evaded).
  ...perEntity('medisca-refresh', (e) =>
    safe(`Refresh cache — ${e}`, {
      kind: 'child',
      label: `Medisca refresh ${e} (read-only)`,
      argv: ['engines/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=refresh'],
    }, 'api')),
  'medisca-enrich-dry': safe('Enrich bills (dry run)', {
    kind: 'child',
    label: 'Medisca enrich (dry-run)',
    argv: ['engines/receipt-capture/run-medisca.ts', '--entity=FL', '--mode=enrich'],
  }, 'api'),
  'medisca-create-dry': safe('Create bills (dry run)', {
    kind: 'child',
    label: 'Medisca create (dry-run)',
    argv: ['engines/receipt-capture/run-medisca.ts', '--entity=FL', '--mode=create'],
  }, 'api'),
  ...perEntity('medisca-enrich', (e) =>
    live(`medisca-enrich-${e}`, `Enrich bills — ${e}`, {
      kind: 'child',
      label: `Medisca enrich ${e} (LIVE)`,
      argv: ['engines/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=enrich', '--live', '--limit', '50'],
    }, 'api')),
  ...perEntity('medisca-create', (e) =>
    live(`medisca-create-${e}`, `Create bills — ${e}`, {
      kind: 'child',
      label: `Medisca create ${e} (LIVE)`,
      argv: ['engines/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=create', '--live', '--limit', '10'],
    }, 'api')),

  'sweep-dry': safe('Dry run', {
    kind: 'child',
    label: 'Sweep (dry-run)',
    argv: ['engines/receipt-capture/run-sweep.ts', '--dry-run'],
  }),
  // run-sweep.ts is LIVE BY DEFAULT (README) — the panel's own arming gate is the only thing
  // standing between a stray click and an uncapped live run, so it's enforced here, not just in
  // the UI. armed is never forwarded into argv; the resolved argv is identical to the terminal's
  // own default invocation.
  'sweep-live': live('sweep-live', 'Run LIVE sweep', {
    kind: 'child',
    label: 'Sweep (LIVE)',
    argv: ['engines/receipt-capture/run-sweep.ts'],
  }),

  // Read-only refresh of open-receiptless counts, per DS §3 — no child process, no files written.
  'scan-only': safe('Scan (refresh counts)', { kind: 'scan' }, 'api'),
};

export const ACTION_NAMES: readonly string[] = Object.keys(REGISTRY);

/** Presentation metadata for every action, derived from the same definitions that enforce arming. */
export const ACTION_META: Readonly<Record<string, ActionMeta>> = Object.freeze(
  Object.fromEntries(Object.entries(REGISTRY).map(([name, def]) => [name, def.meta])),
);

export function resolveAction(name: string, body: ActionRequestBody = {}): ResolvedAction | ActionError {
  const def = REGISTRY[name];
  if (!def) return { error: `unknown action: ${name}`, code: 400 };
  return def.build(body);
}
