import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decryptSensitive } from './crypto';

const key = readFileSync(resolve(__dirname, 'fixtures/test-key.txt'), 'utf8').trim();
const rows = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/payroll_history.fixture.json'), 'utf8')) as Array<{ sensitive_encrypted: string }>;

describe('decryptSensitive', () => {
  it('decrypts a fixture row into ADP-keyed JSON', () => {
    const obj = decryptSensitive(rows[0].sensitive_encrypted, key);
    expect(obj).toHaveProperty('GROSS PAY');
    expect(typeof obj['GROSS PAY'] === 'number' || obj['GROSS PAY'] === null).toBe(true);
  });
  it('throws on a tampered blob (GCM tag fails)', () => {
    const raw = Buffer.from(rows[0].sensitive_encrypted, 'base64');
    raw[raw.length - 1] ^= 0xff; // corrupt tag
    expect(() => decryptSensitive(raw.toString('base64'), key)).toThrow();
  });
});
