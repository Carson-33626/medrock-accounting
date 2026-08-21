/**
 * DocNumber conflict resolution for QuickBooks journal entries.
 *
 * WHY: QuickBooks rejects a JE whose DocNumber is already in use (fault 6240), and our
 * DocNumbers are DERIVED, not chosen — `PR 2026.07.21` for a pay date, `EOM …`, `INV …`.
 * That derivation is the whole point (see je-identity): the export CSV, the EOM
 * externally-posted dedupe and the live post all agree on one number per run. But it also
 * means a DocNumber can be taken by an entry that has nothing to do with us — verified live
 * 2026-08-21, where FL's `PR 2026.07.21` was held by a hand-keyed $7,948.33 trade-conference
 * accrual dated 08/31, while the payroll run it blocked was $2,691.25 dated 07/21.
 *
 * The resolution is to rename OUR entry, never theirs: suffix the derived number (`-2`, `-3`, …)
 * and persist that on the header as `qb_doc_number`, which `deriveJeIdentity` prefers over the
 * derivation. One write keeps every downstream consumer — post, export, dedupe — on the same
 * number.
 */

/** A live QuickBooks journal entry holding a DocNumber we wanted. */
export interface ConflictingEntry {
  qbEntryId: string;
  docNumber: string;
  txnDate: string;
  /** Total of the entry's debit lines, for a sanity check in the UI. */
  amount: number;
  privateNote: string;
}

/** Suffixed DocNumbers are `<derived>-<n>` with n >= 2. Nothing else is a valid rename. */
const SUFFIX_RE = /^(.*)-(\d+)$/;

/**
 * The next free `<base>-<n>` given the DocNumbers already live in the company.
 *
 * Starts at -2 (the unsuffixed number IS -1 conceptually) and skips every taken suffix, so a
 * second conflict on an already-renamed run lands on -3 rather than colliding again. `taken`
 * is every DocNumber in the company, not just the base — a previous rename is in there too.
 */
export function nextFreeDocNumber(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`no free DocNumber after 999 attempts on "${base}"`);
}

/**
 * Guard for the rename endpoint: a client may only ask for a suffix of the number this run
 * actually derives. It may not rename a run to an arbitrary string — that would decouple the
 * DocNumber from the run's identity, which is exactly what je-identity exists to prevent.
 */
export function isValidRename(base: string, candidate: string): boolean {
  const m = SUFFIX_RE.exec(candidate);
  if (!m) return false;
  const [, stem, n] = m;
  return stem === base && Number(n) >= 2;
}
