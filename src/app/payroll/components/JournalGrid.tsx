'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  applyAmountEdit,
  sourceNamesPreview,
  groupSourceDetail,
  type CreditBucket,
  type JournalLine,
  type LineOrigin,
  type PostingType,
  type RosterName,
} from './journal-grid.helpers';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

const CREDIT_BUCKETS: CreditBucket[] = ['Net Pay', 'Taxes', 'Garnishments', 'Retirement', 'Health', 'WC', 'Other'];

const ORIGIN_BADGE: Record<LineOrigin, string> = {
  generated: 'gen',
  manual: 'man',
  inter_entity: 'i·e',
};

export interface JournalGridProps {
  lines: Array<JournalLine & { _key: number }>;
  roster: RosterName[];
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  onUpdate: (key: number, patch: Partial<JournalLine>) => void;
  onRemove: (key: number) => void;
  onAdd: () => void;
}

export function JournalGrid({
  lines,
  roster,
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  onUpdate,
  onRemove,
  onAdd,
}: JournalGridProps) {
  const totalDebits = round2(
    lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
  );
  const totalCredits = round2(
    lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
  );

  const headCell = `text-left text-[11px] font-semibold uppercase tracking-wider px-2 py-2 ${subText}`;
  const cell = 'px-2 py-1.5 align-top';

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-3`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1024px] table-fixed border-collapse text-sm">
          <thead>
            <tr className={`border-b ${border}`}>
              <th className={`${headCell} w-10`}>#</th>
              <th className={headCell}>Account</th>
              <th className={`${headCell} text-right w-32`}>Debits</th>
              <th className={`${headCell} text-right w-32`}>Credits</th>
              <th className={`${headCell} w-48`}>Description</th>
              <th className={`${headCell} w-32`}>Name</th>
              <th className={`${headCell} w-40`}>Location</th>
              <th className={`${headCell} w-28`}>Class</th>
              <th className={`${headCell} w-10`}></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td className={`${cell} ${subText} text-xs`} colSpan={9}>
                  No lines.
                </td>
              </tr>
            )}
            {lines.map((line, i) => (
              <JournalGridRow
                key={line._key}
                index={i + 1}
                line={line}
                roster={roster}
                darkMode={darkMode}
                subText={subText}
                border={border}
                inputBg={inputBg}
                cell={cell}
                onUpdate={onUpdate}
                onRemove={onRemove}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className={`border-t ${border} font-semibold`}>
              <td className={cell}></td>
              <td className={`${cell} text-right`}>Total</td>
              <td className={`${cell} text-right tabular-nums`}>{usd.format(totalDebits)}</td>
              <td className={`${cell} text-right tabular-nums`}>{usd.format(totalCredits)}</td>
              <td className={cell} colSpan={5}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <button
        onClick={onAdd}
        className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${
          darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
        }`}
      >
        <Plus className="w-3.5 h-3.5" aria-hidden />
        Add line
      </button>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function JournalGridRow({
  index,
  line,
  roster,
  darkMode,
  subText,
  border,
  inputBg,
  cell,
  onUpdate,
  onRemove,
}: {
  index: number;
  line: JournalLine & { _key: number };
  roster: RosterName[];
  darkMode: boolean;
  subText: string;
  border: string;
  inputBg: string;
  cell: string;
  onUpdate: (key: number, patch: Partial<JournalLine>) => void;
  onRemove: (key: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sourceRows, setSourceRows] = useState<DrilldownRowDetail[] | null>(null);
  const editable = line.origin !== 'generated';
  const amountMissing = !(Number(line.amount) > 0);
  const reqRing = 'border-red-500 ring-1 ring-red-500';
  const numInput = `w-full text-right rounded-md border px-2 py-1 text-sm tabular-nums ${inputBg}`;
  const txtInput = `w-full rounded-md border px-2 py-1 text-sm ${inputBg}`;

  const debitVal = line.postingType === 'Debit' ? String(line.amount) : '';
  const creditVal = line.postingType === 'Credit' ? String(line.amount) : '';
  const namePreview = sourceNamesPreview(line.sourceRowKeys, roster);

  const editAmount = (side: PostingType, raw: string): void => {
    onUpdate(line._key, applyAmountEdit(line, side, Number(raw)));
  };

  return (
    <>
      <tr className={`border-b ${border}`}>
        <td className={`${cell} ${subText} tabular-nums`}>{index}</td>
        <td className={cell}>
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 text-[10px] font-medium rounded px-1 py-0.5 border ${
                darkMode ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-500'
              }`}
              title={line.origin}
            >
              {ORIGIN_BADGE[line.origin]}
            </span>
            {editable ? (
              <input
                type="text"
                value={line.accountName}
                onChange={(e) => onUpdate(line._key, { accountName: e.target.value })}
                placeholder="Account"
                className={`${txtInput} ${line.accountName.trim() === '' ? reqRing : ''}`}
              />
            ) : (
              <ScrollingText text={line.accountName} className={`${txtInput} opacity-70`} />
            )}
          </div>
        </td>
        <td className={cell}>
          <div className="relative">
            {debitVal !== '' && (
              <span className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs ${subText}`} aria-hidden>
                $
              </span>
            )}
            <input
              type="number"
              step="0.01"
              value={debitVal}
              onChange={(e) => editAmount('Debit', e.target.value)}
              readOnly={!editable && line.postingType !== 'Debit'}
              className={`${numInput} ${debitVal !== '' ? 'pl-5' : ''} ${line.postingType === 'Debit' && amountMissing ? reqRing : ''}`}
            />
          </div>
        </td>
        <td className={cell}>
          <div className="relative">
            {creditVal !== '' && (
              <span className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs ${subText}`} aria-hidden>
                $
              </span>
            )}
            <input
              type="number"
              step="0.01"
              value={creditVal}
              onChange={(e) => editAmount('Credit', e.target.value)}
              readOnly={!editable && line.postingType !== 'Credit'}
              className={`${numInput} ${creditVal !== '' ? 'pl-5' : ''} ${line.postingType === 'Credit' && amountMissing ? reqRing : ''}`}
            />
          </div>
        </td>
        <td className={cell}>
          <input
            type="text"
            value={line.memo}
            onChange={(e) => onUpdate(line._key, { memo: e.target.value })}
            placeholder="Description"
            className={txtInput}
          />
        </td>
        <td className={cell}>
          {line.sourceRowKeys.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className={`inline-flex items-center gap-1 text-xs ${subText} hover:underline`}
              title="Show source people"
            >
              {expanded ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
              {namePreview}
            </button>
          ) : (
            <span className={`text-xs ${subText}`}>—</span>
          )}
        </td>
        <td className={cell}>
          <input
            type="text"
            value={line.departmentName ?? ''}
            onChange={(e) => onUpdate(line._key, { departmentName: e.target.value || null })}
            placeholder="Location"
            className={txtInput}
          />
        </td>
        <td className={cell}>
          <input
            type="text"
            value={line.className ?? ''}
            onChange={(e) => onUpdate(line._key, { className: e.target.value || null })}
            placeholder="Class"
            className={txtInput}
          />
        </td>
        <td className={`${cell} text-right`}>
          <button
            onClick={() => onRemove(line._key)}
            className={`p-1.5 rounded-md ${darkMode ? 'text-red-300 hover:bg-red-950/40' : 'text-red-600 hover:bg-red-50'}`}
            aria-label="Remove line"
            title="Remove line"
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        </td>
      </tr>

      {line.postingType === 'Credit' && (
        <tr className={`border-b ${border}`}>
          <td className={cell}></td>
          <td className={`${cell}`} colSpan={8}>
            <label className={`text-xs ${subText} inline-flex items-center gap-1.5`}>
              Bucket
              <select
                value={line.creditBucket ?? ''}
                onChange={(e) => onUpdate(line._key, { creditBucket: (e.target.value || null) as CreditBucket | null })}
                className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
              >
                <option value="">Bucket…</option>
                {CREDIT_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </td>
        </tr>
      )}

      {expanded && line.sourceRowKeys.length > 0 && (
        <tr>
          <td className={cell}></td>
          <td className={cell} colSpan={8}>
            <SourceRowsDetail
              rowKeys={line.sourceRowKeys}
              darkMode={darkMode}
              subText={subText}
              border={border}
              cached={sourceRows}
              onLoaded={setSourceRows}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Source-person detail (moved from ReviewTab's SourceRowsPanel) ────────────

interface DrilldownRowDetail {
  row_key: string;
  position_id: string;
  name: string;
  pay_date: string;
  pay_group: string;
  sensitive: Record<string, number | string | null>;
}

/**
 * Per-person source detail for a line, fetched lazily on first expand.
 * Read-only + decrypt-gated: hits /api/payroll/drilldown, which re-decrypts each row
 * server-side and never persists or logs the plaintext. Do NOT log the response.
 */
function SourceRowsDetail({
  rowKeys,
  darkMode,
  subText,
  border,
  cached,
  onLoaded,
}: {
  rowKeys: string[];
  darkMode: boolean;
  subText: string;
  border: string;
  cached: DrilldownRowDetail[] | null;
  onLoaded: (rows: DrilldownRowDetail[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        rowKeys.map(async (k) => {
          const res = await fetch(`/api/payroll/drilldown?rowKey=${encodeURIComponent(k)}`);
          if (!res.ok) {
            const body: { error?: string } = await res.json().catch(() => ({}));
            throw new Error(body.error ?? `drilldown failed (${res.status})`);
          }
          return (await res.json()) as DrilldownRowDetail;
        }),
      );
      // Do NOT log `results` — it carries decrypted per-employee detail.
      onLoaded(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load source rows');
    } finally {
      setLoading(false);
    }
  }, [rowKeys, onLoaded]);

  useEffect(() => {
    if (cached !== null) return; // already cached by the parent — no re-fetch on re-expand
    if (startedRef.current) return;
    startedRef.current = true;
    void load();
  }, [load, cached]);

  return (
    <div className="text-[11px] space-y-3 py-1">
      {loading && (
        <p className={`flex items-center gap-1 ${subText}`}>
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          Loading source detail…
        </p>
      )}
      {error && <p className="text-red-500">{error}</p>}
      {cached?.map((r) => {
        const sections = groupSourceDetail(r.sensitive);
        return (
          // One bordered card per member so a split line's members never visually blend.
          <div key={r.row_key} className={`rounded-lg border-2 overflow-hidden ${border}`}>
            <div
              className={`px-2.5 py-1.5 font-semibold text-[12px] border-b ${border} ${
                darkMode ? 'bg-slate-800' : 'bg-slate-100'
              }`}
            >
              {r.name} <span className={`font-normal ${subText}`}>· {r.position_id}</span>
            </div>
            <div className="p-2">
              {sections.length === 0 ? (
                <span className={subText}>no dollar detail</span>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {sections.map((s) => (
                    <div key={s.group} className={`rounded border ${border} overflow-hidden`}>
                      <div className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide border-b ${border} ${subText}`}>
                        {s.group}
                      </div>
                      <table className="w-full">
                        <tbody>
                          {s.rows.map((row) => (
                            <tr key={row.label} className={`border-b last:border-0 ${border}`}>
                              <td className="px-2 py-0.5">{row.label}</td>
                              <td className="px-2 py-0.5 text-right tabular-nums whitespace-nowrap">{row.display}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {cached && cached.length === 0 && <p className={subText}>No source rows.</p>}
    </div>
  );
}

// ── Marquee for long read-only account names (moved from ReviewTab) ──────────

function ScrollingText({ text, className }: { text: string; className: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<{ x: number; dur: number }>({ x: 0, dur: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const span = spanRef.current;
    if (!container || !span) return;

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const clear = (): void => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };

    const HOLD = 2000;
    const run = (): void => {
      clear();
      const overflow = Math.ceil(container.scrollWidth - container.clientWidth);
      if (overflow <= 1) {
        setStyle({ x: 0, dur: 0 });
        return;
      }
      const travel = Math.max(1200, overflow * 14);
      const cycle = (): void => {
        setStyle({ x: 0, dur: 0 });
        timers.push(
          setTimeout(() => {
            setStyle({ x: -overflow, dur: travel });
            timers.push(setTimeout(cycle, travel + HOLD));
          }, HOLD),
        );
      };
      cycle();
    };

    run();
    window.addEventListener('resize', run);
    return () => {
      clear();
      window.removeEventListener('resize', run);
    };
  }, [text]);

  return (
    <div ref={containerRef} className={`overflow-hidden whitespace-nowrap ${className}`} title={text}>
      <span
        ref={spanRef}
        className="inline-block align-middle will-change-transform"
        style={{
          transform: `translateX(${style.x}px)`,
          transition: style.dur ? `transform ${style.dur}ms linear` : 'none',
        }}
      >
        {text}
      </span>
    </div>
  );
}
