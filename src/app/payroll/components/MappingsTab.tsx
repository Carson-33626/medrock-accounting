'use client';

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import { DirectionsBanner } from './DirectionsBanner';
import { SearchableSelect } from './SearchableSelect';

/**
 * Local mirrors of the payroll mapping types (web/src/lib/payroll/types.ts) and the
 * /api/payroll/dimensions response shape. Not imported directly — src/lib/payroll/*
 * modules pull in the RDS pool (`pg`) / QuickBooks client, which must never land in a
 * client bundle.
 */
type Entity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
type PostingType = 'Debit' | 'Credit';
type CreditBucket = 'Net Pay' | 'Taxes' | 'Garnishments' | 'Retirement' | 'Health' | 'WC' | 'Other';

interface AccountMapRule {
  id?: number;
  entity: Entity;
  adpColumn: string;
  costCenter: string;
  accountName: string;
  postingType: PostingType;
  isCogs: boolean;
  creditBucket: CreditBucket | null;
  active: boolean;
  /** Department-labelled JE line memo (seed-driven, e.g. 'Accounting Wages'). Carried through
   * the edit round-trip so saving an unrelated field doesn't wipe it; null on manual rules. */
  memo: string | null;
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

interface MappingsResponse {
  accountMap: AccountMapRule[];
  employeeMap: EmployeeMapRule[];
}

/** Accounts carry their QB account number (null if none) — shown + searchable in the picker. */
interface AccountOption {
  name: string;
  acctNum: string | null;
}
interface DimensionsResponse {
  accounts: AccountOption[];
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

let nextTempId = 0;
function withKey<T>(rule: T): T & { _key: number } {
  return { ...rule, _key: nextTempId++ };
}

function blankAccountRule(entity: Entity): AccountMapRule & { _key: number } {
  return withKey({
    entity,
    adpColumn: '',
    costCenter: '*',
    accountName: '',
    postingType: 'Debit',
    isCogs: false,
    creditBucket: null,
    active: true,
    memo: null,
  });
}

function blankEmployeeRule(entity: Entity): EmployeeMapRule & { _key: number } {
  return withKey({
    entity,
    positionId: '',
    departmentName: null,
    className: null,
    cogsOverride: null,
    active: true,
  });
}

function stripKey<T extends { _key: number }>(rule: T): Omit<T, '_key'> {
  const { _key: _unused, ...rest } = rule;
  void _unused;
  return rest;
}

/**
 * Mappings tab: accounting self-serve editor for the two payroll mapping tables —
 * ADP column → GL account (account map) and position → department/class (employee map).
 * Dropdowns are populated from live QuickBooks dimensions when reachable; if QuickBooks
 * is unreachable (502), editing falls back to free-text inputs rather than blocking.
 */
interface MappingsTabProps {
  /** Pre-select an entity, e.g. when arriving via Review tab's "Refine in Mappings" link. */
  initialEntity?: string;
}

export function MappingsTab({ initialEntity }: MappingsTabProps = {}) {
  const { darkMode } = useDarkMode();

  const [entity, setEntity] = useState<Entity>(
    initialEntity && isEntity(initialEntity) ? initialEntity : 'MedRock FL',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [accountRules, setAccountRules] = useState<Array<AccountMapRule & { _key: number }>>([]);
  const [employeeRules, setEmployeeRules] = useState<Array<EmployeeMapRule & { _key: number }>>([]);

  const [dimensions, setDimensions] = useState<DimensionsResponse | null>(null);
  const [dimensionsError, setDimensionsError] = useState<string | null>(null);
  const [dimensionsLoading, setDimensionsLoading] = useState(false);
  const [employeeNames, setEmployeeNames] = useState<Record<string, string>>({});

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const loadForEntity = useCallback(async (ent: Entity) => {
    setLoading(true);
    setError(null);
    setDimensionsError(null);
    setDimensionsLoading(true);

    try {
      const res = await fetch(`/api/payroll/mappings?entity=${encodeURIComponent(ent)}`);
      const body = (await res.json()) as MappingsResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setAccountRules(body.accountMap.map(withKey));
      setEmployeeRules(body.employeeMap.map(withKey));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payroll mappings';
      setError(message);
      setAccountRules([]);
      setEmployeeRules([]);
    } finally {
      setLoading(false);
    }

    try {
      const res = await fetch(`/api/payroll/dimensions?entity=${encodeURIComponent(ent)}`);
      const body = (await res.json()) as DimensionsResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setDimensions(body);
    } catch (e) {
      // Dimensions are a convenience (dropdowns) — never block editing on this failure.
      const message = e instanceof Error ? e.message : 'QuickBooks dimensions unavailable';
      setDimensionsError(message);
      setDimensions(null);
    } finally {
      setDimensionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadForEntity(entity);
  }, [entity, loadForEntity]);

  // Position-id → name, loaded once (global, not per-entity) so the employee map can show
  // who each rule refers to. A convenience — failure just leaves rows showing the id only.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/payroll/employee-names');
        if (!res.ok) return;
        const body = (await res.json()) as { names?: Record<string, string> };
        if (!cancelled && body.names) setEmployeeNames(body.names);
      } catch {
        // ignore — names are a convenience overlay
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <DirectionsBanner darkMode={darkMode} title="What mappings do">
        <p>
          These two tables tell the JE builder how to turn raw ADP data into QuickBooks lines. Edits save
          permanently and apply to this and every future payroll.
        </p>
        <p>
          <strong>Account map</strong> — each ADP column → a GL account (grouped by column, collapsed; click a group
          to edit). <strong>Employee map</strong> — each person → their department/class (region). Pick an entity
          first, then search to find a rule fast.
        </p>
      </DirectionsBanner>

      {/* Entity selector */}
      <div className={`rounded-xl shadow-sm p-4 ${cardBg} flex flex-wrap items-end gap-3`}>
        <label className={`text-sm ${subText}`}>
          Entity
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value as Entity)}
            className={`block mt-1 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}
          >
            {ENTITIES.map((ent) => (
              <option key={ent} value={ent}>
                {ent}
              </option>
            ))}
          </select>
        </label>
        {loading && (
          <span className={`flex items-center gap-1.5 text-xs ${subText}`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
            Loading mappings…
          </span>
        )}
      </div>

      {error && (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-red-950/40 border-red-800 text-red-200' : 'bg-red-50 border-red-300 text-red-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      {dimensionsError && !dimensionsLoading && (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            QuickBooks dimensions unavailable ({dimensionsError}). Account/department/class fields are free-text
            until QuickBooks is reachable again — editing is not blocked.
          </p>
        </div>
      )}

      <AccountMapEditor
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
        border={border}
        inputBg={inputBg}
        entity={entity}
        rules={accountRules}
        setRules={setAccountRules}
        accountOptions={dimensions?.accounts ?? null}
      />

      <EmployeeMapEditor
        darkMode={darkMode}
        cardBg={cardBg}
        subText={subText}
        border={border}
        inputBg={inputBg}
        entity={entity}
        rules={employeeRules}
        setRules={setEmployeeRules}
        departmentOptions={dimensions?.departments ?? null}
        classOptions={dimensions?.classes ?? null}
        employeeNames={employeeNames}
      />
    </div>
  );
}

// ── Account map editor ──────────────────────────────────────────────────────

function AccountMapEditor({
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  entity,
  rules,
  setRules,
  accountOptions,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  entity: Entity;
  rules: Array<AccountMapRule & { _key: number }>;
  setRules: Dispatch<SetStateAction<Array<AccountMapRule & { _key: number }>>>;
  accountOptions: AccountOption[] | null;
}) {
  const update = useCallback(
    (key: number, patch: Partial<AccountMapRule>) => {
      setRules((prev) => prev.map((r) => (r._key === key ? { ...r, ...patch } : r)));
    },
    [setRules],
  );

  const remove = useCallback(
    (key: number) => {
      setRules((prev) => prev.filter((r) => r._key !== key));
    },
    [setRules],
  );

  const addRow = useCallback(() => {
    setRules((prev) => [...prev, blankAccountRule(entity)]);
  }, [entity, setRules]);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Unsaved rows (id === undefined) stay pinned + open at top so a just-added rule is always
  // visible; saved rows are grouped by ADP column and collapsed by default to tame the list.
  const newRules = rules.filter((r) => r.id === undefined);
  const savedRules = rules.filter((r) => r.id !== undefined);

  const q = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const matched = q
      ? savedRules.filter(
          (r) =>
            r.adpColumn.toLowerCase().includes(q) ||
            r.accountName.toLowerCase().includes(q) ||
            r.costCenter.toLowerCase().includes(q),
        )
      : savedRules;
    const byColumn = new Map<string, Array<AccountMapRule & { _key: number }>>();
    for (const r of matched) {
      const list = byColumn.get(r.adpColumn) ?? [];
      list.push(r);
      byColumn.set(r.adpColumn, list);
    }
    return [...byColumn.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [savedRules, q]);

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          Account map <span className={`font-normal ${subText}`}>({rules.length} rules · {groups.length} columns)</span>
        </p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className={`w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 ${subText}`} aria-hidden />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search column / account…"
              className={`rounded-md border pl-7 pr-2 py-1 text-xs w-52 ${inputBg}`}
            />
          </div>
          <button
            onClick={addRow}
            className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${
              darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            Add rule
          </button>
        </div>
      </div>

      {rules.length === 0 && <p className={`text-xs ${subText}`}>No account rules for {entity} yet.</p>}

      {newRules.length > 0 && (
        <div className="space-y-2">
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>New / unsaved</p>
          {newRules.map((rule) => (
            <AccountRuleRow
              key={rule._key}
              darkMode={darkMode}
              border={border}
              inputBg={inputBg}
              subText={subText}
              rule={rule}
              accountOptions={accountOptions}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        {groups.map(([column, groupRules]) => {
          const open = expanded.has(column) || q.length > 0;
          return (
            <div key={column} className={`rounded-lg border ${border}`}>
              <button
                onClick={() => toggle(column)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  darkMode ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50'
                }`}
              >
                {open ? <ChevronDown className="w-4 h-4 shrink-0" aria-hidden /> : <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />}
                <span className="font-medium truncate">{column || '(blank column)'}</span>
                <span className={`ml-auto text-xs ${subText}`}>
                  {groupRules.length} rule{groupRules.length === 1 ? '' : 's'}
                </span>
              </button>
              {open && (
                <div className={`px-3 pb-3 pt-1 space-y-2 border-t ${border}`}>
                  {groupRules.map((rule) => (
                    <AccountRuleRow
                      key={rule._key}
                      darkMode={darkMode}
                      border={border}
                      inputBg={inputBg}
                      subText={subText}
                      rule={rule}
                      accountOptions={accountOptions}
                      onUpdate={update}
                      onRemove={remove}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {q.length > 0 && groups.length === 0 && (
          <p className={`text-xs ${subText}`}>No saved rules match “{search}”.</p>
        )}
      </div>
    </div>
  );
}

function AccountRuleRow({
  darkMode,
  border,
  inputBg,
  subText,
  rule,
  accountOptions,
  onUpdate,
  onRemove,
}: {
  darkMode: boolean;
  border: string;
  inputBg: string;
  subText: string;
  rule: AccountMapRule & { _key: number };
  accountOptions: AccountOption[] | null;
  onUpdate: (key: number, patch: Partial<AccountMapRule>) => void;
  onRemove: (key: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/payroll/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'account', rule: stripKey(rule) }),
      });
      const body = (await res.json()) as { ok?: boolean; id?: number } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      if (rule.id === undefined && typeof body.id === 'number') {
        onUpdate(rule._key, { id: body.id });
      }
      setSaved(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save account rule';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [rule, onUpdate]);

  const handleDelete = useCallback(async () => {
    if (rule.id === undefined) {
      onRemove(rule._key);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/payroll/mappings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'account', id: rule.id }),
      });
      const body = (await res.json()) as { ok?: boolean } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onRemove(rule._key);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to delete account rule';
      setDeleteError(message);
    } finally {
      setDeleting(false);
    }
  }, [rule, onRemove]);

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${border}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <input
          type="text"
          value={rule.adpColumn}
          onChange={(e) => onUpdate(rule._key, { adpColumn: e.target.value })}
          placeholder="ADP column (e.g. REGULAR PAY - EARNING)"
          className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
        />

        <input
          type="text"
          value={rule.costCenter}
          onChange={(e) => onUpdate(rule._key, { costCenter: e.target.value })}
          placeholder="Cost center ('*' = all roles, or LAB / ADMIN / MARKET…)"
          className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
        />

        {accountOptions ? (
          <SearchableSelect
            value={rule.accountName}
            onChange={(v) => onUpdate(rule._key, { accountName: v })}
            options={accountOptions.map((a) => ({ value: a.name, label: a.name, hint: a.acctNum }))}
            placeholder="Select account…"
            darkMode={darkMode}
            inputBg={inputBg}
            ariaLabel="Account"
          />
        ) : (
          <input
            type="text"
            value={rule.accountName}
            onChange={(e) => onUpdate(rule._key, { accountName: e.target.value })}
            placeholder="Account name (free-text — QuickBooks unavailable)"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
        )}

        <select
          value={rule.creditBucket ?? ''}
          onChange={(e) => onUpdate(rule._key, { creditBucket: (e.target.value || null) as CreditBucket | null })}
          className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
        >
          <option value="">Credit bucket…</option>
          {CREDIT_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      <label className="block">
        <span className={`block text-xs mb-0.5 ${subText}`}>
          JE line memo — department label on the posted line (prefilled from the seed; edit freely; blank ⇒ uses the credit bucket)
        </span>
        <input
          type="text"
          value={rule.memo ?? ''}
          onChange={(e) => onUpdate(rule._key, { memo: e.target.value.trim() === '' ? null : e.target.value })}
          placeholder="e.g. Accounting Wages · ER Taxes - Admin · WC - Shipping"
          className={`w-full rounded-md border px-2 py-1 text-sm ${inputBg}`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={rule.postingType}
          onChange={(e) => onUpdate(rule._key, { postingType: e.target.value as PostingType })}
          className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
        >
          <option value="Debit">Debit</option>
          <option value="Credit">Credit</option>
        </select>

        <label className={`text-xs flex items-center gap-1.5 ${subText}`}>
          <input
            type="checkbox"
            checked={rule.isCogs}
            onChange={(e) => onUpdate(rule._key, { isCogs: e.target.checked })}
          />
          COGS
        </label>

        <label className={`text-xs flex items-center gap-1.5 ${subText}`}>
          <input
            type="checkbox"
            checked={rule.active}
            onChange={(e) => onUpdate(rule._key, { active: e.target.checked })}
          />
          Active
        </label>

        <button
          onClick={() => void handleSave()}
          disabled={saving || !rule.adpColumn || !rule.costCenter || !rule.accountName}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Save className="w-3.5 h-3.5" aria-hidden />}
          {saving ? 'Saving…' : 'Save'}
        </button>

        <button
          onClick={() => void handleDelete()}
          disabled={deleting}
          aria-label="Delete rule"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-50 ${
            darkMode ? 'border-red-800 text-red-300 hover:bg-red-950/40' : 'border-red-300 text-red-700 hover:bg-red-50'
          }`}
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Trash2 className="w-3.5 h-3.5" aria-hidden />}
        </button>

        {saved && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`}>
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
            Saved
          </span>
        )}
        {saveError && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
            <XCircle className="w-3.5 h-3.5" aria-hidden />
            {saveError}
          </span>
        )}
        {deleteError && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
            <XCircle className="w-3.5 h-3.5" aria-hidden />
            {deleteError}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Employee map editor ─────────────────────────────────────────────────────

function EmployeeMapEditor({
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  entity,
  rules,
  setRules,
  departmentOptions,
  classOptions,
  employeeNames,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  entity: Entity;
  rules: Array<EmployeeMapRule & { _key: number }>;
  setRules: Dispatch<SetStateAction<Array<EmployeeMapRule & { _key: number }>>>;
  departmentOptions: string[] | null;
  classOptions: string[] | null;
  employeeNames: Record<string, string>;
}) {
  const update = useCallback(
    (key: number, patch: Partial<EmployeeMapRule>) => {
      setRules((prev) => prev.map((r) => (r._key === key ? { ...r, ...patch } : r)));
    },
    [setRules],
  );

  const remove = useCallback(
    (key: number) => {
      setRules((prev) => prev.filter((r) => r._key !== key));
    },
    [setRules],
  );

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const addRow = useCallback(() => {
    setRules((prev) => [...prev, blankEmployeeRule(entity)]);
    setOpen(true);
  }, [entity, setRules]);

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return rules;
    // Keep unsaved rows visible regardless of the filter so a just-added rule doesn't hide.
    return rules.filter(
      (r) =>
        r.id === undefined ||
        r.positionId.toLowerCase().includes(q) ||
        (employeeNames[r.positionId] ?? '').toLowerCase().includes(q) ||
        (r.departmentName ?? '').toLowerCase().includes(q) ||
        (r.className ?? '').toLowerCase().includes(q),
    );
  }, [rules, q, employeeNames]);

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-sm font-semibold">
          {open ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
          Employee map <span className={`font-normal ${subText}`}>({rules.length})</span>
        </button>
        <div className="flex items-center gap-2">
          {open && (
            <div className="relative">
              <Search className={`w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 ${subText}`} aria-hidden />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name / position / region…"
                className={`rounded-md border pl-7 pr-2 py-1 text-xs w-52 ${inputBg}`}
              />
            </div>
          )}
          <button
            onClick={addRow}
            className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${
              darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden />
            Add rule
          </button>
        </div>
      </div>

      {open && (
        <>
          {rules.length === 0 && <p className={`text-xs ${subText}`}>No employee rules for {entity} yet.</p>}
          {q.length > 0 && visible.length === 0 && (
            <p className={`text-xs ${subText}`}>No rules match “{search}”.</p>
          )}
          <div className="space-y-2">
            {visible.map((rule) => (
              <EmployeeRuleRow
                key={rule._key}
                darkMode={darkMode}
                border={border}
                inputBg={inputBg}
                subText={subText}
                rule={rule}
                departmentOptions={departmentOptions}
                classOptions={classOptions}
                employeeName={employeeNames[rule.positionId] ?? null}
                onUpdate={update}
                onRemove={remove}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EmployeeRuleRow({
  darkMode,
  border,
  inputBg,
  subText,
  rule,
  departmentOptions,
  classOptions,
  employeeName,
  onUpdate,
  onRemove,
}: {
  darkMode: boolean;
  border: string;
  inputBg: string;
  subText: string;
  rule: EmployeeMapRule & { _key: number };
  departmentOptions: string[] | null;
  classOptions: string[] | null;
  employeeName: string | null;
  onUpdate: (key: number, patch: Partial<EmployeeMapRule>) => void;
  onRemove: (key: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/payroll/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'employee', rule: stripKey(rule) }),
      });
      const body = (await res.json()) as { ok?: boolean; id?: number } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      if (rule.id === undefined && typeof body.id === 'number') {
        onUpdate(rule._key, { id: body.id });
      }
      setSaved(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save employee rule';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [rule, onUpdate]);

  const handleDelete = useCallback(async () => {
    if (rule.id === undefined) {
      onRemove(rule._key);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/payroll/mappings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'employee', id: rule.id }),
      });
      const body = (await res.json()) as { ok?: boolean } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onRemove(rule._key);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to delete employee rule';
      setDeleteError(message);
    } finally {
      setDeleting(false);
    }
  }, [rule, onRemove]);

  // Tri-state cogsOverride: '' = unset (null), 'true' = true, 'false' = false.
  const cogsOverrideValue = rule.cogsOverride === null ? '' : String(rule.cogsOverride);

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${border}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <div>
          <input
            type="text"
            value={rule.positionId}
            onChange={(e) => onUpdate(rule._key, { positionId: e.target.value })}
            placeholder="Position ID"
            className={`w-full rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
          <p className={`mt-0.5 text-[11px] truncate ${subText}`} title={employeeName ?? undefined}>
            {employeeName ?? 'No matching employee'}
          </p>
        </div>

        {departmentOptions ? (
          <SearchableSelect
            value={rule.departmentName ?? ''}
            onChange={(v) => onUpdate(rule._key, { departmentName: v || null })}
            options={departmentOptions.map((d) => ({ value: d, label: d }))}
            placeholder="Select department…"
            darkMode={darkMode}
            inputBg={inputBg}
            ariaLabel="Department"
          />
        ) : (
          <input
            type="text"
            value={rule.departmentName ?? ''}
            onChange={(e) => onUpdate(rule._key, { departmentName: e.target.value || null })}
            placeholder="Department (free-text — QuickBooks unavailable)"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
        )}

        {classOptions ? (
          <SearchableSelect
            value={rule.className ?? ''}
            onChange={(v) => onUpdate(rule._key, { className: v || null })}
            options={classOptions.map((c) => ({ value: c, label: c }))}
            placeholder="Select class…"
            darkMode={darkMode}
            inputBg={inputBg}
            ariaLabel="Class"
          />
        ) : (
          <input
            type="text"
            value={rule.className ?? ''}
            onChange={(e) => onUpdate(rule._key, { className: e.target.value || null })}
            placeholder="Class (free-text — QuickBooks unavailable)"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className={`text-xs flex items-center gap-1.5 ${subText}`}>
          COGS override
          <select
            value={cogsOverrideValue}
            onChange={(e) =>
              onUpdate(rule._key, { cogsOverride: e.target.value === '' ? null : e.target.value === 'true' })
            }
            className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
          >
            <option value="">Unset</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        </label>

        <label className={`text-xs flex items-center gap-1.5 ${subText}`}>
          <input
            type="checkbox"
            checked={rule.active}
            onChange={(e) => onUpdate(rule._key, { active: e.target.checked })}
          />
          Active
        </label>

        <button
          onClick={() => void handleSave()}
          disabled={saving || !rule.positionId}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Save className="w-3.5 h-3.5" aria-hidden />}
          {saving ? 'Saving…' : 'Save'}
        </button>

        <button
          onClick={() => void handleDelete()}
          disabled={deleting}
          aria-label="Delete rule"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-50 ${
            darkMode ? 'border-red-800 text-red-300 hover:bg-red-950/40' : 'border-red-300 text-red-700 hover:bg-red-50'
          }`}
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Trash2 className="w-3.5 h-3.5" aria-hidden />}
        </button>

        {saved && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`}>
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
            Saved
          </span>
        )}
        {saveError && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
            <XCircle className="w-3.5 h-3.5" aria-hidden />
            {saveError}
          </span>
        )}
        {deleteError && (
          <span className={`flex items-center gap-1 text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
            <XCircle className="w-3.5 h-3.5" aria-hidden />
            {deleteError}
          </span>
        )}
      </div>
    </div>
  );
}
