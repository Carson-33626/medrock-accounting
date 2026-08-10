import { describe, it, expect } from 'vitest';
import { resolveAction, ACTION_NAMES, ACTION_META } from './actions';
import type { ResolvedAction, ActionError, ActionRequestBody } from './actions';

function isError(r: ResolvedAction | ActionError): r is ActionError {
  return 'error' in r;
}

describe('resolveAction — closed registry', () => {
  it('every declared action name resolves to a non-error action (except sweep-live unarmed)', () => {
    for (const name of ACTION_NAMES) {
      const r = resolveAction(name, { armed: true });
      expect(isError(r), `${name} should resolve`).toBe(false);
    }
  });

  it('unknown action name is rejected with a 400', () => {
    const r = resolveAction('rm-rf-everything');
    expect(isError(r)).toBe(true);
    expect((r as ActionError).code).toBe(400);
  });

  it('sweep-live without armed:true is rejected with a 400, and does not resolve to a child', () => {
    const r = resolveAction('sweep-live', {});
    expect(isError(r)).toBe(true);
    expect((r as ActionError).code).toBe(400);
  });

  it('sweep-live with armed:true resolves to the plain default-invocation argv (armed never leaks into argv)', () => {
    const r = resolveAction('sweep-live', { armed: true });
    expect(r).toEqual({ kind: 'child', label: 'Sweep (LIVE)', argv: ['engines/receipt-capture/run-sweep.ts'] });
  });

  it('sweep-dry resolves to the --dry-run argv', () => {
    const r = resolveAction('sweep-dry');
    expect(r).toEqual({ kind: 'child', label: 'Sweep (dry-run)', argv: ['engines/receipt-capture/run-sweep.ts', '--dry-run'] });
  });

  it.each([
    ['bootstrap-uline-FL', '--entity=FL'],
    ['bootstrap-uline-TN', '--entity=TN'],
    ['bootstrap-uline-TX', '--entity=TX'],
  ])('%s resolves to uline-bootstrap.ts %s exactly', (name, flag) => {
    const r = resolveAction(name) as { kind: string; argv: string[] };
    expect(r.kind).toBe('child');
    expect(r.argv).toEqual(['engines/receipt-capture/uline-bootstrap.ts', flag]);
  });

  it('chrome-walmart resolves to the documented chrome.exe + CDP port + walmart profile dir', () => {
    const r = resolveAction('chrome-walmart') as { kind: string; exe: string; args: string[] };
    expect(r.kind).toBe('chrome');
    expect(r.exe).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(r.args).toEqual(['--remote-debugging-port=9222', '--user-data-dir=C:\\wm-chrome-profile']);
  });

  it('chrome-amazon resolves to the same chrome.exe + CDP port but a distinct amazon profile dir', () => {
    const r = resolveAction('chrome-amazon') as { kind: string; exe: string; args: string[] };
    expect(r.kind).toBe('chrome');
    expect(r.args).toEqual(['--remote-debugging-port=9222', '--user-data-dir=C:\\amz-chrome-profile']);
  });

  it.each([
    ['extract-amazon-FL', 'FL'],
    ['extract-amazon-TN', 'TN'],
    ['extract-amazon-TX', 'TX'],
  ])('%s resolves to run-extract-txns.ts --account %s exactly', (name, acct) => {
    const r = resolveAction(name) as { kind: string; argv: string[] };
    expect(r.argv).toEqual(['engines/amazon-csv-enrich/run-extract-txns.ts', '--account', acct]);
  });

  it('fetch-invoices resolves to fetch-invoices.ts with no extra flags', () => {
    const r = resolveAction('fetch-invoices') as { kind: string; argv: string[] };
    expect(r.argv).toEqual(['engines/amazon-csv-enrich/fetch-invoices.ts']);
  });

  it('attach-amazon-csv-dry resolves to run-attach.ts with no --live flag', () => {
    const r = resolveAction('attach-amazon-csv-dry') as { kind: string; argv: string[] };
    expect(r.argv).toEqual(['engines/amazon-csv-enrich/run-attach.ts']);
    expect(r.argv).not.toContain('--live');
  });

  it('scan-only resolves to a no-child scan action (no argv, no files written)', () => {
    const r = resolveAction('scan-only');
    expect(r).toEqual({ kind: 'scan' });
  });

  it('no builder ever echoes an arbitrary caller-supplied name/body field back into argv', () => {
    // Regression guard for the "closed set" safety property: passing extra junk on the body must
    // never surface anywhere in a resolved argv/args array. Typed as an intersection (junk field
    // is a real, declared property) rather than an `unknown` cast -- ActionRequestBody itself
    // never needs to know about it, but the test value stays fully typed.
    const junkBody: ActionRequestBody & { ['--rm']: boolean } = { armed: true, ['--rm']: true };
    const r = resolveAction('sweep-dry', junkBody);
    const argv = (r as { argv: string[] }).argv;
    expect(argv.join(' ')).not.toContain('rm');
  });
});

// ── ACTION_META (added 2026-08-07) ─────────────────────────────────────────────
//
// The bug this metadata exists to fix: the page rendered every action as an identical plain
// button, so the live ones (which require armed:true) returned HTTP 400 on every single click.
// The page now renders from ACTION_META, which makes these tests load-bearing — if the metadata
// disagreed with the actual gate, the panel would be back to showing buttons that cannot work.
describe('ACTION_META', () => {
  it('describes exactly the registered actions, no more and no fewer', () => {
    expect(Object.keys(ACTION_META).sort()).toEqual([...ACTION_NAMES].sort());
  });

  it('gives every action a non-empty, non-kebab label', () => {
    for (const name of ACTION_NAMES) {
      const meta = ACTION_META[name];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label).not.toBe(name);
    }
  });

  it('marks requiresArm on exactly the actions that reject an unarmed call', () => {
    for (const name of ACTION_NAMES) {
      const rejectsUnarmed = isError(resolveAction(name, {}));
      expect(`${name}:${ACTION_META[name].requiresArm}`).toBe(`${name}:${rejectsUnarmed}`);
    }
  });

  it("marks risk 'live' on exactly the actions that require arming", () => {
    for (const name of ACTION_NAMES) {
      const meta = ACTION_META[name];
      expect(`${name}:${meta.risk === 'live'}`).toBe(`${name}:${meta.requiresArm}`);
    }
  });

  it('resolves every live action once armed', () => {
    const live = ACTION_NAMES.filter((n) => ACTION_META[n].requiresArm);
    expect(live.length).toBeGreaterThan(0);
    for (const name of live) {
      expect(isError(resolveAction(name, { armed: true }))).toBe(false);
    }
  });

  it('resolves every safe action without arming', () => {
    for (const name of ACTION_NAMES.filter((n) => !ACTION_META[n].requiresArm)) {
      expect(isError(resolveAction(name, {}))).toBe(false);
    }
  });

  it('routes every child action at the program-relative engines/ path', () => {
    // Catches an action left pointing at a pre-flip (web/-relative) script path, which would fail
    // only at click time with a confusing "Cannot find module" in the console pane.
    for (const name of ACTION_NAMES) {
      const r = resolveAction(name, { armed: true });
      if (isError(r) || r.kind !== 'child') continue;
      expect(r.argv[0]).toMatch(/^engines\//);
    }
  });
});

// ── surface (added 2026-08-10) ──────────────────────────────────────────────
//
// 'browser' vs 'api' answers "what could move to a Dokploy agent": vendor-portal bot protection
// blocks anything that drives a real Chrome, but Ramp/QuickBooks/RDS work is plain HTTP and could
// run headless today. The classification below was verified against the code, not assumed from
// the vendor's name -- notably, Medisca reads "portal" in its labels but medisca-session.ts drives
// it entirely over HTTP (NextAuth credentials login + cookie jar, its own header comment says
// "NO BROWSER and no captcha"), so it lands in `api` alongside Letco rather than next to ULINE.
describe('action surface', () => {
  it('tags every action', () => {
    for (const name of ACTION_NAMES) {
      expect(['browser', 'api']).toContain(ACTION_META[name].surface);
    }
  });

  it('tags the actions that drive a real browser', () => {
    const browser = ACTION_NAMES.filter((n) => ACTION_META[n].surface === 'browser').sort();
    expect(browser).toEqual([
      'bootstrap-uline-FL', 'bootstrap-uline-TN', 'bootstrap-uline-TX',
      'chrome-amazon', 'chrome-walmart',
      'extract-amazon-FL', 'extract-amazon-TN', 'extract-amazon-TX',
      'fetch-invoices',
      'sweep-dry', 'sweep-live',
    ].sort());
  });

  it('tags the pure-API actions, which are the Dokploy candidates', () => {
    const api = ACTION_NAMES.filter((n) => ACTION_META[n].surface === 'api').sort();
    expect(api).toEqual([
      'attach-amazon-csv-dry',
      'letco-enrich-dry',
      'letco-enrich-FL', 'letco-enrich-TN', 'letco-enrich-TX',
      'medisca-create-dry',
      'medisca-create-FL', 'medisca-create-TN', 'medisca-create-TX',
      'medisca-enrich-dry',
      'medisca-enrich-FL', 'medisca-enrich-TN', 'medisca-enrich-TX',
      'medisca-refresh-FL', 'medisca-refresh-TN', 'medisca-refresh-TX',
      'scan-only',
    ].sort());
  });
});
