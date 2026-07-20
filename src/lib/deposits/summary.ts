/**
 * Pure aggregation over already-parsed deposit records — no Drive I/O here,
 * so it's testable against a fixture list rather than a live Drive walk.
 * See src/app/api/deposit-review/summary/route.ts for the walk that
 * produces the DepositRecord[] this consumes.
 */

import type { DepositType } from './naming';

export interface DepositRecord {
  fileId: string;
  fileName: string;
  webViewLink: string;
  location: string;
  isoDate: string | null;
  type: DepositType | null;
  amount: string | null;
  uploader: string | null;
}

export interface LocationSummary {
  location: string;
  fileCount: number;
  thisMonthCount: number;
  latestUploadDate: string | null;
}

export interface DepositReviewSummary {
  totalFiles: number;
  thisMonthCount: number;
  mostRecent: DepositRecord | null;
  locations: LocationSummary[];
  recent: DepositRecord[];
}

const MAX_RECENT = 50;

/** Newest first; records with no derivable date sort last (stable amongst themselves). */
function compareByDateDesc(a: DepositRecord, b: DepositRecord): number {
  if (a.isoDate === null && b.isoDate === null) return 0;
  if (a.isoDate === null) return 1;
  if (b.isoDate === null) return -1;
  return b.isoDate.localeCompare(a.isoDate);
}

function yearMonthOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function isDatedRecord(r: DepositRecord): r is DepositRecord & { isoDate: string } {
  return r.isoDate !== null;
}

/**
 * `locationNames` is passed separately (rather than derived from `records`)
 * so that a location folder with zero uploads still gets a card — an empty
 * folder produces no records to derive its name from.
 */
export function buildSummary(
  records: DepositRecord[],
  locationNames: string[],
  now: Date = new Date()
): DepositReviewSummary {
  const currentYearMonth = yearMonthOf(now);
  const isThisMonth = (isoDate: string | null): boolean =>
    isoDate !== null && isoDate.startsWith(currentYearMonth);

  const sorted = [...records].sort(compareByDateDesc);

  const locations: LocationSummary[] = locationNames.map((location) => {
    const forLocation = records.filter((r) => r.location === location);
    const dated = forLocation.filter(isDatedRecord);
    const latestUploadDate =
      dated.length > 0
        ? dated.reduce((max, r) => (r.isoDate > max ? r.isoDate : max), dated[0].isoDate)
        : null;

    return {
      location,
      fileCount: forLocation.length,
      thisMonthCount: forLocation.filter((r) => isThisMonth(r.isoDate)).length,
      latestUploadDate,
    };
  });

  return {
    totalFiles: records.length,
    thisMonthCount: records.filter((r) => isThisMonth(r.isoDate)).length,
    mostRecent: sorted[0] ?? null,
    locations,
    recent: sorted.slice(0, MAX_RECENT),
  };
}
