import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTopRx, checkUline, checkCdp } from './sweep-preflight';

describe('checkTopRx', () => {
  it('lists only entities with both cred vars', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TopRX_FL: 'u', TopRX_FL_Pass: 'p', TopRX_TN: 'u' };
    const r = checkTopRx(env);
    expect(r.entities).toEqual(['FL']);
    expect(r.available).toBe(true);
    expect(r.needsYou).toContain('TN');
  });
  it('unavailable with no creds at all', () => {
    const r = checkTopRx({} as NodeJS.ProcessEnv);
    expect(r.available).toBe(false);
  });
});

describe('checkUline', () => {
  it('FL session enables both FL and TN (joint account) with no separate TN bootstrap line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-state-'));
    writeFileSync(join(dir, 'uline-FL.json'), '{}');
    const r = checkUline(dir);
    expect(r.entities).toEqual(['FL', 'TN']);
    expect(r.available).toBe(true);
    expect(r.needsYou).toContain('uline-bootstrap.ts --entity=TX');
    expect(r.needsYou).not.toContain('--entity=TN');
  });
  it('missing FL session needsYou explains TN rides FL\'s session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-state-'));
    const r = checkUline(dir);
    expect(r.available).toBe(false);
    expect(r.entities).toEqual([]);
    expect(r.needsYou).toContain('uline-bootstrap.ts --entity=FL');
    expect(r.needsYou).toContain("TN rides FL's session");
  });
  it('TX session alone is independent of FL/TN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-state-'));
    writeFileSync(join(dir, 'uline-TX.json'), '{}');
    const r = checkUline(dir);
    expect(r.entities).toEqual(['TX']);
    expect(r.needsYou).toContain('--entity=FL');
    expect(r.needsYou).not.toContain('--entity=TX');
  });
});

describe('checkCdp', () => {
  it('returns unreachable (not a throw) for a dead port', async () => {
    const r = await checkCdp('http://127.0.0.1:59999', 300);
    expect(r.reachable).toBe(false);
  });
});
