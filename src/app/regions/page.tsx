import type { Metadata } from 'next';
import RegionsTable, { type RegionRow } from '@/components/RegionsTable';
import { requireAuth } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase-admin';

// Read-only mirror of Auth Host's Territories tab (/admin → Territories). Auth owns the list —
// adds, renames and assignments happen there. Same Supabase project, so this reads the tables
// directly: `marketer_automation_marketers` joined to `adp_employees` on adp_employee_id.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Regions — MedRock Accounting',
  description: 'Marketer regions and who holds each one',
};

interface TerritoryRow {
  id: string;
  name: string;
  adp_employee_id: string | null;
}

interface EmployeeRow {
  id: string;
  first_name: string;
  last_name: string;
  job_title: string | null;
  status: string;
  phone: string | null;
  work_email: string | null;
  home_location: string | null;
}

/**
 * Regions whose serviced pharmacy is NOT the rep's ADP home_location (Carson, 2026-09-21).
 * Keyed by display name (suffix stripped). ADP is the default for everything else.
 */
const SERVICED_LOCATION_OVERRIDES: Record<string, string> = {
  'South Georgia': 'TN',
  Remote: 'All',
};

/** The pharmacy a region's rep services: override first, else FL / TN / TX from ADP home_location. */
function servicedLocation(region: string, homeLocation: string | null): string | null {
  return SERVICED_LOCATION_OVERRIDES[region] ?? locationCode(homeLocation);
}

/** ADP home_location ("MedRock TN") → FL / TN / TX. */
function locationCode(raw: string | null): string | null {
  const value = clean(raw);
  if (!value) return null;
  const upper = value.toUpperCase();
  if (/\bFL\b/.test(upper) || upper.includes('FLORIDA')) return 'FL';
  if (/\bTN\b/.test(upper) || upper.includes('TENNESSEE')) return 'TN';
  if (/\bTX\b/.test(upper) || upper.includes('TEXAS')) return 'TX';
  return value;
}

/** Placeholder names Auth's picker hides — "UNASSIGNED" leftovers and closed Naples (auth: territories.ts). */
function isJunkTerritoryName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.includes('UNASSIGNED') || upper.includes('NAPLES');
}

/** Stored names carry a ", Marketer" bookkeeping suffix; Auth strips it for display. */
function territoryDisplayName(name: string): string {
  return name.replace(/,\s*Marketer$/, '');
}

function clean(value: string | null): string | null {
  return value && value.trim() !== '' ? value.trim() : null;
}

export default async function RegionsPage() {
  // Open to any signed-in staff member (Carson, 2026-09-18) — Auth's own tab is admin-only
  // because it edits; this one only reads.
  await requireAuth();

  let rows: RegionRow[] = [];
  let loadError: string | null = null;

  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('marketer_automation_marketers')
      .select('id, name, adp_employee_id')
      .order('name');
    if (error) throw new Error(error.message);

    const territories = ((data ?? []) as TerritoryRow[]).filter((t) => !isJunkTerritoryName(t.name));
    const ids = [...new Set(territories.map((t) => t.adp_employee_id).filter((v): v is string => v !== null))];

    // Email comes from ADP, not the territory table's own `email` column — that one is a
    // legacy mirror with stale pre-name-change addresses.
    const byId = new Map<string, EmployeeRow>();
    if (ids.length > 0) {
      const { data: emps, error: empError } = await supabase
        .from('adp_employees')
        .select('id, first_name, last_name, job_title, status, phone, work_email, home_location')
        .in('id', ids);
      if (empError) throw new Error(empError.message);
      for (const e of (emps ?? []) as EmployeeRow[]) byId.set(e.id, e);
    }

    rows = territories.map((t) => {
      const e = t.adp_employee_id ? byId.get(t.adp_employee_id) : undefined;
      const region = territoryDisplayName(t.name);
      return {
        id: t.id,
        region,
        holder: e ? `${e.first_name} ${e.last_name}`.trim() : null,
        jobTitle: e ? clean(e.job_title) : null,
        status: e ? e.status : null,
        location: e ? servicedLocation(region, e.home_location) : null,
        email: e ? clean(e.work_email)?.toLowerCase() ?? null : null,
        phone: e ? clean(e.phone) : null,
      };
    });
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Failed to load regions';
  }

  return <RegionsTable rows={rows} loadError={loadError} />;
}
