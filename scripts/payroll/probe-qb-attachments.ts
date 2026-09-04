/** READ-ONLY: what is actually attached to the March journal entries in QuickBooks?
 *
 *  Our export builders are healthy (probe-export-health.ts: 19/19 valid .xlsx), so Kristi's
 *  "File or directory not found" is about the attachment record, not the file we generate.
 *
 *  QuickBooks Attachable records come in two flavours:
 *    - an UPLOADED FILE  -> has FileName + ContentType + Size, and QB serves it to everyone
 *    - a LINK            -> no FileName/Size; the target lives in Note/Tag. If that target is
 *                           a local path (C:\...) or a UNC share, it resolves only on the
 *                           machine that created it — everyone else gets "not found".
 *
 *  This lists every Attachable joined to a March JE and says which flavour it is.
 *
 *  No writes. Untracked scratch.
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import type { RawJournalEntry } from '../../src/lib/payroll/qb-pool';

interface QbRef { value?: string; type?: string }
interface QbAttachableRef { EntityRef?: QbRef; IncludeOnSend?: boolean }
interface QbAttachable {
  Id: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
  Note?: string;
  Tag?: string;
  FileAccessUri?: string;
  TempDownloadUri?: string;
  AttachableRef?: QbAttachableRef[];
}

const LOCAL_PATH_RE = /^(?:[A-Za-z]:\\|\\\\|file:\/\/)/;

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const [y, mo] = month.split('-');
  const lastDay = new Date(Number(y), Number(mo), 0).getDate();
  const where = `WHERE TxnDate >= '${y}-${mo}-01' AND TxnDate <= '${y}-${mo}-${lastDay}'`;

  for (const entity of EOM_ENTITIES) {
    console.log(`\n=== ${entity} ===`);
    let jes: RawJournalEntry[];
    let atts: QbAttachable[];
    try {
      jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
      atts = await qbQueryAll<QbAttachable>(entity, 'Attachable', '');
    } catch (err) {
      console.log(`  !! ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const jeById = new Map(jes.map((j) => [j.Id, j]));
    console.log(`  ${jes.length} JEs in ${month}, ${atts.length} Attachable records in the company`);

    let hits = 0;
    for (const a of atts) {
      for (const ref of a.AttachableRef ?? []) {
        const t = ref.EntityRef?.type;
        const v = ref.EntityRef?.value;
        if (t !== 'JournalEntry' || !v || !jeById.has(v)) continue;
        hits++;
        const je = jeById.get(v);
        const isFile = Boolean(a.FileName && a.Size);
        const target = a.Note ?? a.Tag ?? '';
        const looksLocal = LOCAL_PATH_RE.test(target.trim());
        console.log(`\n  JE ${je?.DocNumber ?? v} (${je?.TxnDate ?? '?'})  <- Attachable #${a.Id}`);
        if (isFile) {
          console.log(`      UPLOADED FILE: ${a.FileName}  ${a.ContentType ?? ''}  ${a.Size} bytes`);
          console.log(`      servable: ${a.FileAccessUri ? 'yes (FileAccessUri present)' : 'NO FileAccessUri — QB has no stored bytes'}`);
        } else {
          console.log(`      LINK (no stored file). Note/Tag: ${JSON.stringify(target)}`);
          if (looksLocal) console.log(`      *** local/UNC path — resolves ONLY on the machine that made it. This is the "File or directory not found". ***`);
        }
      }
    }
    if (hits === 0) console.log(`  (no Attachable is linked to any ${month} journal entry)`);
  }
  process.exit(0);
}

void main();
