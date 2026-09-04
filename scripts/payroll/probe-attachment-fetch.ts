/** READ-ONLY: can QuickBooks actually SERVE the bytes of the attachments Kristi can't open?
 *
 *  probe-qb-attachments.ts showed every March attachment is a properly uploaded file with a
 *  FileAccessUri — including `FL Accrued Payroll 2026.03.xlsx` (#1000000301) on the
 *  `PR Accru 2026.03` JE that Kristi reports as "File or directory not found". But QuickBooks
 *  returns a FileAccessUri whether or not the stored blob still exists, so presence proves
 *  nothing. This fetches the bytes and reports what actually comes back.
 *
 *  The `#1000000xxx` attachments (all the payroll ones Barbara adds) sit in a different id
 *  space from the older `#42688349`-style records, so a normal-id attachment is fetched too
 *  as a control. If the control serves and the 1000000xxx one 404s, the id space is the story.
 *
 *  Read-only GETs against the QuickBooks API. Untracked scratch.
 */
import './load-env-vercel-first';
import { getValidTokens, qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Location } from '../../src/lib/quickbooks-multi';

interface QbRef { value?: string; type?: string }
interface QbAttachable {
  Id: string; FileName?: string; ContentType?: string; Size?: number;
  FileAccessUri?: string; TempDownloadUri?: string;
  AttachableRef?: Array<{ EntityRef?: QbRef }>;
}

const QB_API_BASE = process.env.QB_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com/v3'
  : 'https://quickbooks.api.intuit.com/v3';

async function tryFetch(label: string, url: string, bearer: string): Promise<void> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: '*/*' } });
    const ct = res.headers.get('content-type') ?? '';
    const len = res.headers.get('content-length') ?? '?';
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      console.log(`      ${label}: HTTP ${res.status} ${res.statusText}  ct=${ct}  body=${body.replace(/\s+/g, ' ')}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const magic = buf.subarray(0, 2).toString('latin1');
    console.log(`      ${label}: HTTP ${res.status}  ${buf.length} bytes (hdr ${len})  ct=${ct}  magic=${magic}${magic === 'PK' ? ' (valid zip/xlsx)' : ''}`);
  } catch (err) {
    console.log(`      ${label}: threw ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const location = (process.argv[2] ?? 'MedRock FL') as Location;
  const wanted = process.argv.slice(3);

  const tokens = await getValidTokens(location);
  if (!tokens) { console.error(`no QuickBooks tokens for ${location}`); process.exit(1); }
  const bearer = tokens.access_token;
  const realm = tokens.realm_id;

  const atts = await qbQueryAll<QbAttachable>(location, 'Attachable', '');
  const byId = new Map(atts.map((a) => [a.Id, a]));
  const targets = wanted.length > 0 ? wanted : ['1000000301', '42688349'];

  console.log(`\n=== ${location} (realm ${realm}) — fetching ${targets.length} attachment(s) ===`);
  for (const id of targets) {
    const a = byId.get(id);
    if (!a) { console.log(`\n  #${id}: not found among ${atts.length} Attachable records`); continue; }
    console.log(`\n  #${a.Id}  ${a.FileName}  (${a.Size} bytes per metadata, ${a.ContentType})`);
    console.log(`      attached to: ${(a.AttachableRef ?? []).map((r) => `${r.EntityRef?.type} ${r.EntityRef?.value}`).join(', ') || '(nothing)'}`);

    // 1. The documented download endpoint.
    await tryFetch('download endpoint', `${QB_API_BASE}/company/${realm}/download/${a.Id}?minorversion=75`, bearer);
    // 2. Whatever FileAccessUri claims.
    if (a.FileAccessUri) await tryFetch('FileAccessUri    ', a.FileAccessUri.startsWith('http') ? a.FileAccessUri : `${QB_API_BASE}/company/${realm}/${a.FileAccessUri.replace(/^\//, '')}`, bearer);
    else console.log(`      FileAccessUri    : (absent)`);
    // 3. TempDownloadUri is pre-signed — no auth header needed.
    if (a.TempDownloadUri) await tryFetch('TempDownloadUri  ', a.TempDownloadUri, bearer);
    else console.log(`      TempDownloadUri  : (absent)`);
  }
  process.exit(0);
}

void main();
