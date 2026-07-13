'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save, Users, XCircle } from 'lucide-react';

/**
 * Local mirrors of the /api/payroll/marketers response shape (web/src/app/api/payroll/
 * marketers/route.ts) and the /api/payroll/dimensions response. Not imported directly —
 * those modules pull in the RDS pool (`pg`) / QuickBooks client, which must never land in
 * a client bundle. Same convention as UnmappedColumnsPanel.tsx / MappingsTab.tsx.
 */
type Entity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';

interface MarketerReviewItem {
  positionId: string;
  name: string;
  currentDepartment: string | null;
  currentClass: string | null;
  currentCogsOverride: boolean | null;
  employeeRuleId: number | null;
}

interface EmployeeMapRule {
  id?: number;
  entity: Entity;
  positionId: string;
  departmentName: string | null;
  className: string | null;
  cogsOverride: boolean | null;
  active: boolean;
}

interface DimensionsResponse {
  accounts: string[];
  departments: string[];
  classes: string[];
}

interface ApiErrorBody {
  error?: string;
}

const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

function isEntity(value: string): value is Entity {
  return (ENTITIES as string[]).includes(value);
}

interface MarketerReviewPanelProps {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  /** header.entity from the loaded run — validated at runtime against the Entity union. */
  entity: string;
  /** header.id from the loaded run. `null` means no run is loaded — the panel fetches nothing. */
  headerId: number | null;
  /** Called after a marketer's region saves successfully so the caller can re-run reconcile
   * for this draft (the JE's marketing split changes with the new Department). */
  onReassigned: () => void;
}

/**
 * "Marketers needing region review" worklist at the top of the Review tab, directly below
 * UnmappedColumnsPanel — the marketer counterpart to it. Surfaces every marketer on the
 * loaded run (home_department ILIKE 'MARKET%') whose employee-map Department is either the
 * '% Allocation' inter-entity catch-all or entirely unassigned, and lets an accountant
 * confirm or reassign a real QB Department (region) right there. Saving POSTs to
 * /api/payroll/mappings { kind: 'employee' }, which persists permanently in
 * accounting.payroll_employee_map — the row is removed from this worklist only after a
 * successful save.
 *
 * Non-modal: it never blocks reviewing the rest of the JE below it. It fetches its own data
 * (unlike UnmappedColumnsPanel, which receives unmappedColumns as a prop from the parent's
 * reconcile result) — /api/payroll/marketers, keyed off headerId, plus /api/payroll/
 * dimensions for the Department/Class dropdowns. It renders nothing until the fetch has
 * actually returned marketers needing review, then sticks around (showing a "done" state)
 * once they've all been resolved in this session, so the accountant gets visible
 * confirmation rather than the panel just vanishing. Give it `key={headerId}` from the
 * caller so it resets cleanly when a different draft loads.
 *
 * The marketers list is fetched fresh (not a passed-in prop), so it has its own unknown
 * state: `null` while loading or before the first fetch completes. The panel renders
 * NOTHING in that state — same null-discipline as UnmappedColumnsPanel's `unmappedColumns
 * === null` handling — it must never show a false "all caught up" done state before the
 * fetch has actually confirmed there's nothing (or nothing left) to review. A fetch failure
 * is NOT treated as "unknown" for this purpose (that would silently hide a real problem);
 * it renders a dedicated error state instead.
 */
export function MarketerReviewPanel({
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  entity,
  headerId,
  onReassigned,
}: MarketerReviewPanelProps) {
  const validEntity = isEntity(entity) ? entity : null;

  const [marketers, setMarketers] = useState<MarketerReviewItem[] | null>(null);
  const [marketersError, setMarketersError] = useState<string | null>(null);
  const [marketersLoading, setMarketersLoading] = useState(false);

  const [dimensions, setDimensions] = useState<DimensionsResponse | null>(null);
  const [dimensionsError, setDimensionsError] = useState<string | null>(null);
  const [dimensionsLoading, setDimensionsLoading] = useState(false);

  const [resolved, setResolved] = useState<Set<string>>(new Set());
  // Seeded/updated only from a CONFIRMED (non-null) fetch — a not-yet-loaded or failed
  // fetch must never flip this to "had zero" or otherwise affect it.
  const [everHadMarketers, setEverHadMarketers] = useState(false);

  useEffect(() => {
    if (marketers !== null && marketers.length > 0) setEverHadMarketers(true);
  }, [marketers]);

  useEffect(() => {
    if (headerId === null) {
      setMarketers(null);
      setMarketersError(null);
      return;
    }
    let cancelled = false;
    setMarketersLoading(true);
    setMarketersError(null);

    void (async () => {
      try {
        const res = await fetch(`/api/payroll/marketers?headerId=${encodeURIComponent(String(headerId))}`);
        const body = (await res.json()) as MarketerReviewItem[] | ApiErrorBody;
        if (!res.ok) {
          const message = !Array.isArray(body) && body.error ? body.error : `Request failed (${res.status})`;
          throw new Error(message);
        }
        if (!Array.isArray(body)) throw new Error('Unexpected response shape from /api/payroll/marketers');
        if (!cancelled) setMarketers(body);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Failed to load marketers needing region review';
        setMarketersError(message);
        setMarketers(null);
      } finally {
        if (!cancelled) setMarketersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [headerId]);

  useEffect(() => {
    if (!validEntity) return;
    let cancelled = false;
    setDimensionsLoading(true);
    setDimensionsError(null);

    void (async () => {
      try {
        const res = await fetch(`/api/payroll/dimensions?entity=${encodeURIComponent(validEntity)}`);
        const body = (await res.json()) as DimensionsResponse & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (!cancelled) setDimensions(body);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'QuickBooks dimensions unavailable';
        setDimensionsError(message);
        setDimensions(null);
      } finally {
        if (!cancelled) setDimensionsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [validEntity]);

  const visibleMarketers = useMemo(
    () => (marketers ?? []).filter((m) => !resolved.has(m.positionId)),
    [marketers, resolved],
  );

  const handleResolved = useCallback(
    (positionId: string) => {
      setResolved((prev) => new Set(prev).add(positionId));
      onReassigned();
    },
    [onReassigned],
  );

  // Fetch failed — a known problem, not an unknown state. Never silently hide it.
  if (marketersError) {
    return (
      <div className={`rounded-xl shadow-sm p-4 border-2 ${cardBg} ${darkMode ? 'border-red-800' : 'border-red-300'}`}>
        <p className={`text-sm flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
          <XCircle className="w-4 h-4 shrink-0" aria-hidden />
          Failed to load marketers needing region review: {marketersError}
        </p>
      </div>
    );
  }

  // Unknown state (not yet loaded) — never render the done state (or anything) from this.
  if (marketers === null) return null;
  if (!everHadMarketers) return null;

  const allDone = visibleMarketers.length === 0;

  return (
    <div
      className={`rounded-xl shadow-sm p-4 border-2 ${cardBg} space-y-3 ${
        allDone ? border : darkMode ? 'border-amber-700' : 'border-amber-300'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users
            className={`w-4 h-4 ${allDone ? subText : darkMode ? 'text-amber-300' : 'text-amber-600'}`}
            aria-hidden
          />
          <p className="text-sm font-semibold">Marketers needing region review</p>
        </div>
        <span className={`text-xs font-medium ${subText}`}>
          {allDone
            ? 'All caught up'
            : `${visibleMarketers.length} marketer${visibleMarketers.length === 1 ? '' : 's'} need${
                visibleMarketers.length === 1 ? 's' : ''
              } a region`}
        </span>
      </div>

      {allDone ? (
        <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
          Every marketer on this run now has a region.
        </p>
      ) : (
        <>
          {!validEntity && (
            <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              Unrecognized entity &quot;{entity}&quot; — cannot save region assignments from here.
            </p>
          )}
          {dimensionsError && !dimensionsLoading && (
            <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              QuickBooks dimensions unavailable ({dimensionsError}). Department field falls back to free-text.
            </p>
          )}
          <p className={`text-[11px] ${subText}`}>
            &apos;% Allocation&apos; is the inter-entity catch-all default — it can be kept as-is if this marketer
            genuinely has no single region yet.
          </p>

          <div className="space-y-2">
            {visibleMarketers.map((m) => (
              <MarketerRow
                key={m.positionId}
                darkMode={darkMode}
                border={border}
                inputBg={inputBg}
                subText={subText}
                entity={validEntity}
                marketer={m}
                departmentOptions={dimensions?.departments ?? null}
                classOptions={dimensions?.classes ?? null}
                dimensionsLoading={dimensionsLoading}
                onSaved={() => handleResolved(m.positionId)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MarketerRow({
  darkMode,
  border,
  inputBg,
  subText,
  entity,
  marketer,
  departmentOptions,
  classOptions,
  dimensionsLoading,
  onSaved,
}: {
  darkMode: boolean;
  border: string;
  inputBg: string;
  subText: string;
  entity: Entity | null;
  marketer: MarketerReviewItem;
  departmentOptions: string[] | null;
  classOptions: string[] | null;
  dimensionsLoading: boolean;
  onSaved: () => void;
}) {
  const [departmentName, setDepartmentName] = useState(marketer.currentDepartment ?? '');
  const [className, setClassName] = useState(marketer.currentClass ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isCatchAll = marketer.currentDepartment === '% Allocation';

  const canSave = entity !== null && departmentName.trim().length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!entity || !departmentName.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const rule: EmployeeMapRule = {
        id: marketer.employeeRuleId ?? undefined,
        entity,
        positionId: marketer.positionId,
        departmentName: departmentName.trim(),
        className: className.trim() ? className.trim() : null,
        // Preserve any COGS-override the accountant set in the full Mappings tab — this
        // shortcut panel only edits region/class, so it must not clobber that field.
        cogsOverride: marketer.currentCogsOverride,
        active: true,
      };
      const res = await fetch('/api/payroll/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'employee', rule }),
      });
      const body = (await res.json()) as { ok?: boolean; id?: number } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onSaved();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save marketer region';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [entity, departmentName, className, marketer, onSaved]);

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${border}`}>
      <p className="text-xs">
        Marketer <span className="font-semibold">{marketer.name}</span> (position {marketer.positionId}) is{' '}
        {isCatchAll ? (
          <>
            in <code className="font-mono font-semibold">% Allocation</code>
          </>
        ) : (
          'unassigned'
        )}{' '}
        — confirm or reassign region.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <input
          type="text"
          readOnly
          value={marketer.name}
          title="Marketer name (read-only)"
          className={`rounded-md border px-2 py-1 text-xs opacity-70 cursor-not-allowed ${inputBg}`}
        />
        <input
          type="text"
          readOnly
          value={marketer.positionId}
          title="Position ID (read-only)"
          className={`rounded-md border px-2 py-1 text-xs font-mono opacity-70 cursor-not-allowed ${inputBg}`}
        />

        {dimensionsLoading ? (
          <input
            type="text"
            disabled
            value=""
            placeholder="Loading departments…"
            title="Waiting on QuickBooks departments"
            className={`rounded-md border px-2 py-1 text-xs opacity-70 cursor-not-allowed ${inputBg}`}
          />
        ) : departmentOptions ? (
          <select
            value={departmentName}
            onChange={(e) => setDepartmentName(e.target.value)}
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          >
            <option value="">Select department (region)…</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={departmentName}
            onChange={(e) => setDepartmentName(e.target.value)}
            placeholder="Department (free-text — QuickBooks unavailable)"
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          />
        )}

        {dimensionsLoading ? (
          <input
            type="text"
            disabled
            value=""
            placeholder="Loading classes…"
            title="Waiting on QuickBooks classes"
            className={`rounded-md border px-2 py-1 text-xs opacity-70 cursor-not-allowed ${inputBg}`}
          />
        ) : classOptions ? (
          <select
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          >
            <option value="">Class (optional)…</option>
            {classOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder="Class (optional, free-text)"
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Save className="w-3.5 h-3.5" aria-hidden />}
          {saving ? 'Saving…' : 'Save (permanent)'}
        </button>

        {saveError && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
            <XCircle className="w-3.5 h-3.5" aria-hidden />
            {saveError}
          </span>
        )}
      </div>
    </div>
  );
}
