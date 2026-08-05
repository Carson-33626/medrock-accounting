// web/scripts/receipt-capture/sweep-ui-actions.ts
//
// Closed action registry for the Sweep Control Panel (DS 2026-07-29, §2-§3): every button in the
// page maps to exactly one entry here, and every entry's argv/exe/args is a HARD-CODED literal —
// resolveAction takes only an action NAME (looked up in this fixed set) plus an `armed` flag for
// the one action that needs it. No caller-supplied string, path, or flag from the client ever
// reaches an argv array. Unknown name -> 400. sweep-live without armed:true -> 400. There is no
// fallthrough "build argv from the request" path anywhere in this module.
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

// Per README "Running it" / DS §3: same chrome.exe, same CDP port, distinct profile dirs so a
// Walmart-signed-in profile and an Amazon-Business-signed-in profile never collide.
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const cdpArgs = (profileDir: string): string[] => ['--remote-debugging-port=9222', `--user-data-dir=${profileDir}`];

type ActionBuilder = (body: ActionRequestBody) => ResolvedAction | ActionError;

const REGISTRY: Record<string, ActionBuilder> = {
  'bootstrap-uline-FL': () => ({ kind: 'child', label: 'ULINE bootstrap FL', argv: ['scripts/receipt-capture/uline-bootstrap.ts', '--entity=FL'] }),
  'bootstrap-uline-TN': () => ({ kind: 'child', label: 'ULINE bootstrap TN', argv: ['scripts/receipt-capture/uline-bootstrap.ts', '--entity=TN'] }),
  'bootstrap-uline-TX': () => ({ kind: 'child', label: 'ULINE bootstrap TX', argv: ['scripts/receipt-capture/uline-bootstrap.ts', '--entity=TX'] }),
  'chrome-walmart': () => ({ kind: 'chrome', exe: CHROME_EXE, args: cdpArgs('C:\\wm-chrome-profile') }),
  'chrome-amazon': () => ({ kind: 'chrome', exe: CHROME_EXE, args: cdpArgs('C:\\amz-chrome-profile') }),
  // run-extract-txns.ts (the Transactions-report extractor), not run-extract.ts (the older
  // Items-report one) -- DS addendum 2026-07-22 (main repo docs/amazon-receipt-capture): the
  // Transactions report is the charge-level source that pairs 1:1 with Ramp txns.
  'extract-amazon-FL': () => ({ kind: 'child', label: 'Amazon-CSV extract FL', argv: ['scripts/amazon-csv-enrich/run-extract-txns.ts', '--account', 'FL'] }),
  'extract-amazon-TN': () => ({ kind: 'child', label: 'Amazon-CSV extract TN', argv: ['scripts/amazon-csv-enrich/run-extract-txns.ts', '--account', 'TN'] }),
  'extract-amazon-TX': () => ({ kind: 'child', label: 'Amazon-CSV extract TX', argv: ['scripts/amazon-csv-enrich/run-extract-txns.ts', '--account', 'TX'] }),
  'fetch-invoices': () => ({ kind: 'child', label: 'Amazon-CSV fetch invoices', argv: ['scripts/amazon-csv-enrich/fetch-invoices.ts'] }),
  // run-attach.ts is dry unless --live is passed (README) — omitting it entirely is the dry mode.
  'attach-amazon-csv-dry': () => ({ kind: 'child', label: 'Amazon-CSV attach (dry)', argv: ['scripts/amazon-csv-enrich/run-attach.ts'] }),
  // Letco = the "invoice -> draft bill" job category: no Ramp card txns, no browser, no bootstrap.
  // Enrich GL-codes draft bills the bookkeeper already entered and creates nothing, so the dry
  // action is genuinely read-only and the live one cannot produce a duplicate bill.
  'letco-enrich-dry': () => ({ kind: 'child', label: 'Letco enrich (dry-run, all entities)', argv: ['scripts/receipt-capture/run-letco.ts', '--entity=FL', '--mode=enrich'] }),
  ...Object.fromEntries((['FL', 'TN', 'TX'] as const).map((e) => [
    `letco-enrich-${e}`,
    // Armed like sweep-live: this one writes GL coding onto bills a human owns. Same rule as the
    // sweep gate — enforced here, not only in the UI, so a stray POST cannot skip it.
    ((body: ActionRequestBody) => {
      if (body.armed !== true) return { error: `letco-enrich-${e} requires armed:true`, code: 400 };
      return { kind: 'child', label: `Letco enrich ${e} (LIVE)`, argv: ['scripts/receipt-capture/run-letco.ts', `--entity=${e}`, '--mode=enrich', '--live', '--limit', '50'] };
    }) as ActionBuilder,
  ])),
  // Medisca refresh is READ-ONLY (portal -> local cache, no Ramp/QB writes), so unlike every other
  // per-entity action it needs no arming — that safety-by-construction is the point of the cache
  // seam. Enrich/create dry-runs are also unarmed; the LIVE variants require armed:true.
  ...Object.fromEntries((['FL', 'TN', 'TX'] as const).map((e) => [
    `medisca-refresh-${e}`,
    (() => ({ kind: 'child', label: `Medisca refresh ${e} (read-only)`, argv: ['scripts/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=refresh'] })) as ActionBuilder,
  ])),
  'medisca-enrich-dry': () => ({ kind: 'child', label: 'Medisca enrich (dry-run)', argv: ['scripts/receipt-capture/run-medisca.ts', '--entity=FL', '--mode=enrich'] }),
  'medisca-create-dry': () => ({ kind: 'child', label: 'Medisca create (dry-run)', argv: ['scripts/receipt-capture/run-medisca.ts', '--entity=FL', '--mode=create'] }),
  ...Object.fromEntries((['FL', 'TN', 'TX'] as const).flatMap((e) => [
    [`medisca-enrich-${e}`, ((body: ActionRequestBody) => {
      if (body.armed !== true) return { error: `medisca-enrich-${e} requires armed:true`, code: 400 };
      return { kind: 'child', label: `Medisca enrich ${e} (LIVE)`, argv: ['scripts/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=enrich', '--live', '--limit', '50'] };
    }) as ActionBuilder],
    [`medisca-create-${e}`, ((body: ActionRequestBody) => {
      if (body.armed !== true) return { error: `medisca-create-${e} requires armed:true`, code: 400 };
      return { kind: 'child', label: `Medisca create ${e} (LIVE)`, argv: ['scripts/receipt-capture/run-medisca.ts', `--entity=${e}`, '--mode=create', '--live', '--limit', '10'] };
    }) as ActionBuilder],
  ])),
  'sweep-dry': () => ({ kind: 'child', label: 'Sweep (dry-run)', argv: ['scripts/receipt-capture/run-sweep.ts', '--dry-run'] }),
  // run-sweep.ts is LIVE BY DEFAULT (README) — the panel's own arming gate is the only thing
  // standing between a stray click and an uncapped live run, so it's enforced here, not just in
  // the UI. armed is never forwarded into argv; the resolved argv is identical to the terminal's
  // own default invocation.
  'sweep-live': (body) => {
    if (body.armed !== true) return { error: 'sweep-live requires armed:true', code: 400 };
    return { kind: 'child', label: 'Sweep (LIVE)', argv: ['scripts/receipt-capture/run-sweep.ts'] };
  },
  // Read-only refresh of open-receiptless counts, per DS §3 — no child process, no files written.
  'scan-only': () => ({ kind: 'scan' }),
};

export const ACTION_NAMES: readonly string[] = Object.keys(REGISTRY);

export function resolveAction(name: string, body: ActionRequestBody = {}): ResolvedAction | ActionError {
  const builder = REGISTRY[name];
  if (!builder) return { error: `unknown action: ${name}`, code: 400 };
  return builder(body);
}
