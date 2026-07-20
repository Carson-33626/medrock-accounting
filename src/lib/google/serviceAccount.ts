import crypto from 'node:crypto';

/**
 * Google service-account auth, zero external dependencies.
 *
 * Ported from `MedRock Auth Host/src/lib/google-admin.ts`, minus the `sub`
 * impersonation claim — this is a PLAIN service account. It works because the
 * target is a Shared Drive (a plain SA has no storage quota of its own and
 * would fail against My Drive). See spec §5.
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let cached: { token: string; expiresAt: number } | null = null;

function loadServiceAccount(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 environment variable');

  const json = Buffer.from(raw.trim(), 'base64').toString('utf-8');
  const parsed = JSON.parse(json) as Partial<ServiceAccountKey>;

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is missing client_email or private_key');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
}

const b64url = (value: string): string => Buffer.from(value).toString('base64url');

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const sa = loadServiceAccount();
  const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: sa.client_email, scope: DRIVE_SCOPE, aud, iat: now, exp: now + 3600 })
  );

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString('base64url');

  const response = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });

  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };

  if (!response.ok || !body.access_token) {
    throw new Error(`Google token exchange failed (${response.status}): ${body.error_description ?? 'unknown error'}`);
  }

  // Refresh 5 minutes early so an in-flight upload never races the expiry.
  cached = { token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000 };
  return cached.token;
}
