import { describe, it, expect, beforeAll } from 'vitest';
import { signRemovalToken, verifyRemovalToken, REMOVAL_TOKEN_TTL_MS } from './removalToken';

beforeAll(() => {
  process.env.DEPOSIT_REMOVE_SECRET = 'test-secret-do-not-use-in-production';
});

const FILE = 'drive-file-abc';
const USER = 'user-123';

describe('removal token', () => {
  it('verifies a token it just signed', () => {
    const token = signRemovalToken(FILE, USER);
    expect(verifyRemovalToken(token, FILE, USER)).toBe(true);
  });

  it('rejects a token for a different file', () => {
    const token = signRemovalToken(FILE, USER);
    expect(verifyRemovalToken(token, 'other-file', USER)).toBe(false);
  });

  it('rejects a token for a different user', () => {
    const token = signRemovalToken(FILE, USER);
    expect(verifyRemovalToken(token, FILE, 'other-user')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = signRemovalToken(FILE, USER);
    const [issuedAt, sig] = token.split('.');
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    expect(verifyRemovalToken(`${issuedAt}.${flipped}`, FILE, USER)).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    const token = signRemovalToken(FILE, USER);
    const [issuedAt] = token.split('.');
    expect(verifyRemovalToken(`${issuedAt}.deadbeef`, FILE, USER)).toBe(false);
  });

  it('rejects non-canonical issuedAt encodings', () => {
    const token = signRemovalToken(FILE, USER, 1_000_000);
    const [, sig] = token.split('.');
    for (const variant of ['01000000', ' 1000000', '+1000000', '1000000xyz']) {
      expect(verifyRemovalToken(`${variant}.${sig}`, FILE, USER, 1_000_100)).toBe(false);
    }
  });

  it('rejects signatures with trailing junk', () => {
    const token = signRemovalToken(FILE, USER);
    expect(verifyRemovalToken(`${token}zzzz`, FILE, USER)).toBe(false);
    expect(verifyRemovalToken(`${token}a`, FILE, USER)).toBe(false);
  });

  it('rejects a tampered issuedAt', () => {
    const token = signRemovalToken(FILE, USER, 1_000_000);
    const [, sig] = token.split('.');
    expect(verifyRemovalToken(`2000000.${sig}`, FILE, USER, 2_000_100)).toBe(false);
  });

  it('rejects an expired token', () => {
    const issuedAt = 1_000_000;
    const token = signRemovalToken(FILE, USER, issuedAt);
    expect(verifyRemovalToken(token, FILE, USER, issuedAt + REMOVAL_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it('accepts a token just inside the window', () => {
    const issuedAt = 1_000_000;
    const token = signRemovalToken(FILE, USER, issuedAt);
    expect(verifyRemovalToken(token, FILE, USER, issuedAt + REMOVAL_TOKEN_TTL_MS - 1)).toBe(true);
  });

  it('treats exactly-TTL as expired', () => {
    const issuedAt = 1_000_000;
    const token = signRemovalToken(FILE, USER, issuedAt);
    expect(verifyRemovalToken(token, FILE, USER, issuedAt + REMOVAL_TOKEN_TTL_MS)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyRemovalToken('', FILE, USER)).toBe(false);
    expect(verifyRemovalToken('garbage', FILE, USER)).toBe(false);
    expect(verifyRemovalToken('abc.def.ghi', FILE, USER)).toBe(false);
  });
});
