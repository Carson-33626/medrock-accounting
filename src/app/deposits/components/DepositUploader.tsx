'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { DepositType } from '@/lib/deposits/naming';

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

// A single camera capture and a multi-select gallery pick both feed this same
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

  // GET /api/deposits/locations returns 200 { locations: [] } both when the
  // Drive folder is genuinely empty and when it's misconfigured — the two
  // are indistinguishable from here. Either way an empty list means nobody
  // can file anything, so it's treated as "unavailable," not "nothing to
  // show," and the form is blocked with a message to contact IT rather than
  // rendering a dropdown with no options and no explanation.
  const [locationsStatus, setLocationsStatus] = useState<LocationsStatus>('loading');
  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState(defaultLocation);
  const [date, setDate] = useState(todayIso());
  const [type, setType] = useState<DepositType>('Deposit');
  const [amount, setAmount] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  // Incremented on every fetch kickoff (initial load or a "Try again" retry)
  // and again on unmount, so an in-flight response can tell it's gone stale
  // and skip applying itself — the same "cancelled" guarantee the old local
  // closure flag gave, but shared across repeated calls.
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

  // Scroll the outcome into view every time a fresh set of results lands —
  // on a phone, the button that triggers this is often the last thing in
  // view, and silence after tapping Upload reads as failure to someone with
  // no accounting context. This also fires for pure-error batches.
  useEffect(() => {
    if (results.length > 0) {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [results]);

  // Fed by both the camera-capture input and the gallery/file-picker input —
  // selecting from one after the other must accumulate, since a camera
  // capture only ever returns a single file and staff photograph checks one
  // at a time.
  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setFiles((current) => mergeFiles(current, Array.from(incoming)));
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
  }, []);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (locationsStatus !== 'ready') return setError('Locations are not available yet — see the notice above.');
    if (!location) return setError('Pick a location.');
    if (files.length === 0) return setError('Add at least one photo.');
    if (files.length > MAX_FILES) return setError(`Send at most ${MAX_FILES} files at a time.`);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return setError('Those files are too large together — send fewer at a time.');

    setBusy(true);
    try {
      const form = new FormData();
      form.set('location', location);
      form.set('date', date);
      form.set('type', type);
      form.set('amount', amount);
      for (const file of files) form.append('files', file);

      const response = await fetch('/api/deposits/upload', { method: 'POST', body: form });
      const body = (await response.json()) as { results?: UploadResult[]; error?: string };
      if (!mountedRef.current) return;

      if (!response.ok) {
        setError(body.error ?? 'Upload failed.');
        return;
      }
      setResults(body.results ?? []);
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
    } catch {
      if (mountedRef.current) setError('Upload failed — check your connection and try again.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [locationsStatus, location, date, type, amount, files]);

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
  const okCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.length - okCount;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <div className="logo-container mx-auto mb-4 w-fit rounded-lg p-3">
            <Image
              src="/medrock-logo.png"
              alt="MedRock Pharmacy"
              width={160}
              height={52}
              priority
              className="mx-auto"
            />
          </div>
          <p className={`text-xs font-semibold uppercase tracking-wider text-center ${subText}`}>
            MedRock Accounting
          </p>
          <h1 className={`text-2xl font-bold text-center ${text}`}>Upload Deposits &amp; Checks</h1>
          <p className={`text-sm mt-2 text-center ${subText}`}>
            Take a photo or pick files. They are filed automatically — you do not need to rename anything.
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

        <div className={`rounded-xl border p-4 space-y-4 ${cardBg}`}>
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
            <input id="date" type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <span id="type-label" className={`block text-sm font-medium mb-1 ${text}`}>Type</span>
            <div role="group" aria-labelledby="type-label" className="grid grid-cols-2 gap-2">
              {(['Deposit', 'Check'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={type === option}
                  onClick={() => setType(option)}
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
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div>
            <span className={`block text-sm font-medium mb-1 ${text}`}>Photos</span>
            <p className={`text-sm mb-2 ${subText}`}>
              One deposit slip or check per photo, please — take a separate photo for each.
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
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />

              <label
                htmlFor="files"
                className={`flex items-center justify-center rounded-lg border px-3 py-4 text-center text-base font-semibold cursor-pointer ${
                  darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                }`}
              >
                Choose Files
              </label>
              <input
                id="files"
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
                <button
                  type="button"
                  onClick={clearFiles}
                  className="text-sm font-medium text-red-500 underline"
                >
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
            onClick={() => void onSubmit()}
            className="w-full rounded-lg bg-[#5e3b8d] px-4 py-4 text-base font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>

        {results.length > 0 && (
          <div ref={resultsRef} aria-live="polite" className={`rounded-xl border p-4 space-y-3 ${cardBg}`}>
            <p
              role="status"
              className={`text-base font-bold ${
                errorCount === 0
                  ? darkMode ? 'text-emerald-300' : 'text-emerald-700'
                  : darkMode ? 'text-amber-300' : 'text-amber-700'
              }`}
            >
              {errorCount === 0
                ? `Uploaded — ${okCount} of ${okCount} file(s) filed successfully.`
                : `${okCount} of ${results.length} file(s) uploaded — ${errorCount} failed, see below.`}
            </p>
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
        )}
      </div>
    </div>
  );
}
