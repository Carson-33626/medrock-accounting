'use client';

import Image from 'next/image';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { DepositType } from '@/lib/deposits/naming';
import { toOcrReadyFile } from '@/lib/deposits/toOcrReadyFile';
import type { DepositSuggestions } from '@/lib/deposits/extractDepositFields';
import { INITIAL_FLOW, reduceFlow } from '@/lib/deposits/depositFlow';

interface UploadResult {
  originalName: string;
  status: 'ok' | 'error';
  fileName?: string;
  fileId?: string;
  removalToken?: string;
  error?: string;
}

interface Props {
  defaultLocation: string;
}

// Mirrors the server-side ceilings in src/app/api/deposits/upload/route.ts —
// checked here too so a phone that just grabbed 25 photos gets an instant,
// specific message instead of waiting on a slow upload that was always going
// to be rejected.
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

type LocationsStatus = 'loading' | 'ready' | 'unavailable';

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// A single camera capture and a multi-select gallery pick both feed the batch
// list. Defensively de-duped on name+size+lastModified so re-tapping a picker
// (or the same file surfacing from both inputs) doesn't double up an item.
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mergeFiles(existing: File[], incoming: File[]): File[] {
  const seen = new Set(existing.map(fileKey));
  const merged = [...existing];
  for (const file of incoming) {
    const key = fileKey(file);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(file);
    }
  }
  return merged;
}

export function DepositUploader({ defaultLocation }: Props) {
  const { darkMode } = useDarkMode();

  // Photo-first phase machine (idle/scanning/review/submitting/result).
  const [flow, dispatchFlow] = useReducer(reduceFlow, INITIAL_FLOW);
  // Orthogonal secondary path: the multi-file batch uploader. Mutually
  // exclusive with the photo-flow screens at render time.
  const [batchOpen, setBatchOpen] = useState(false);

  // GET /api/deposits/locations returns 200 { locations: [] } both when the
  // Drive folder is genuinely empty and when it's misconfigured — the two
  // are indistinguishable from here. Either way an empty list means nobody
  // can file anything, so it's treated as "unavailable," not "nothing to
  // show," and the form is blocked with a message to contact IT.
  const [locationsStatus, setLocationsStatus] = useState<LocationsStatus>('loading');
  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState(defaultLocation);
  const [date, setDate] = useState(todayIso());
  const [type, setType] = useState<DepositType>('Deposit');
  const [amount, setAmount] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which fields currently show a value pulled from the last scan; drives the
  // "please verify" banner. Cleared when the user edits a field or resets.
  const [scannedFields, setScannedFields] = useState<Set<'date' | 'type' | 'amount'>>(new Set());
  // Session history — accumulates newest-first across this page session.
  const [results, setResults] = useState<UploadResult[]>([]);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  // Incremented on every fetch kickoff (initial load or a "Try again" retry)
  // and again on unmount, so an in-flight response can tell it's gone stale
  // and skip applying itself.
  const locationsRequestRef = useRef(0);

  const loadLocations = useCallback(() => {
    const requestId = ++locationsRequestRef.current;
    setLocationsStatus('loading');
    void (async () => {
      try {
        // 10s timeout: a hung connection must land in "unavailable" (with a
        // retry option) rather than leaving the form disabled forever.
        const response = await fetch('/api/deposits/locations', { signal: AbortSignal.timeout(10_000) });
        if (locationsRequestRef.current !== requestId) return;
        if (!response.ok) {
          setLocationsStatus('unavailable');
          return;
        }
        const body = (await response.json()) as { locations?: string[] };
        if (locationsRequestRef.current !== requestId) return;
        const list = body.locations ?? [];
        if (list.length === 0) {
          setLocationsStatus('unavailable');
          return;
        }
        setLocations(list);
        setLocationsStatus('ready');
        // A pre-selected location (from the user's profile) that isn't one of
        // the real Drive folders shouldn't be submitted silently — fall back
        // to an explicit unselected state instead.
        setLocation((current) => (current && list.includes(current) ? current : ''));
      } catch {
        if (locationsRequestRef.current === requestId) setLocationsStatus('unavailable');
      }
    })();
  }, []);

  useEffect(() => {
    loadLocations();
    return () => {
      locationsRequestRef.current += 1;
    };
  }, [loadLocations]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Object-URL lifecycle for the review thumbnail — always the first (photo
  // flow only ever has one) file. Revoked when the file changes or on unmount.
  useEffect(() => {
    const current = files[0];
    if (!current) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(current);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [files]);

  // Success modal auto-dismiss: after a short beat, clear the form and reset
  // to idle so the next deposit starts clean. The prepended history entry
  // (set in onSubmitPhoto) is what the user sees on the idle screen.
  useEffect(() => {
    if (flow.phase !== 'result' || flow.outcome !== 'success') return;
    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      setDate(todayIso());
      setType('Deposit');
      setAmount('');
      setLocation(locations.includes(defaultLocation) ? defaultLocation : '');
      setFiles([]);
      setScannedFields(new Set());
      setError(null);
      if (fileInput.current) fileInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
      dispatchFlow({ type: 'RESET' });
    }, 2500);
    return () => clearTimeout(timer);
  }, [flow.phase, flow.outcome, locations, defaultLocation]);

  // Batch path: a camera capture and a gallery pick both accumulate here.
  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setFiles((current) => mergeFiles(current, Array.from(incoming)));
  }, []);

  // Photo path: single capture/pick -> normalize (HEIC/WebP->JPEG), OCR,
  // pre-fill fields, advance to review. Best-effort — any failure just leaves
  // the fields blank for manual entry; the (converted) file is still queued.
  const scanSingle = useCallback(async (incoming: FileList | null) => {
    const first = incoming?.[0];
    if (!first) return;

    setError(null);
    dispatchFlow({ type: 'CAPTURE' });
    try {
      const ready = await toOcrReadyFile(first);
      setFiles([ready]);

      const form = new FormData();
      form.set('file', ready);
      const response = await fetch('/api/deposits/ocr', { method: 'POST', body: form });
      if (!mountedRef.current) return;

      const body = (await response.json().catch(() => null)) as { suggestions?: DepositSuggestions } | null;
      const suggestions = body?.suggestions;
      if (suggestions) {
        const applied = new Set<'date' | 'type' | 'amount'>();
        if (suggestions.date) {
          setDate(suggestions.date);
          applied.add('date');
        }
        if (suggestions.type) {
          setType(suggestions.type);
          applied.add('type');
        }
        if (suggestions.amount) {
          // The amount text field holds a bare number; the upload route re-parses it.
          setAmount(suggestions.amount.replace(/^\$/, ''));
          applied.add('amount');
        }
        if (mountedRef.current) setScannedFields(applied);
      }
    } catch {
      // Non-fatal — the file is still queued; the user fills the fields manually.
    } finally {
      // Always advance to review, even on OCR failure (best-effort invariant).
      if (mountedRef.current) dispatchFlow({ type: 'SCAN_DONE' });
    }
  }, []);

  const validate = useCallback((): string | null => {
    if (locationsStatus !== 'ready') return 'Locations are not available yet — see the notice above.';
    if (!location) return 'Pick a location.';
    if (files.length === 0) return 'Add at least one photo.';
    if (files.length > MAX_FILES) return `Send at most ${MAX_FILES} files at a time.`;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return 'Those files are too large together — send fewer at a time.';
    return null;
  }, [locationsStatus, location, files]);

  const runUpload = useCallback(async (): Promise<{ ok: boolean; results: UploadResult[]; error?: string }> => {
    const form = new FormData();
    form.set('location', location);
    form.set('date', date);
    form.set('type', type);
    form.set('amount', amount);
    for (const file of files) form.append('files', file);

    const response = await fetch('/api/deposits/upload', { method: 'POST', body: form });
    const body = (await response.json()) as { results?: UploadResult[]; error?: string };
    if (!response.ok) return { ok: false, results: [], error: body.error ?? 'Upload failed.' };
    return { ok: true, results: body.results ?? [] };
  }, [location, date, type, amount, files]);

  // Photo-flow submit: drives the phase machine + result modal.
  const onSubmitPhoto = useCallback(async () => {
    setError(null);
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }

    dispatchFlow({ type: 'SUBMIT' });
    setBusy(true);
    try {
      const res = await runUpload();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(res.error ?? 'Upload failed.');
        dispatchFlow({ type: 'SUBMIT_ERROR' });
        return;
      }
      setResults((prev) => [...res.results, ...prev]);
      dispatchFlow({ type: 'SUBMIT_SUCCESS' });
    } catch {
      if (mountedRef.current) {
        setError('Upload failed — check your connection and try again.');
        dispatchFlow({ type: 'SUBMIT_ERROR' });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [validate, runUpload]);

  // Batch-flow submit: today's inline behavior (no modal), prepends to history.
  const onSubmitBatch = useCallback(async () => {
    setError(null);
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }

    setBusy(true);
    try {
      const res = await runUpload();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(res.error ?? 'Upload failed.');
        return;
      }
      setResults((prev) => [...res.results, ...prev]);
      setFiles([]);
      setScannedFields(new Set());
      if (fileInput.current) fileInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
    } catch {
      if (mountedRef.current) setError('Upload failed — check your connection and try again.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [validate, runUpload]);

  const clearFiles = useCallback(() => {
    setFiles([]);
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
  }, []);

  const onRemove = useCallback(async (result: UploadResult) => {
    const fileId = result.fileId;
    if (!fileId || !result.removalToken) return;

    setRemovingIds((current) => new Set(current).add(fileId));
    setRemoveErrors((current) => {
      if (!(fileId in current)) return current;
      const next = { ...current };
      delete next[fileId];
      return next;
    });

    try {
      const response = await fetch('/api/deposits/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, removalToken: result.removalToken }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!mountedRef.current) return;

      if (response.ok && body.ok) {
        setRemovedIds((current) => new Set(current).add(fileId));
      } else {
        setRemoveErrors((current) => ({ ...current, [fileId]: body.error ?? 'Could not remove this file.' }));
      }
    } catch {
      if (mountedRef.current) {
        setRemoveErrors((current) => ({
          ...current,
          [fileId]: 'Could not remove this file — check your connection.',
        }));
      }
    } finally {
      if (mountedRef.current) {
        setRemovingIds((current) => {
          const next = new Set(current);
          next.delete(fileId);
          return next;
        });
      }
    }
  }, []);

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const text = darkMode ? 'text-white' : 'text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const field = `w-full rounded-lg border px-3 py-3 text-base disabled:opacity-50 ${
    darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const locationsUnavailable = locationsStatus === 'unavailable';

  // The lockup's wordmark is dark (#231f20) and disappears against this
  // page's dark background, so it always sits on a forced-white
  // .logo-container panel (see globals.css / Sidebar.tsx). On a light page
  // that same white panel can read as an empty box, so it gets a subtle
  // border/shadow there.
  const logoPanel = `logo-container mx-auto mb-4 w-fit rounded-lg p-3 border ${
    darkMode ? 'border-slate-700' : 'border-slate-200 shadow-sm'
  }`;

  // --- Shared field controls (used by both the review card and batch card) ---
  const fieldsBlock = (
    <>
      {scannedFields.size > 0 && flow.phase !== 'scanning' && (
        <p
          className={`text-sm rounded-lg px-3 py-2 ${
            darkMode ? 'bg-indigo-950/40 text-indigo-200' : 'bg-indigo-50 text-indigo-700'
          }`}
        >
          We filled these in from your photo — please check them before uploading.
        </p>
      )}
      <div>
        <label className={`block text-sm font-medium mb-1 ${text}`} htmlFor="location">Location</label>
        <select
          id="location"
          className={field}
          value={location}
          disabled={locationsStatus !== 'ready'}
          onChange={(e) => setLocation(e.target.value)}
        >
          <option value="">
            {locationsStatus === 'loading' ? 'Loading locations…' : 'Select a location…'}
          </option>
          {location && locationsStatus !== 'ready' && <option value={location}>{location}</option>}
          {locations.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={`block text-sm font-medium mb-1 ${text}`} htmlFor="date">Date</label>
        <input
          id="date"
          type="date"
          className={field}
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setScannedFields((s) => { const n = new Set(s); n.delete('date'); return n; });
          }}
        />
      </div>

      <div>
        <span id="type-label" className={`block text-sm font-medium mb-1 ${text}`}>Type</span>
        <div role="group" aria-labelledby="type-label" className="grid grid-cols-2 gap-2">
          {(['Deposit', 'Check'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={type === option}
              onClick={() => {
                setType(option);
                setScannedFields((s) => { const n = new Set(s); n.delete('type'); return n; });
              }}
              className={`rounded-lg border px-3 py-3 text-base font-medium ${
                type === option
                  ? 'bg-[#5e3b8d] text-white border-[#5e3b8d]'
                  : darkMode
                    ? 'bg-slate-900 text-slate-300 border-slate-700'
                    : 'bg-white text-slate-700 border-slate-300'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={`block text-sm font-medium mb-1 ${text}`} htmlFor="amount">
          Amount <span className={subText}>(optional)</span>
        </label>
        <input
          id="amount"
          type="text"
          inputMode="decimal"
          placeholder="1,409.36"
          className={field}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setScannedFields((s) => { const n = new Set(s); n.delete('amount'); return n; });
          }}
        />
      </div>
    </>
  );

  // --- Session history (shared by idle + batch) ---
  const historyPanel =
    results.length > 0 ? (
      <div aria-live="polite" className={`rounded-xl border p-4 space-y-3 ${cardBg}`}>
        <p className={`text-sm font-semibold ${text}`}>Recent uploads</p>
        <div className="space-y-3">
          {results.map((result, index) => {
            const fileId = result.fileId;
            const isRemoved = fileId ? removedIds.has(fileId) : false;
            const isRemoving = fileId ? removingIds.has(fileId) : false;
            const removeError = fileId ? removeErrors[fileId] : undefined;

            return (
              <div key={`${result.originalName}-${index}`} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className={`text-sm truncate ${result.status === 'ok' ? text : 'text-red-500'}`}>
                    {result.status === 'ok'
                      ? result.fileName
                      : `${result.originalName} — ${result.error ?? 'failed'}`}
                  </p>
                  {isRemoved && <p className={`text-xs ${subText}`}>Removed</p>}
                  {removeError && <p className="text-xs text-red-500">{removeError}</p>}
                </div>
                {result.status === 'ok' && !isRemoved && (
                  <button
                    type="button"
                    disabled={isRemoving}
                    onClick={() => void onRemove(result)}
                    className="shrink-0 text-sm font-medium text-red-500 underline disabled:opacity-50"
                  >
                    {isRemoving ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <div className={logoPanel}>
            <Image
              src="/medrock-pharmacy-centered.png"
              alt="MedRock Pharmacy"
              width={176}
              height={143}
              priority
              className="mx-auto"
            />
          </div>
          <p className={`text-xs font-semibold uppercase tracking-wider text-center ${subText}`}>
            MedRock Accounting
          </p>
          <h1 className={`text-2xl font-bold text-center ${text}`}>Upload Deposits &amp; Checks</h1>
          <p className={`text-sm mt-2 text-center ${subText}`}>
            Take a photo and we read the details for you — you do not need to rename anything.
          </p>
        </div>

        {locationsUnavailable && (
          <div
            role="alert"
            className={`rounded-xl border p-4 ${
              darkMode ? 'bg-amber-950/40 border-amber-800' : 'bg-amber-50 border-amber-300'
            }`}
          >
            <p className={`text-sm font-semibold ${darkMode ? 'text-amber-300' : 'text-amber-800'}`}>
              Locations couldn&apos;t be loaded
            </p>
            <p className={`text-sm mt-1 ${darkMode ? 'text-amber-200' : 'text-amber-700'}`}>
              This is often a weak connection — tap Try again. If it keeps failing, contact IT before uploading.
            </p>
            <button
              type="button"
              onClick={() => loadLocations()}
              className={`mt-3 rounded-lg border px-3 py-2 text-sm font-semibold ${
                darkMode
                  ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                  : 'bg-white border-amber-300 text-amber-800'
              }`}
            >
              Try again
            </button>
          </div>
        )}

        {batchOpen ? (
          <>
            <div className={`rounded-xl border p-4 space-y-4 ${cardBg}`}>
              <button
                type="button"
                onClick={() => setBatchOpen(false)}
                className={`text-sm font-medium underline ${subText}`}
              >
                ← Back to photo capture
              </button>

              {fieldsBlock}

              <div>
                <span className={`block text-sm font-medium mb-1 ${text}`}>Photos</span>
                <p className={`text-sm mb-2 ${subText}`}>
                  One deposit slip or check per photo, please — take a separate photo for each.
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <label
                    htmlFor="batch-camera"
                    className="flex items-center justify-center rounded-lg border border-[#5e3b8d] bg-[#5e3b8d] px-3 py-4 text-center text-base font-semibold text-white cursor-pointer"
                  >
                    Take Photo
                  </label>
                  <input
                    id="batch-camera"
                    ref={cameraInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />

                  <label
                    htmlFor="batch-files"
                    className={`flex items-center justify-center rounded-lg border px-3 py-4 text-center text-base font-semibold cursor-pointer ${
                      darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  >
                    Choose Files
                  </label>
                  <input
                    id="batch-files"
                    ref={fileInput}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>

                {files.length > 0 && (
                  <div className="flex items-center justify-between mt-2">
                    <p className={`text-sm ${subText}`}>{files.length} file(s) ready</p>
                    <button type="button" onClick={clearFiles} className="text-sm font-medium text-red-500 underline">
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <p role="alert" className="text-sm font-medium text-red-500">
                  {error}
                </p>
              )}

              <button
                type="button"
                disabled={busy || locationsStatus !== 'ready'}
                onClick={() => void onSubmitBatch()}
                className="w-full rounded-lg bg-[#5e3b8d] px-4 py-4 text-base font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            </div>

            {historyPanel}
          </>
        ) : flow.phase === 'idle' ? (
          <>
            <div className={`rounded-xl border p-4 space-y-4 ${cardBg}`}>
              <div>
                <span className={`block text-sm font-medium mb-1 ${text}`}>Add a deposit</span>
                <p className={`text-sm mb-2 ${subText}`}>
                  Take a photo of one deposit slip or check. We read the date, type, and amount for you to review.
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <label
                    htmlFor="camera-files"
                    className="flex items-center justify-center rounded-lg border border-[#5e3b8d] bg-[#5e3b8d] px-3 py-4 text-center text-base font-semibold text-white cursor-pointer"
                  >
                    Take Photo
                  </label>
                  <input
                    id="camera-files"
                    ref={cameraInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => {
                      void scanSingle(e.target.files);
                      e.target.value = '';
                    }}
                  />

                  <label
                    htmlFor="files"
                    className={`flex items-center justify-center rounded-lg border px-3 py-4 text-center text-base font-semibold cursor-pointer ${
                      darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  >
                    Choose Photo
                  </label>
                  <input
                    id="files"
                    ref={fileInput}
                    type="file"
                    accept="image/*,application/pdf"
                    className="sr-only"
                    onChange={(e) => {
                      void scanSingle(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => setBatchOpen(true)}
                className={`text-sm font-medium underline ${subText}`}
              >
                Upload multiple files at once
              </button>
            </div>

            {historyPanel ?? (
              <p className={`text-sm text-center ${subText}`}>Uploads from this session will appear here.</p>
            )}
          </>
        ) : flow.phase === 'scanning' ? (
          <div role="status" className={`rounded-xl border p-6 text-center text-base ${cardBg} ${subText}`}>
            Reading your photo…
          </div>
        ) : (
          // review / submitting / result all render the fields card; result
          // overlays the modal.
          <div className={`relative rounded-xl border p-4 space-y-4 ${cardBg}`}>
            {previewUrl && (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- blob: object URL, not an optimizable asset */}
                <img
                  src={previewUrl}
                  alt="Captured deposit"
                  className="h-16 w-16 rounded-lg object-cover border border-slate-300"
                />
                <label htmlFor="retake-camera" className={`text-sm font-medium underline cursor-pointer ${subText}`}>
                  Retake photo
                </label>
                <input
                  id="retake-camera"
                  ref={cameraInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={(e) => {
                    void scanSingle(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
            )}

            {fieldsBlock}

            {error && flow.phase !== 'result' && (
              <p role="alert" className="text-sm font-medium text-red-500">
                {error}
              </p>
            )}

            <button
              type="button"
              disabled={busy || locationsStatus !== 'ready'}
              onClick={() => void onSubmitPhoto()}
              className="w-full rounded-lg bg-[#5e3b8d] px-4 py-4 text-base font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Uploading…' : 'Upload'}
            </button>

            {flow.phase === 'result' && (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="result-title"
                className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/40 p-4"
              >
                <div className={`w-full max-w-sm rounded-xl border p-6 text-center ${cardBg}`}>
                  {flow.outcome === 'success' ? (
                    <>
                      <div className="text-4xl" aria-hidden="true">✓</div>
                      <p
                        id="result-title"
                        role="status"
                        className={`mt-2 text-lg font-bold ${darkMode ? 'text-emerald-300' : 'text-emerald-700'}`}
                      >
                        Uploaded — filed successfully.
                      </p>
                      <p className={`mt-1 text-sm ${subText}`}>Returning to start…</p>
                    </>
                  ) : (
                    <>
                      <div className="text-4xl" aria-hidden="true">⚠️</div>
                      <p
                        id="result-title"
                        className={`mt-2 text-lg font-bold ${darkMode ? 'text-red-300' : 'text-red-600'}`}
                      >
                        Upload failed
                      </p>
                      <p className={`mt-1 text-sm ${subText}`}>
                        {error ?? 'Something went wrong. Please try again.'}
                      </p>
                      <button
                        type="button"
                        onClick={() => dispatchFlow({ type: 'DISMISS' })}
                        className="mt-4 w-full rounded-lg bg-[#5e3b8d] px-4 py-3 text-base font-semibold text-white"
                      >
                        Back
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
