import crypto from 'node:crypto';

/**
 * Scoped undo tokens for the deposit portal (spec §9.1).
 *
 * The service account can write anywhere under Deposit Slips, so the remove
 * route must never trust a bare Drive file id from the client. The upload
 * response hands back one of these per file; the remove route recomputes the
 * HMAC from the *session's* user id and refuses anything that does not match.
 *
 * Token format: `{issuedAt}.{hex hmac}` — self-proving, so no DB table is needed.
 * Both fields must be canonical (issuedAt: decimal digits with no leading
 * zeros, sign, or whitespace; hmac: exactly 64 lowercase hex chars) — no
 * trailing junk either — so a given issued token has exactly one valid
 * string representation.
 */

export const REMOVAL_TOKEN_TTL_MS = 3_600_000; // 1 hour

function secret(): string {
  const value = process.env.DEPOSIT_REMOVE_SECRET;
  if (!value) throw new Error('Missing DEPOSIT_REMOVE_SECRET environment variable');
  return value;
}

function sign(fileId: string, userId: string, issuedAt: number): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${fileId}:${userId}:${issuedAt}`)
    .digest('hex');
}

export function signRemovalToken(fileId: string, userId: string, issuedAt: number = Date.now()): string {
  return `${issuedAt}.${sign(fileId, userId, issuedAt)}`;
}

export function verifyRemovalToken(
  token: string,
  fileId: string,
  userId: string,
  now: number = Date.now()
): boolean {
  if (typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [issuedAtRaw, provided] = parts;
  if (!/^(0|[1-9]\d*)$/.test(issuedAtRaw)) return false;
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) return false;

  if (now - issuedAt >= REMOVAL_TOKEN_TTL_MS) return false;
  if (now < issuedAt) return false; // clock skew / forged future timestamp

  const expected = sign(fileId, userId, issuedAt);

  // Constant-time compare; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;

  return crypto.timingSafeEqual(a, b);
}
