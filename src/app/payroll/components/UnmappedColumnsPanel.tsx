'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, Save, Sparkles, XCircle } from 'lucide-react';

/**
 * Local mirrors of the payroll API response shapes (web/src/lib/payroll/types.ts +
 * the /api/payroll/dimensions response). Not imported directly — those modules pull in
 * the RDS pool (`pg`) / QuickBooks client, which must never land in a client bundle.
 * Same convention as MappingsTab.tsx / ReviewTab.tsx.
 */
type Entity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
type PostingType = 'Debit' | 'Credit';
type CreditBucket = 'Net Pay' | 'Taxes' | 'Garnishments' | 'Retirement' | 'Health' | 'WC' | 'Other';

interface AccountMapRule {
  entity: Entity;
  adpColumn: string;
  costCenter: string;
  accountName: string;
  postingType: PostingType;
  isCogs: boolean;
  creditBucket: CreditBucket | null;
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
const CREDIT_BUCKETS: CreditBucket[] = ['Net Pay', 'Taxes', 'Garnishments', 'Retirement', 'Health', 'WC', 'Other'];

function isEntity(value: string): value is Entity {
  return (ENTITIES as string[]).includes(value);
}

interface UnmappedColumnsPanelProps {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  /** header.entity from the loaded run — validated at runtime against the Entity union. */
  entity: string;
  /** From the run's latest reconcile result (built-je's unmappedColumns, surfaced verbatim). */
  unmappedColumns: string[];
  /** Called after a rule saves successfully so the caller can re-run reconcile for this draft. */
  onMapped: () => void;
  /** Called when the accountant wants the full Mappings tab (e.g. an employer double-entry column). */
  onNavigateToMappings: (entity: string) => void;
}

/**
 * "New columns detected" worklist at the top of the Review tab. Surfaces every ADP column on
 * the loaded run that the reconcile engine could not resolve to a QB account (dollars present,
 * no account rule) and lets an accountant map it right there. Saving POSTs to
 * /api/payroll/mappings { kind: 'account' }, which calls upsertAccountRule — the rule persists
 * permanently in accounting.payroll_account_map and applies to this run AND every future run
 * with that column. This panel only handles the common single-rule case; the rare employer
 * double-entry column (needs both a debit and a credit rule) is punted to the full Mappings
 * tab via the per-row "Refine in Mappings" link.
 *
 * Non-modal: it never blocks reviewing the rest of the JE below it. It renders nothing until
 * the run has actually had unmapped columns, then sticks around (showing a "done" state) once
 * they've all been resolved in this session, so the accountant gets visible confirmation rather
 * than the panel just vanishing. Give it `key={headerId}` from the caller so it resets cleanly
 * when a different draft loads.
 */
export function UnmappedColumnsPanel({
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  entity,
  unmappedColumns,
  onMapped,
  onNavigateToMappings,
}: UnmappedColumnsPanelProps) {
  const validEntity = isEntity(entity) ? entity : null;

  const [dimensions, setDimensions] = useState<DimensionsResponse | null>(null);
  const [dimensionsError, setDimensionsError] = useState<string | null>(null);
  const [dimensionsLoading, setDimensionsLoading] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [everHadColumns, setEverHadColumns] = useState(unmappedColumns.length > 0);

  useEffect(() => {
    if (unmappedColumns.length > 0) setEverHadColumns(true);
  }, [unmappedColumns.length]);

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

  const visibleColumns = useMemo(() => unmappedColumns.filter((c) => !resolved.has(c)), [unmappedColumns, resolved]);

  const handleResolved = useCallback(
    (adpColumn: string) => {
      setResolved((prev) => new Set(prev).add(adpColumn));
      onMapped();
    },
    [onMapped],
  );

  if (!everHadColumns) return null;

  const allDone = visibleColumns.length === 0;

  return (
    <div
      className={`rounded-xl shadow-sm p-4 border-2 ${cardBg} space-y-3 ${
        allDone ? border : darkMode ? 'border-amber-700' : 'border-amber-300'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles
            className={`w-4 h-4 ${allDone ? subText : darkMode ? 'text-amber-300' : 'text-amber-600'}`}
            aria-hidden
          />
          <p className="text-sm font-semibold">New columns detected</p>
        </div>
        <span className={`text-xs font-medium ${subText}`}>
          {allDone ? 'All caught up' : `${visibleColumns.length} column${visibleColumns.length === 1 ? '' : 's'} need mapping`}
        </span>
      </div>

      {allDone ? (
        <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
          Every ADP column on this run now has an account rule.
        </p>
      ) : (
        <>
          {!validEntity && (
            <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              Unrecognized entity &quot;{entity}&quot; — cannot save mapping rules from here.
            </p>
          )}
          {dimensionsError && !dimensionsLoading && (
            <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              QuickBooks dimensions unavailable ({dimensionsError}). Account field falls back to free-text.
            </p>
          )}

          <div className="space-y-2">
            {visibleColumns.map((col) => (
              <UnmappedColumnRow
                key={col}
                darkMode={darkMode}
                border={border}
                inputBg={inputBg}
                subText={subText}
                entity={validEntity}
                adpColumn={col}
                accountOptions={dimensions?.accounts ?? null}
                onSaved={() => handleResolved(col)}
                onNavigateToMappings={() => onNavigateToMappings(entity)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UnmappedColumnRow({
  darkMode,
  border,
  inputBg,
  subText,
  entity,
  adpColumn,
  accountOptions,
  onSaved,
  onNavigateToMappings,
}: {
  darkMode: boolean;
  border: string;
  inputBg: string;
  subText: string;
  entity: Entity | null;
  adpColumn: string;
  accountOptions: string[] | null;
  onSaved: () => void;
  onNavigateToMappings: () => void;
}) {
  const [accountName, setAccountName] = useState('');
  const [postingType, setPostingType] = useState<PostingType>('Debit');
  const [creditBucket, setCreditBucket] = useState<CreditBucket | null>(null);
  const [isCogs, setIsCogs] = useState(false);
  const [costCenter, setCostCenter] = useState("*");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave = entity !== null && accountName.trim().length > 0 && costCenter.trim().length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!entity || !accountName.trim() || !costCenter.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const rule: AccountMapRule = {
        entity,
        adpColumn,
        costCenter: costCenter.trim(),
        accountName: accountName.trim(),
        postingType,
        isCogs,
        creditBucket: postingType === 'Credit' ? creditBucket : null,
        active: true,
      };
      const res = await fetch('/api/payroll/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'account', rule }),
      });
      const body = (await res.json()) as { ok?: boolean; id?: number } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onSaved();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save account rule';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [entity, adpColumn, accountName, costCenter, postingType, isCogs, creditBucket, onSaved]);

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${border}`}>
      <p className="text-xs">
        New column detected: <code className="font-mono font-semibold">{adpColumn}</code> — where should this map?
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <input
          type="text"
          readOnly
          value={adpColumn}
          title="ADP column (read-only)"
          className={`rounded-md border px-2 py-1 text-xs font-mono opacity-70 cursor-not-allowed ${inputBg}`}
        />
        <input
          type="text"
          readOnly
          value={entity ?? 'Unknown entity'}
          title="Entity (from this run)"
          className={`rounded-md border px-2 py-1 text-xs opacity-70 cursor-not-allowed ${inputBg}`}
        />

        {accountOptions ? (
          <select
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          >
            <option value="">Select account…</option>
            {accountOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
            placeholder="Account name (free-text — QuickBooks unavailable)"
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          />
        )}

        <select
          value={postingType}
          onChange={(e) => setPostingType(e.target.value as PostingType)}
          className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
        >
          <option value="Debit">Debit</option>
          <option value="Credit">Credit</option>
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {postingType === 'Credit' && (
          <select
            value={creditBucket ?? ''}
            onChange={(e) => setCreditBucket((e.target.value || null) as CreditBucket | null)}
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          >
            <option value="">Credit bucket…</option>
            {CREDIT_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}

        <label className={`text-xs ${subText}`}>
          Cost center
          <input
            type="text"
            value={costCenter}
            onChange={(e) => setCostCenter(e.target.value)}
            placeholder="*"
            className={`block mt-0.5 w-28 rounded-md border px-2 py-1 text-xs ${inputBg}`}
          />
        </label>
        <p className={`text-[11px] ${subText} max-w-[220px]`}>Default &apos;*&apos; = all roles. Use LAB / ADMIN / MARKET… to scope one role.</p>

        <label className={`text-xs flex items-center gap-1.5 ${subText}`}>
          <input type="checkbox" checked={isCogs} onChange={(e) => setIsCogs(e.target.checked)} />
          COGS
        </label>

        <button
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Save className="w-3.5 h-3.5" aria-hidden />}
          {saving ? 'Saving…' : 'Save (permanent)'}
        </button>

        <button
          onClick={onNavigateToMappings}
          className={`flex items-center gap-1 text-xs font-medium ${darkMode ? 'text-blue-300 hover:text-blue-200' : 'text-blue-600 hover:text-blue-700'}`}
          title="For columns needing both a debit and a credit rule (employer double-entry)"
        >
          Refine in Mappings
          <ArrowRight className="w-3 h-3" aria-hidden />
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
