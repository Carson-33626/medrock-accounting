/**
 * Runtime marketer `name` -> territory (market + title) resolver, distilled from
 * territory-snapshot.json (latest period per rep). Used by /api/payroll/marketers to surface
 * each flagged marketer's territory + title so accounting has the context to pick a region.
 *
 * PLAINTEXT ONLY: the payroll `name` (never decrypted) is joined against the snapshot; nothing
 * sensitive is read. The norm/nameKeys/NAME_ALIASES join below is the SAME validated logic used
 * by scripts/payroll/employee-map-seed-data.ts and scripts/payroll/probe-region-join.ts — kept as
 * a self-contained copy here (matching those files' "EXACT copy, keep in sync" convention) so the
 * Next API route carries no dependency on scripts/.
 */
import snapshot from './territory-snapshot.json';

export interface RepTerritory {
  /** Raw market/region for the rep (e.g. "Carolina Region", "Tennessee") — the display territory. */
  market: string;
  /** Sales title for the rep's snapshot period (e.g. "Senior Territory Manager"), '' if unknown. */
  title: string;
}

export interface Director {
  /** Division this leader oversees (e.g. "East", "West") — shown as the territory. */
  division: string;
  /** Full leadership title (e.g. "Marketing Director East"). */
  title: string;
}

interface SnapshotRep {
  repName: string;
  market: string;
  period: number;
  title?: string;
}
interface SnapshotDirector {
  adpName: string;
  title: string;
  division: string;
}
interface Snapshot {
  reps: SnapshotRep[];
  directors?: SnapshotDirector[];
}

// EXACT copy of scripts/payroll/employee-map-seed-data.ts norm()/nameKeys().
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(jr|sr|ii|iii)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// ADP `name` is often "Last, First [Middle]" — produce a "first last" normalized key too.
function nameKeys(raw: string): string[] {
  const keys = new Set<string>();
  const n = norm(raw);
  keys.add(n);
  if (raw.includes(',')) {
    const [last, rest] = raw.split(',');
    const first = (rest ?? '').trim().split(/\s+/)[0] ?? '';
    keys.add(norm(`${first} ${last}`));
  }
  const toks = n.split(' ');
  if (toks.length >= 2) keys.add(`${toks[0]} ${toks[toks.length - 1]}`);
  return [...keys];
}

// CONFIRMED name-alias overrides (Carson) — payroll `name` spellings that don't match the
// snapshot rep_name via nameKeys() at all. Same map as employee-map-seed-data.ts NAME_ALIASES.
const NAME_ALIASES: Record<string, string> = {
  [norm('Wilhoit, Robert')]: 'Rob Wilhoit',
  [norm('Snyder, Antoneta')]: 'Antoneta Cici',
};

// nameKey -> latest-period {market,title}. Built once, lazily.
let repIndex: Map<string, { market: string; title: string; period: number }> | null = null;
function getIndex(): Map<string, { market: string; title: string; period: number }> {
  if (repIndex) return repIndex;
  const idx = new Map<string, { market: string; title: string; period: number }>();
  for (const rep of (snapshot as Snapshot).reps) {
    for (const k of nameKeys(rep.repName)) {
      const cur = idx.get(k);
      if (!cur || rep.period > cur.period) idx.set(k, { market: rep.market, title: rep.title ?? '', period: rep.period });
    }
  }
  repIndex = idx;
  return idx;
}

/** Resolve a payroll `name` to its territory (market + title), or null if no rep matches. */
export function resolveRepTerritory(payrollName: string): RepTerritory | null {
  const idx = getIndex();
  const aliasRep = NAME_ALIASES[norm(payrollName)];
  if (aliasRep) {
    for (const k of nameKeys(aliasRep)) {
      const hit = idx.get(k);
      if (hit) return { market: hit.market, title: hit.title };
    }
  }
  for (const k of nameKeys(payrollName)) {
    const hit = idx.get(k);
    if (hit) return { market: hit.market, title: hit.title };
  }
  return null;
}

// adp-name norm -> director. Directors are marketing leadership who are NOT territory reps
// (absent from the reps join above); matched on the ADP payroll `name` directly.
let directorIndex: Map<string, Director> | null = null;
function getDirectorIndex(): Map<string, Director> {
  if (directorIndex) return directorIndex;
  const idx = new Map<string, Director>();
  for (const d of (snapshot as Snapshot).directors ?? []) {
    idx.set(norm(d.adpName), { division: d.division, title: d.title });
  }
  directorIndex = idx;
  return idx;
}

/** Resolve a payroll `name` to a marketing-leadership title/division, or null if not a director. */
export function resolveDirector(payrollName: string): Director | null {
  return getDirectorIndex().get(norm(payrollName)) ?? null;
}
