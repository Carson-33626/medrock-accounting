import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTopRx, checkUline, checkCdp } from './sweep-preflight';

describe('checkTopRx', () => {
  it('lists only entities with both cred vars', () => {
    const env = { TopRX_FL: 'u', TopRX_FL_Pass: 'p', TopRX_TN: 'u' } as NodeJS.ProcessEnv;
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
  it('detects per-entity state files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uline-state-'));
    writeFileSync(join(dir, 'uline-FL.json'), '{}');
    const r = checkUline(dir);
    expect(r.entities).toEqual(['FL']);
    expect(r.needsYou).toContain('uline-bootstrap.ts --entity=TN');
  });
});

describe('checkCdp', () => {
  it('returns unreachable (not a throw) for a dead port', async () => {
    const r = await checkCdp('http://127.0.0.1:59999', 300);
    expect(r.reachable).toBe(false);
  });
});
