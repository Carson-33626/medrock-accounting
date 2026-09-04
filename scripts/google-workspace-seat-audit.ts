// READ-ONLY: Google Workspace per-user seat audit, reconciled against the QBO/Ramp billing.
//
// Pulls the Workspace user roster via the Admin Directory API (service account + domain-wide
// delegation, impersonating a Workspace admin) and lines it up against the Google Workspace
// invoices so "how much per month" can be answered per seat rather than per bill.
//
// Auth: GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 (the medrock-loader SA, DWD scope
//       admin.directory.user.readonly) + GOOGLE_ADMIN_DELEGATE_EMAIL (the admin to impersonate).
//       Directory reads REQUIRE impersonation — a bare service account has no domain to list.
//       Never logs the private key; the client_email/client_id it resolves are non-secret and are
//       printed so you can confirm which SA answered.
//
// Run from web/:  npx tsx scripts/google-workspace-seat-audit.ts
//   GOOGLE_DIRECTORY_ENV=<path>  load an additional .env (override) if the key lives in another repo
//   WORKSPACE_SEAT_PRICE=7.00    per-seat list price used for the reconciliation
import './lib/load-env';
import crypto from 'node:crypto';
import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXTRA_ENV = process.env.GOOGLE_DIRECTORY_ENV;
if (EXTRA_ENV && existsSync(EXTRA_ENV)) config({ path: EXTRA_ENV, override: true });

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1/users';
const SEAT_PRICE = Number(process.env.WORKSPACE_SEAT_PRICE ?? '7.00');
const OUT_DIR = join(process.cwd(), '..', 'docs', 'tech-spend-recon');

interface ServiceAccountKey {
  client_email: string;
  client_id?: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

function loadServiceAccount(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY_BASE64');
  const parsed = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf-8')) as Partial<ServiceAccountKey>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }
  return {
    client_email: parsed.client_email,
    client_id: parsed.client_id,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
    token_uri: parsed.token_uri,
  };
}

const b64url = (v: string): string => Buffer.from(v).toString('base64url');

async function getDirectoryToken(sa: ServiceAccountKey, delegate: string): Promise<string> {
  const aud = sa.token_uri ?? TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // `sub` is the impersonation claim — without it the Directory API has no domain context.
  const payload = b64url(
    JSON.stringify({ iss: sa.client_email, sub: delegate, scope: DIRECTORY_SCOPE, aud, iat: now, exp: now + 3600 }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString('base64url');

  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${body.error ?? ''} ${body.error_description ?? ''}\n` +
        `  SA=${sa.client_email} delegate=${delegate}\n` +
        `  If this is "unauthorized_client", the SA's client_id needs ${DIRECTORY_SCOPE} granted in\n` +
        `  Admin console -> Security -> Access and data control -> API controls -> Domain-wide delegation.`,
    );
  }
  return body.access_token;
}

interface DirectoryUser {
  primaryEmail?: string;
  name?: { fullName?: string; givenName?: string; familyName?: string };
  suspended?: boolean;
  archived?: boolean;
  orgUnitPath?: string;
  lastLoginTime?: string;
  creationTime?: string;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  isEnrolledIn2Sv?: boolean;
  isMailboxSetup?: boolean;
  aliases?: string[];
  suspensionReason?: string;
}
interface DirectoryPage {
  users?: DirectoryUser[];
  nextPageToken?: string;
}

async function listUsers(token: string): Promise<DirectoryUser[]> {
  const out: DirectoryUser[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 60; i++) {
    const params = new URLSearchParams({
      customer: 'my_customer',
      maxResults: '500',
      projection: 'full',
      orderBy: 'email',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${DIRECTORY_BASE}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Directory list failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
    }
    const body = (await res.json()) as DirectoryPage;
    out.push(...(body.users ?? []));
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // Google returns 1970-01-01T00:00:00.000Z for "never logged in".
  if (t <= 86_400_000) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function csvCell(s: string): string {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

async function main(): Promise<void> {
  const sa = loadServiceAccount();
  const delegate = process.env.GOOGLE_ADMIN_DELEGATE_EMAIL ?? 'd.carson@medrockpharmacy.com';
  console.log(`Service account : ${sa.client_email}`);
  console.log(`  client_id     : ${sa.client_id ?? '(not in key)'}`);
  console.log(`  project       : ${sa.project_id ?? '(not in key)'}`);
  console.log(`Impersonating   : ${delegate}`);
  console.log(`Scope           : ${DIRECTORY_SCOPE}\n`);

  const token = await getDirectoryToken(sa, delegate);
  const users = await listUsers(token);
  console.log(`Pulled ${users.length} directory users.\n`);

  // Google bills for every non-deleted user, INCLUDING suspended ones. Archived users move to a
  // cheaper Archived User licence, so they are counted separately rather than folded in.
  const billable = users.filter((u) => u.archived !== true);
  const active = billable.filter((u) => u.suspended !== true);
  const suspended = billable.filter((u) => u.suspended === true);
  const archived = users.filter((u) => u.archived === true);

  const byOu = new Map<string, DirectoryUser[]>();
  for (const u of active) {
    const ou = u.orgUnitPath ?? '/';
    const list = byOu.get(ou);
    if (list) list.push(u);
    else byOu.set(ou, [u]);
  }

  console.log('='.repeat(96));
  console.log('SEAT COUNT');
  console.log('='.repeat(96));
  console.log(`  Active (billable)        ${String(active.length).padStart(4)}   x $${SEAT_PRICE.toFixed(2)} = $${(active.length * SEAT_PRICE).toFixed(2)}/mo`);
  console.log(`  Suspended (STILL BILLED) ${String(suspended.length).padStart(4)}   x $${SEAT_PRICE.toFixed(2)} = $${(suspended.length * SEAT_PRICE).toFixed(2)}/mo`);
  console.log(`  Archived (separate SKU)  ${String(archived.length).padStart(4)}`);
  console.log(`  ${'-'.repeat(60)}`);
  console.log(`  Billable total           ${String(billable.length).padStart(4)}   x $${SEAT_PRICE.toFixed(2)} = $${(billable.length * SEAT_PRICE).toFixed(2)}/mo`);

  console.log('\n' + '='.repeat(96));
  console.log('BY ORG UNIT (active seats)');
  console.log('='.repeat(96));
  for (const [ou, list] of [...byOu.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${ou.padEnd(44)}${String(list.length).padStart(4)} seats   $${(list.length * SEAT_PRICE).toFixed(2)}/mo`);
  }

  const DORMANT_DAYS = 90;
  const dormant = active
    .map((u) => ({ u, d: daysSince(u.lastLoginTime) }))
    .filter((x) => x.d === null || x.d >= DORMANT_DAYS)
    .sort((a, b) => (b.d ?? 99999) - (a.d ?? 99999));

  console.log('\n' + '='.repeat(96));
  console.log(`RECLAIMABLE — active seats with no login in ${DORMANT_DAYS}+ days (or never)`);
  console.log('='.repeat(96));
  for (const { u, d } of dormant) {
    console.log(
      `  ${(u.primaryEmail ?? '').padEnd(42)}${(u.name?.fullName ?? '').slice(0, 24).padEnd(26)}` +
        `${(d === null ? 'NEVER' : `${d}d`).padStart(7)}   ${u.orgUnitPath ?? '/'}`,
    );
  }
  console.log(`  ${'-'.repeat(60)}`);
  console.log(`  ${dormant.length} seats = $${(dormant.length * SEAT_PRICE).toFixed(2)}/mo  ($${(dormant.length * SEAT_PRICE * 12).toFixed(2)}/yr)`);
  console.log(`  + ${suspended.length} suspended = $${(suspended.length * SEAT_PRICE).toFixed(2)}/mo  ($${(suspended.length * SEAT_PRICE * 12).toFixed(2)}/yr)`);

  mkdirSync(OUT_DIR, { recursive: true });
  const rows: string[] = [
    ['email', 'name', 'status', 'org_unit', 'last_login', 'days_since_login', 'created', '2sv', 'admin', 'seat_cost_month'].join(','),
  ];
  for (const u of users) {
    const d = daysSince(u.lastLoginTime);
    const status = u.archived === true ? 'archived' : u.suspended === true ? 'suspended' : 'active';
    rows.push(
      [
        u.primaryEmail ?? '',
        u.name?.fullName ?? '',
        status,
        u.orgUnitPath ?? '/',
        d === null ? 'never' : (u.lastLoginTime ?? '').slice(0, 10),
        d === null ? '' : String(d),
        (u.creationTime ?? '').slice(0, 10),
        u.isEnrolledIn2Sv === true ? 'yes' : 'no',
        u.isAdmin === true ? 'super' : u.isDelegatedAdmin === true ? 'delegated' : '',
        status === 'archived' ? '' : SEAT_PRICE.toFixed(2),
      ].map(csvCell).join(','),
    );
  }
  writeFileSync(join(OUT_DIR, 'google-workspace-seats.csv'), rows.join('\n'), 'utf8');
  console.log(`\nWrote ${join(OUT_DIR, 'google-workspace-seats.csv')} (${users.length} users)`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
