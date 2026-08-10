import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { createOAuthState, verifyOAuthState, STATE_FAILURE_MESSAGE } from './quickbooks-oauth-state';

beforeAll(() => {
  process.env.QUICKBOOKS_OAUTH_STATE_SECRET = 'test-secret-not-a-real-one';
});

const NOW = 1_770_000_000_000;

describe('createOAuthState / verifyOAuthState — the happy path', () => {
  it('round-trips the location when the nonce cookie matches', () => {
    const { state, nonce } = createOAuthState('MedRock FL', NOW);
    expect(verifyOAuthState(state, nonce, NOW + 1000)).toEqual({ ok: true, location: 'MedRock FL' });
  });

  it('works for every configured location, including FOCAS', () => {
    for (const loc of ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'] as const) {
      const { state, nonce } = createOAuthState(loc, NOW);
      expect(verifyOAuthState(state, nonce, NOW)).toEqual({ ok: true, location: loc });
    }
  });

  it('mints a different state every time, so one cannot be reused for the next connect', () => {
    const a = createOAuthState('MedRock TN', NOW);
    const b = createOAuthState('MedRock TN', NOW);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

/**
 * These are the attack this module exists to stop. Each case is a way an attacker could try to
 * bind THEIR QuickBooks realm into one of our four company slots.
 */
describe('verifyOAuthState — CSRF defences', () => {
  it('REJECTS the old format: a bare location key as state', () => {
    // Exactly what an attacker would guess, and exactly what we used to send.
    expect(verifyOAuthState('MedRock FL', 'anything', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('REJECTS a state we did not sign', () => {
    const payload = Buffer.from(`MedRock FL|attacker-nonce|${NOW + 60_000}`, 'utf8').toString('base64url');
    const forged = `${payload}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
    expect(verifyOAuthState(forged, 'attacker-nonce', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('REJECTS a validly-signed state replayed from a browser that did not start the flow', () => {
    // The attacker has a real state (browser history, a leaked referrer) but cannot produce the
    // httpOnly nonce cookie that went with it.
    const { state } = createOAuthState('MedRock TX', NOW);
    expect(verifyOAuthState(state, 'some-other-browsers-nonce', NOW)).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('REJECTS when the nonce cookie is absent entirely', () => {
    const { state } = createOAuthState('MedRock TX', NOW);
    expect(verifyOAuthState(state, undefined, NOW)).toEqual({ ok: false, reason: 'missing_cookie' });
    expect(verifyOAuthState(state, null, NOW)).toEqual({ ok: false, reason: 'missing_cookie' });
    expect(verifyOAuthState(state, '', NOW)).toEqual({ ok: false, reason: 'missing_cookie' });
  });

  it('REJECTS a tampered location — the signature covers the whole payload', () => {
    const { state, nonce } = createOAuthState('FOCAS', NOW);
    const [payload, sig] = state.split('.');
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const swapped = Buffer.from(decoded.replace('FOCAS', 'MedRock FL'), 'utf8').toString('base64url');
    expect(verifyOAuthState(`${swapped}.${sig}`, nonce, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('REJECTS an expired state', () => {
    const { state, nonce } = createOAuthState('MedRock FL', NOW);
    expect(verifyOAuthState(state, nonce, NOW + 11 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts right up to the expiry boundary but not past it', () => {
    const { state, nonce } = createOAuthState('MedRock FL', NOW);
    const expiry = NOW + 10 * 60 * 1000;
    expect(verifyOAuthState(state, nonce, expiry)).toEqual({ ok: true, location: 'MedRock FL' });
    expect(verifyOAuthState(state, nonce, expiry + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('REJECTS missing / empty / structurally broken states', () => {
    expect(verifyOAuthState(null, 'n', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyOAuthState('', 'n', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyOAuthState('.abc', 'n', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyOAuthState('abc.', 'n', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyOAuthState('no-dot-at-all', 'n', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('REJECTS a correctly-signed state naming a location we do not have', () => {
    // Guards the case where LOCATION_MAPPING shrinks but an old state is still in flight.
    const { state, nonce } = createOAuthState('MedRock FL', NOW);
    const [payload] = state.split('.');
    const decoded = Buffer.from(payload, 'base64url').toString('utf8').replace('MedRock FL', 'MedRock ZZ');
    // Re-sign it so this tests the location check, not the signature check.
    const repacked = Buffer.from(decoded, 'utf8').toString('base64url');
    const sig = createHmac('sha256', process.env.QUICKBOOKS_OAUTH_STATE_SECRET as string)
      .update(repacked)
      .digest('base64url');
    expect(verifyOAuthState(`${repacked}.${sig}`, nonce, NOW)).toEqual({ ok: false, reason: 'unknown_location' });
  });
});

describe('STATE_FAILURE_MESSAGE', () => {
  it('covers every failure reason', () => {
    const reasons = ['malformed', 'bad_signature', 'expired', 'unknown_location', 'missing_cookie', 'nonce_mismatch'] as const;
    for (const r of reasons) expect(STATE_FAILURE_MESSAGE[r]).toBeTruthy();
  });

  it('does not leak WHY verification failed to the browser', () => {
    // A forged state and a tampered one must look identical from outside — telling an attacker
    // which check they failed is a free oracle for iterating.
    expect(STATE_FAILURE_MESSAGE.bad_signature).toBe(STATE_FAILURE_MESSAGE.nonce_mismatch);
    expect(STATE_FAILURE_MESSAGE.malformed).toBe(STATE_FAILURE_MESSAGE.bad_signature);
  });
});
