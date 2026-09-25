/**
 * The daily month-end allocation difference check (DS 2026-09-25 §3). Read-only against
 * QuickBooks; writes only eom_diff_runs / eom_diff_checks.
 */
import { EOM_ENTITIES } from './revenue-rule';
import { computeEomTarget } from './eom-target';
import { remainderLines, deltaDebits, isFlagged, DELTA_MEMO, type EomDiffSettings } from './eom-correction';
import {
  getSettings, startRun, finishRun, latestRun, upsertCheck, listChecks,
  listPostedParentMonths, listPostedEomHeaderIds, type EomDiffRun, type EomDiffCheck,
} from './eom-diff-store';
import { loadDraft } from './store';
import type { Entity, JournalLine } from './types';
import type { Month } from './month';

const toMonth = (s: string): Month => ({ year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) });

export async function runEomDiff(
  trigger: 'cron' | 'manual',
): Promise<{ skipped: true } | { skipped: false; runId: number; ok: boolean; months: string[] }> {
  const settings = await getSettings();
  if (trigger === 'cron' && !settings.enabled) return { skipped: true };
  const runId = await startRun(trigger);
  try {
    const months = await listPostedParentMonths(settings.checkFromMonth);
    let firstError: string | null = null;
    for (const month of months) {
      const m = toMonth(month);
      const target = await computeEomTarget(m);
      for (const entity of EOM_ENTITIES) {
        if (!target.ok) {
          await upsertCheck({ month, entity, runId, deltaLines: [], deltaDebits: 0, error: target.error });
          continue;
        }
        const postedSets: JournalLine[][] = [];
        for (const id of await listPostedEomHeaderIds(m, entity)) {
          const loaded = await loadDraft(id);
          if (loaded) postedSets.push(loaded.lines);
        }
        if (postedSets.length === 0) continue; // this entity never posted for the month
        const targetLines = target.drafts.find((d) => d.entity === entity)?.lines ?? [];
        const delta = remainderLines(targetLines, postedSets, DELTA_MEMO);
        await upsertCheck({ month, entity, runId, deltaLines: delta, deltaDebits: deltaDebits(delta), error: null });
      }
      if (!target.ok && firstError === null) firstError = `${month}: ${target.error}`;
    }
    await finishRun(runId, firstError === null, firstError);
    return { skipped: false, runId, ok: firstError === null, months };
  } catch (error) {
    await finishRun(runId, false, error instanceof Error ? error.message : 'difference check failed');
    throw error;
  }
}

export interface EomDiffStatus {
  settings: EomDiffSettings;
  lastRun: EomDiffRun | null;
  checks: Array<EomDiffCheck & { flagged: boolean }>;
  flagged: Array<{ month: string; entities: Array<{ entity: Entity; deltaDebits: number }> }>;
}

export function buildEomDiffStatus(
  settings: EomDiffSettings, lastRun: EomDiffRun | null, checks: readonly EomDiffCheck[],
): EomDiffStatus {
  const withFlag = checks.map((c) => ({ ...c, flagged: c.error === null && isFlagged(c.deltaDebits, settings.threshold) }));
  const byMonth = new Map<string, Array<{ entity: Entity; deltaDebits: number }>>();
  for (const c of withFlag) {
    if (!c.flagged) continue;
    const arr = byMonth.get(c.month) ?? [];
    arr.push({ entity: c.entity, deltaDebits: c.deltaDebits });
    byMonth.set(c.month, arr);
  }
  const flagged = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, entities]) => ({ month, entities: entities.sort((x, y) => x.entity.localeCompare(y.entity)) }));
  return { settings, lastRun, checks: withFlag, flagged };
}

export async function getEomDiffStatus(): Promise<EomDiffStatus> {
  const [settings, lastRun, checks] = await Promise.all([getSettings(), latestRun(), listChecks()]);
  return buildEomDiffStatus(settings, lastRun, checks.filter((c) => c.month >= settings.checkFromMonth));
}
