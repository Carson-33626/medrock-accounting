import { describe, it, expect } from 'vitest';
import { resolveAction, ACTION_NAMES } from './sweep-ui-actions';
import type { ResolvedAction, ActionError, ActionRequestBody } from './sweep-ui-actions';

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
    expect(r).toEqual({ kind: 'child', label: 'Sweep (LIVE)', argv: ['scripts/receipt-capture/run-sweep.ts'] });
  });

  it('sweep-dry resolves to the --dry-run argv', () => {
    const r = resolveAction('sweep-dry');
    expect(r).toEqual({ kind: 'child', label: 'Sweep (dry-run)', argv: ['scripts/receipt-capture/run-sweep.ts', '--dry-run'] });
  });

  it.each([
    ['bootstrap-uline-FL', '--entity=FL'],
    ['bootstrap-uline-TN', '--entity=TN'],
    ['bootstrap-uline-TX', '--entity=TX'],
  ])('%s resolves to uline-bootstrap.ts %s exactly', (name, flag) => {
    const r = resolveAction(name) as { kind: string; argv: string[] };
    expect(r.kind).toBe('child');
    expect(r.argv).toEqual(['scripts/receipt-capture/uline-bootstrap.ts', flag]);
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
    expect(r.argv).toEqual(['scripts/amazon-csv-enrich/run-extract-txns.ts', '--account', acct]);
  });

  it('fetch-invoices resolves to fetch-invoices.ts with no extra flags', () => {
    const r = resolveAction('fetch-invoices') as { kind: string; argv: string[] };
    expect(r.argv).toEqual(['scripts/amazon-csv-enrich/fetch-invoices.ts']);
  });

  it('attach-amazon-csv-dry resolves to run-attach.ts with no --live flag', () => {
    const r = resolveAction('attach-amazon-csv-dry') as { kind: string; argv: string[] };
    expect(r.argv).toEqual(['scripts/amazon-csv-enrich/run-attach.ts']);
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
