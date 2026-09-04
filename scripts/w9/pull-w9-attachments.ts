/**
 * Pull returned Form W-9 PDFs out of the 2026-08-07 mass-request replies and file
 * them into the Google Drive "W-9s" folder.
 *
 *   npx tsx scripts/w9/pull-w9-attachments.ts --discover   # list candidate attachments, write nothing
 *   npx tsx scripts/w9/pull-w9-attachments.ts --dry-run    # resolve + report, write nothing
 *   npx tsx scripts/w9/pull-w9-attachments.ts              # download -> scripts/out/w9-pdfs -> Drive
 *
 * Companion doc: docs/accounting-requests/w9-responses.md (the response log this manifest mirrors).
 *
 * SETUP
 *   Reuses the existing `data-export-loader` OAuth client (the same Desktop-app client the
 *   data-loader and support-triage repos already use) — no new Cloud project needed. The
 *   cached tokens in those repos belong to other mailboxes and are NOT reused; only the
 *   client id/secret is shared, and you consent as yourself on first run.
 *
 *   Credentials are resolved in this order:
 *     1. $W9_GOOGLE_CREDENTIALS  - path to a Google `credentials.json`
 *     2. the known checked-in client paths (see CREDENTIAL_PATHS below)
 *     3. $W9_GOOGLE_CLIENT_ID + $W9_GOOGLE_CLIENT_SECRET, for a hand-made client
 *
 *   First run opens a browser for consent; the refresh token is cached at
 *   scripts/w9/.gmail-token.json (gitignored) so later runs are non-interactive.
 *
 * TWO THINGS THAT CAN BITE ON A REUSED CLIENT
 *   - The Drive API must be enabled in the client's project. Gmail already is; Drive may not
 *     be, since that client was built for mail export. A 403 on upload prints the enable link.
 *   - If the client's consent screen is still in "Testing", Google expires refresh tokens after
 *     7 days. The script then re-prompts for consent, which is a nuisance, not a failure.
 *
 * Drive needs the full `drive` scope, not `drive.file`: we upload INTO a pre-existing
 * folder this script did not create, which `drive.file` cannot address.
 *
 * Idempotent: a title already present in the destination folder is skipped, so re-running
 * after adding a manifest row only uploads the new rows.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------- manifest

/** Destination Drive folder: "W-9s" (already holds ~35 vendor W-9s). */
const DRIVE_FOLDER_ID = '11yOixC6y6-gnLcBVdiqqzAMulaSIDuMr';

/** Gmail query used by --discover to surface replies that may carry a W-9. */
const DISCOVER_QUERY = 'after:2026/08/07 -in:sent -in:draft has:attachment';

interface GmailSource {
  readonly kind: 'gmail';
  /** Gmail message id of the vendor's reply. */
  readonly messageId: string;
  /** Attachment filename exactly as the vendor sent it. */
  readonly filename: string;
}

interface LocalSource {
  readonly kind: 'local';
  /** Absolute path, or path relative to the user profile. */
  readonly path: string;
}

interface ManifestEntry {
  readonly vendor: string;
  readonly source: GmailSource | LocalSource;
  /** Filename written to disk and to Drive. Normalised so the folder sorts by vendor. */
  readonly outputName: string;
  readonly note?: string;
}

const MANIFEST: readonly ManifestEntry[] = [
  {
    vendor: 'First Orion Corp',
    source: { kind: 'gmail', messageId: '19fde248643bb0d2', filename: 'W-9 - First Orion Corp._2026-Signed.pdf' },
    outputName: 'First Orion Corp - W-9 2026.pdf',
  },
  {
    vendor: 'Real Value Products Corp',
    source: { kind: 'gmail', messageId: '19fde25e5911eb12', filename: 'W-9 2026.pdf' },
    outputName: 'Real Value Products Corp - W-9 2026.pdf',
  },
  {
    vendor: 'United States Plastic Corp',
    source: { kind: 'gmail', messageId: '19fde26673e1f18d', filename: '8726.pdf' },
    outputName: 'United States Plastic Corp - W-9 2026.pdf',
    note: 'vendor named the file by their own doc number, not "W-9"',
  },
  {
    vendor: 'Cosmetic Packaging Now',
    source: { kind: 'gmail', messageId: '19fde2809f7c2350', filename: 'CPN W9 2026.pdf' },
    outputName: 'Cosmetic Packaging Now - W-9 2026.pdf',
  },
  {
    vendor: 'Medisca',
    source: { kind: 'gmail', messageId: '19fde1cd01f71af8', filename: 'W9 2026 new address 18030822280.pdf' },
    outputName: 'Medisca - W-9 2026.pdf',
    note: 'NEW ADDRESS on this W-9 - update the QBO + Ramp vendor record',
  },
  {
    vendor: 'PC Liquidations',
    source: { kind: 'gmail', messageId: '19feba7d657bc8dd', filename: '2026 W-9 (10).pdf' },
    outputName: 'PC Liquidations - W-9 2026.pdf',
  },
  {
    vendor: 'Chattanooga Gas (Southern Co)',
    source: { kind: 'gmail', messageId: '19feb887a5f2c9eb', filename: '2026 CGC W-9.pdf' },
    outputName: 'Chattanooga Gas - W-9 2026.pdf',
    note: 'arrives as application/octet-stream, not application/pdf',
  },
  {
    vendor: 'Salesforce',
    source: { kind: 'gmail', messageId: '19fea84dce873b88', filename: 'W-9 SFDC 2026 AMER.pdf' },
    outputName: 'Salesforce - W-9 2026.pdf',
    note: 'replied on their own subject line, not the W-9 thread',
  },
  {
    vendor: 'ADP',
    source: { kind: 'local', path: 'Downloads/ADP 2026 W9 FORM(1).pdf' },
    outputName: 'ADP - W-9 2026.pdf',
    note: 'ADP refuses email attachments; delivered via ShareFile and downloaded by hand',
  },
];

// ---------------------------------------------------------------- google api types

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

interface CachedToken {
  refresh_token: string;
  obtained_at: string;
}

/** Shape of a Google `credentials.json`; desktop clients nest under `installed`. */
interface GoogleCredentialsFile {
  installed?: { client_id: string; client_secret: string; project_id?: string };
  web?: { client_id: string; client_secret: string; project_id?: string };
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  origin: string;
}

interface GmailBody {
  attachmentId?: string;
  size?: number;
  data?: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: GmailBody;
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: GmailPart;
}

interface GmailAttachment {
  size: number;
  data: string;
}

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------- env + oauth

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * Scopes are requested per-mode, not all at once. Google rejects the whole consent request with a
 * bare "Error 400: invalid_request" if ANY requested scope is unconfigured on the client's consent
 * screen — and because that rejection happens before the redirect, the loopback handler never sees
 * a reason. Splitting them means a Drive misconfiguration cannot block the Gmail download, and the
 * failing half identifies itself.
 */
function scopesFor(needsDrive: boolean): string {
  return needsDrive ? `${GMAIL_SCOPE} ${DRIVE_SCOPE}` : GMAIL_SCOPE;
}

/** Tokens are cached per scope set; a Gmail-only grant must not satisfy a run that needs Drive. */
function tokenPathFor(needsDrive: boolean): string {
  return resolve(__dirname, needsDrive ? '.google-token-gmail-drive.json' : '.google-token-gmail.json');
}

const OUT_DIR = resolve(__dirname, '..', 'out', 'w9-pdfs');

/** `Active Development/` — the sibling-repo root the shared OAuth client lives under. */
const REPOS_ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * Known checked-in copies of the `data-export-loader` Desktop client, in preference order.
 * All three are byte-identical clients; the list is only for resilience if a repo moves.
 */
const CREDENTIAL_PATHS: readonly string[] = [
  resolve(REPOS_ROOT, 'MedRock Auth Host', 'Keys', 'gmail_credentials.json'),
  resolve(REPOS_ROOT, 'MedRock-Data-Loader', 'Keys', 'gmail_credentials.json'),
  resolve(REPOS_ROOT, 'medrock-support-triage', 'Keys', 'gmail_credentials.json'),
];

function loadEnv(): void {
  for (const rel of ['.env.local', '.env.vercel']) {
    const path = resolve(__dirname, '..', '..', rel);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function readCredentialsFile(path: string): ClientCredentials {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GoogleCredentialsFile;
  const client = parsed.installed ?? parsed.web;
  if (!client?.client_id || !client.client_secret) {
    throw new Error(`${path} is not a Google credentials.json (no "installed"/"web" client).`);
  }
  const kind = parsed.installed ? 'desktop' : 'web';
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    origin: `${path} (${kind} client, project ${client.project_id ?? 'unknown'})`,
  };
}

/** Env-var override -> known shared client -> explicit id/secret pair. */
function loadClientCredentials(): ClientCredentials {
  const override = process.env.W9_GOOGLE_CREDENTIALS;
  if (override) {
    if (!existsSync(override)) throw new Error(`W9_GOOGLE_CREDENTIALS points at a missing file: ${override}`);
    return readCredentialsFile(override);
  }

  for (const path of CREDENTIAL_PATHS) {
    if (existsSync(path)) return readCredentialsFile(path);
  }

  const clientId = process.env.W9_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.W9_GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, origin: 'W9_GOOGLE_CLIENT_ID / W9_GOOGLE_CLIENT_SECRET' };
  }

  throw new Error(
    'No Google OAuth client found. Expected one of:\n' +
      CREDENTIAL_PATHS.map((p) => `  - ${p}`).join('\n') +
      '\nor set W9_GOOGLE_CREDENTIALS to a credentials.json, or W9_GOOGLE_CLIENT_ID + W9_GOOGLE_CLIENT_SECRET.',
  );
}

/** Abandon a consent that never comes back, rather than holding the port open indefinitely. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the desktop loopback consent flow and returns the refresh token.
 *
 * Binds port 0 (OS-assigned) rather than a fixed port: when Google rejects a request outright it
 * never redirects, so a fixed port would stay held by the stalled process and every later run
 * would die on EADDRINUSE. Installed-app clients accept any loopback port, so this costs nothing.
 */
async function consent(clientId: string, clientSecret: string, needsDrive: boolean): Promise<string> {
  const scopes = scopesFor(needsDrive);
  console.log(`Requesting scopes: ${scopes}`);

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolveCode, rejectCode) => {
      let base = 'http://127.0.0.1';
      let timer: NodeJS.Timeout | undefined;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', base);
        const received = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const description = url.searchParams.get('error_description');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          received
            ? '<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>'
            : `<h2>Authorization failed</h2><p>${error ?? 'no code returned'}</p><p>${description ?? ''}</p>`,
        );
        if (timer) clearTimeout(timer);
        server.close();
        if (received) resolveCode({ code: received, redirectUri: base });
        else {
          rejectCode(
            new Error(`OAuth failed: ${error ?? 'no code returned'}${description ? ` — ${description}` : ''}`),
          );
        }
      });

      // Loopback only: never expose the callback listener beyond this machine.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          rejectCode(new Error('Could not determine the callback port.'));
          return;
        }
        base = `http://127.0.0.1:${address.port}`;
        const authUrl =
          'https://accounts.google.com/o/oauth2/v2/auth' +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(base)}` +
          '&response_type=code' +
          `&scope=${encodeURIComponent(scopes)}` +
          '&access_type=offline&prompt=consent';

        console.log(`\nOpening the consent screen. If it does not open, paste this into a browser:\n${authUrl}\n`);
        console.log(
          'If Google shows "Error 400" instead of a consent screen, the request was rejected before\n' +
            'it could redirect here, so this script never sees a reason. Expand "Error details" on that\n' +
            'page — it names the actual fault (invalid_scope, redirect_uri_mismatch, invalid_client...).\n',
        );
        spawn('cmd', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' }).unref();

        timer = setTimeout(() => {
          server.close();
          rejectCode(
            new Error(
              `No callback within ${CONSENT_TIMEOUT_MS / 60_000} min. If the browser showed an error ` +
                'instead of a consent screen, that error is the real fault — see the note above.',
            ),
          );
        }, CONSENT_TIMEOUT_MS);
      });

      server.on('error', rejectCode);
    },
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const token = (await res.json()) as TokenResponse;
  if (!token.refresh_token) throw new Error('No refresh_token returned. Revoke prior access and retry.');

  const cached: CachedToken = { refresh_token: token.refresh_token, obtained_at: new Date().toISOString() };
  const tokenPath = tokenPathFor(needsDrive);
  writeFileSync(tokenPath, JSON.stringify(cached, null, 2), 'utf-8');
  console.log(`Refresh token cached at ${tokenPath}`);
  return token.refresh_token;
}

async function getAccessToken(needsDrive: boolean): Promise<string> {
  const { clientId, clientSecret, origin } = loadClientCredentials();
  const tokenPath = tokenPathFor(needsDrive);
  console.log(`OAuth client: ${origin}`);

  const exchange = async (refreshToken: string): Promise<Response> =>
    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

  let refreshToken: string;
  if (existsSync(tokenPath)) {
    refreshToken = (JSON.parse(readFileSync(tokenPath, 'utf-8')) as CachedToken).refresh_token;
  } else {
    refreshToken = await consent(clientId, clientSecret, needsDrive);
  }

  let res = await exchange(refreshToken);
  if (!res.ok) {
    // A client still in "Testing" expires refresh tokens after 7 days. Re-consent rather than
    // making the operator work out that a cached token silently aged out.
    console.warn(`Cached refresh token rejected (${res.status}) — re-running consent.`);
    res = await exchange(await consent(clientId, clientSecret, needsDrive));
    if (!res.ok) throw new Error(`Token refresh failed after re-consent: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as TokenResponse).access_token;
}

/**
 * The reused client was built for mail export, so the Drive API may be off in its project.
 * Google's 403 body carries the one-click enable link; surface it instead of burying it.
 */
function explainApiError(status: number, body: string): string {
  if (status === 403 && /has not been used in project|is disabled/i.test(body)) {
    const link = /https:\/\/console\.developers\.google\.com\/\S*?(?=["\s\\])/.exec(body)?.[0];
    return (
      'The Google API this call needs is not enabled in the OAuth client\'s project.\n' +
      (link ? `  Enable it here, wait ~1 min, then re-run:\n  ${link}\n` : '') +
      `  Raw: ${body}`
    );
  }
  return `${status} ${body}`;
}

async function apiGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GET ${url} -> ${explainApiError(res.status, await res.text())}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- gmail

/** Depth-first walk of the MIME tree, yielding every part that is a real attachment. */
function walkParts(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const child of part.parts ?? []) walkParts(child, out);
  return out;
}

async function fetchAttachment(messageId: string, filename: string, accessToken: string): Promise<Buffer> {
  const message = await apiGet<GmailMessage>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    accessToken,
  );
  const parts = walkParts(message.payload);
  const match = parts.find((p) => p.filename === filename);
  if (!match?.body?.attachmentId) {
    const seen = parts.map((p) => p.filename ?? '(unnamed)').join(', ') || '(none)';
    throw new Error(`Attachment "${filename}" not found on message ${messageId}. Attachments present: ${seen}`);
  }
  const attachment = await apiGet<GmailAttachment>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${match.body.attachmentId}`,
    accessToken,
  );
  return Buffer.from(attachment.data, 'base64url');
}

/** Lists every non-inline attachment across recent inbound mail, so new replies are easy to add. */
async function discover(accessToken: string): Promise<void> {
  const list = await apiGet<GmailListResponse>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(DISCOVER_QUERY)}`,
    accessToken,
  );
  const refs = list.messages ?? [];
  console.log(`Scanning ${refs.length} message(s) matching: ${DISCOVER_QUERY}\n`);

  const known = new Set(
    MANIFEST.filter((e): e is ManifestEntry & { source: GmailSource } => e.source.kind === 'gmail').map(
      (e) => `${e.source.messageId}::${e.source.filename}`,
    ),
  );

  for (const ref of refs) {
    const message = await apiGet<GmailMessage>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
      accessToken,
    );
    for (const part of walkParts(message.payload)) {
      const name = part.filename ?? '';
      // Signature images and logos dominate the noise; only documents are interesting.
      if (/\.(png|jpe?g|gif|bmp|svg|ico)$/i.test(name)) continue;
      const flag = known.has(`${ref.id}::${name}`) ? 'IN MANIFEST' : 'NEW';
      console.log(`  [${flag}] ${ref.id}  ${part.mimeType ?? '?'}  ${name}`);
    }
  }
  console.log('\nAdd any NEW row that is a real W-9 to MANIFEST, then re-run without --discover.');
}

// ---------------------------------------------------------------- drive

async function listFolder(folderId: string, accessToken: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = '';
  do {
    const url =
      'https://www.googleapis.com/drive/v3/files' +
      `?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false`)}` +
      '&fields=nextPageToken,files(id,name,mimeType)&pageSize=200' +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const page = await apiGet<DriveListResponse>(url, accessToken);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return files;
}

async function uploadPdf(name: string, bytes: Buffer, folderId: string, accessToken: string): Promise<DriveFile> {
  const boundary = 'w9upload7f3a9c2e';
  const metadata = JSON.stringify({ name, parents: [folderId], mimeType: 'application/pdf' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, 'utf-8'),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, 'utf-8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
  );
  if (!res.ok) throw new Error(`Drive upload of "${name}" failed: ${explainApiError(res.status, await res.text())}`);
  return (await res.json()) as DriveFile;
}

// ---------------------------------------------------------------- main

/** A PDF always starts with %PDF; catches an error page saved under a .pdf name. */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('latin1') === '%PDF';
}

function resolveLocalPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return path;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return resolve(home, path);
}

async function main(): Promise<void> {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  const isDiscover = args.has('--discover');
  const isDryRun = args.has('--dry-run');

  // Only a live run touches Drive, so only a live run asks for the Drive scope.
  const needsDrive = !isDiscover && !isDryRun;
  const accessToken = await getAccessToken(needsDrive);

  if (isDiscover) {
    await discover(accessToken);
    return;
  }

  // The duplicate check is itself a Drive call, so a dry run skips it and downloads everything.
  // That keeps --dry-run usable as a pure-Gmail smoke test when Drive access is still unresolved.
  const existing = needsDrive
    ? new Set((await listFolder(DRIVE_FOLDER_ID, accessToken)).map((f) => f.name))
    : new Set<string>();
  console.log(
    needsDrive
      ? `Destination folder holds ${existing.size} file(s).\n`
      : 'Dry run: not contacting Drive at all (no duplicate check, no upload).\n',
  );

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  let uploaded = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const entry of MANIFEST) {
    const label = `${entry.vendor} -> ${entry.outputName}`;
    try {
      if (existing.has(entry.outputName)) {
        console.log(`  SKIP    ${label} (already in Drive)`);
        skipped += 1;
        continue;
      }

      let bytes: Buffer;
      if (entry.source.kind === 'gmail') {
        bytes = await fetchAttachment(entry.source.messageId, entry.source.filename, accessToken);
      } else {
        const path = resolveLocalPath(entry.source.path);
        if (!existsSync(path)) throw new Error(`Local file not found: ${path}`);
        bytes = readFileSync(path);
      }

      if (!looksLikePdf(bytes)) {
        throw new Error(`Downloaded ${bytes.length} bytes but they are not a PDF (missing %PDF header)`);
      }

      const localPath = resolve(OUT_DIR, entry.outputName);
      if (!existsSync(dirname(localPath))) mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, new Uint8Array(bytes));

      if (isDryRun) {
        console.log(`  DRY-RUN ${label} (${bytes.length} bytes, saved locally, NOT uploaded)`);
        continue;
      }

      const file = await uploadPdf(entry.outputName, bytes, DRIVE_FOLDER_ID, accessToken);
      console.log(`  UPLOAD  ${label} (${bytes.length} bytes, drive id ${file.id})`);
      uploaded += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL    ${label}: ${reason}`);
      failures.push(`${entry.vendor}: ${reason}`);
    }
    if (entry.note) console.log(`          note: ${entry.note}`);
  }

  console.log(`\n${isDryRun ? 'DRY RUN ' : ''}done. uploaded=${uploaded} skipped=${skipped} failed=${failures.length}`);
  console.log(`Local copies: ${OUT_DIR}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
