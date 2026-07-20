/**
 * Pure naming rules for the deposit slip portal.
 *
 * Every folder path and filename in the feature is built here, and the one-off
 * migration script reuses the same functions. No I/O — see drive.ts for that.
 *
 * Convention (spec §4):
 *   Deposit Slips / {Location} / {YYYY} / {YYYY-MM-DD} /
 *   {YYYY-MM-DD}_{Type}[_{Amount}][_{First}-{LastInitial}]_{NN}.{ext}
 */

export type DepositType = 'Deposit' | 'Check';

export interface UploaderIdentity {
  first_name: string | null;
  last_name: string | null;
  email: string;
}

export interface FileNameParts {
  isoDate: string;
  type: DepositType;
  amount: string | null;
  /** Null for migrated historical files, whose uploader is unrecoverable. */
  uploader: string | null;
  seq: number;
  ext: string;
}

export interface LegacyName {
  isoDate: string | null;
  amount: string | null;
  type: DepositType | null;
}

export class InvalidAmountError extends Error {
  constructor(raw: string) {
    super(`Invalid amount: ${JSON.stringify(raw)}`);
    this.name = 'InvalidAmountError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `Deposit Slips / {Location} / {YYYY} / {YYYY-MM-DD}` */
export function buildFolderSegments(location: string, isoDate: string): string[] {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`Expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(isoDate)}`);
  }
  const trimmed = location.trim();
  if (!trimmed) throw new Error('Location is required');
  return [trimmed, isoDate.slice(0, 4), isoDate];
}

/**
 * Normalises user input to `$1409.36`. Commas are stripped — legal in filenames
 * but they break naive CSV/shell handling downstream.
 * Returns null for blank input (amount is optional); throws for garbage.
 */
export function formatAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new InvalidAmountError(raw);

  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new InvalidAmountError(raw);

  return `$${value.toFixed(2)}`;
}

const NON_ALNUM = /[^A-Za-z0-9]/g;

/**
 * `Carson-D`. Falls back to the email local part when no profile name exists.
 *
 * `user_profiles` stores only a single `full_name`; AuthUser.first_name /
 * last_name are derived by splitting it on the FIRST space, so a middle name
 * ends up inside last_name ("Carson James Doe" -> last_name "James Doe").
 * Take the last whitespace token for the initial, not charAt(0).
 */
export function formatUploader(user: UploaderIdentity): string {
  const first = (user.first_name ?? '').replace(NON_ALNUM, '');

  const surnameTokens = (user.last_name ?? '').trim().split(/\s+/).filter(Boolean);
  const surname = surnameTokens[surnameTokens.length - 1] ?? '';
  const lastInitial = surname.replace(NON_ALNUM, '').charAt(0);

  if (first && lastInitial) return `${first}-${lastInitial}`;
  if (first) return first;

  const local = user.email.split('@')[0] ?? '';
  const fallback = local.replace(NON_ALNUM, '');
  return fallback || 'Unknown';
}

export function buildFileName(parts: FileNameParts): string {
  const segments: string[] = [parts.isoDate, parts.type];
  if (parts.amount) segments.push(parts.amount);
  if (parts.uploader) segments.push(parts.uploader);
  segments.push(String(parts.seq).padStart(2, '0'));

  const ext = parts.ext.toLowerCase();
  return `${segments.join('_')}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

// Anchored on the leading ISO-date token rather than capping digit width.
// Requiring the date prefix positively identifies a name THIS module generated
// (date_body_NN.ext) instead of guessing from how many digits the sequence
// has — a digit cap only narrows which accidental filenames collide (it still
// misreads "Receipt_12.jpg" as seq 12, and breaks once a folder legitimately
// reaches a 4+-digit sequence). Names like "IMG_7389.jpeg" have no ISO date
// prefix and so never match, with no cap needed.
const SEQ_SUFFIX = /^\d{4}-\d{2}-\d{2}_.*_(\d+)\.[^.]+$/;

/** Highest trailing `_NN` in the folder, plus one. */
export function nextSequence(existingNames: string[]): number {
  let max = 0;
  for (const name of existingNames) {
    const match = SEQ_SUFFIX.exec(name);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// Historical names use four date formats and two amount formats — see spec §3.1.
const LEGACY_DATE = /(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/;
const LEGACY_AMOUNT = /\$\s*([\d,]+)[\s.](\d{2})(?!\d)/;
const LEGACY_DEPOSIT = /^\s*depos?t?i?t?\b/i;

function toIsoDate(month: string, day: string, year: string): string {
  const yyyy = year.length === 2 ? `20${year}` : year.padStart(4, '0');
  return `${yyyy}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Best-effort extraction from a pre-migration filename. Nulls where unknowable. */
export function parseLegacyName(name: string): LegacyName {
  const base = name.replace(/\.[^.]+$/, '');

  const dateMatch = LEGACY_DATE.exec(base);
  const isoDate = dateMatch ? toIsoDate(dateMatch[1], dateMatch[2], dateMatch[3]) : null;

  const amountMatch = LEGACY_AMOUNT.exec(base);
  const amount = amountMatch ? `$${amountMatch[1].replace(/,/g, '')}.${amountMatch[2]}` : null;

  // "Deposit" and the observed "Depost" typo both count; nothing else is inferable.
  const type: DepositType | null = LEGACY_DEPOSIT.test(base) ? 'Deposit' : null;

  return { isoDate, amount, type };
}
