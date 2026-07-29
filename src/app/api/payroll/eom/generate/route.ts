import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { requireAdmin } from '@/lib/auth';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromPresence, type RevenueTest } from '@/lib/payroll/revenue-rule';
import { fetchAllocationPool, type PoolLine } from '@/lib/payroll/qb-pool';
import { buildMonthEndAllocation } from '@/lib/payroll/month-end';
import { saveEomRun, listEomHeaders, deleteUnpostedEomHeaders } from '@/lib/payroll/eom-store';
import { saveDraft, loadDraft, type JsonValue } from '@/lib/payroll/store';
import { fetchDimensions } from '@/lib/payroll/qb-journal';
import type { Entity, JournalLine } from '@/lib/payroll/types';
import type { Month } from '@/lib/payroll/month';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// ~24 sequential QuickBooks calls (revenue presence + pool fetch + per-draft dimension checks).
export const maxDuration = 300;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

interface GenerateRequestBody {
  month: string;
}

function parseMonthParam(raw: string | null | undefined): { month: string; m: Month } | null {
  if (!raw || !MONTH_RE.test(raw)) return null;
  const [y, mo] = raw.split('-');
  return { month: raw, m: { year: Number(y), month: Number(mo) } };
}

/** sha256 of the pool snapshot — the source data this run's drafts were built from. */
function eomSnapshotHash(pool: PoolLine[]): string {
  return createHash('sha256').update(JSON.stringify(pool)).digest('hex');
}

const toJson = <T,>(value: T): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/**
 * POST /api/payroll/eom/generate { month: 'YYYY-MM' } — build (or rebuild) the month-end
 * allocation JEs for every entity with allocate-flagged activity. Regeneration is locked
 * once any header for the month has posted (see eom-store.deleteUnpostedEomHeaders) — the
 * accountant must un-post in QuickBooks first rather than silently orphaning a live JE.
 */
export async function POST(request: NextRequest) {
  // requireAdmin redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireAdmin();

  try {
    const body = (await request.json()) as GenerateRequestBody;
    const parsed = parseMonthParam(body.month);
    if (!parsed) {
      return NextResponse.json({ error: 'month is required as YYYY-MM' }, { status: 400 });
    }
    const { month, m } = parsed;

    // SAFETY GATE: never rebuild a month that has already posted — regeneration would
    // orphan the live QuickBooks JE. Checked before any QuickBooks call.
    const existingHeaders = await listEomHeaders(m);
    const posted = existingHeaders.filter((h) => h.status === 'posted');
    if (posted.length > 0) {
      const docNumbers = posted.map((h) => h.qb_doc_number ?? `#${h.id}`).join(', ');
      return NextResponse.json(
        { error: `month has posted allocation JEs — regeneration locked (${docNumbers})` },
        { status: 409 },
      );
    }

    let revenueTest: RevenueTest;
    let pool: PoolLine[];
    let attention: PoolLine[];
    try {
      revenueTest = await fetchRevenuePresence(m);
      const poolResult = await fetchAllocationPool(m);
      pool = poolResult.pool;
      attention = poolResult.attention;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch QuickBooks data';
      return NextResponse.json({ error: message }, { status: 502 });
    }

    let shares = sharesFromPresence(revenueTest);
    if (shares === null) {
      if (pool.some((l) => l.rule === 'revenue')) {
        return NextResponse.json({ error: `no location has revenue for ${month}` }, { status: 422 });
      }
      // thirds/fifty groups never read the shares record — an all-zero placeholder keeps
      // buildMonthEndAllocation's signature (Record<Entity, number>) satisfied.
      shares = Object.fromEntries(EOM_ENTITIES.map((e) => [e, 0])) as Record<Entity, number>;
    }

    const drafts = buildMonthEndAllocation(pool, shares, m);

    // Pre-flight account check: warnings only — generation still saves; posting would fail
    // loudly on an unresolved account anyway (see qb-journal.buildJePayload).
    const warnings: string[] = [];
    for (const draft of drafts) {
      try {
        const refs = await fetchDimensions(draft.entity);
        for (const line of draft.lines) {
          if (!refs.accounts[line.accountName]) {
            warnings.push(`${draft.entity}: account not found: ${line.accountName}`);
          }
        }
      } catch {
        warnings.push(`${draft.entity}: could not verify accounts (QuickBooks fetch failed)`);
      }
    }

    const hash = eomSnapshotHash(pool);
    const headerIds: number[] = [];
    for (const draft of drafts) {
      headerIds.push(await saveDraft(draft, hash));
    }

    // Regeneration replace-semantics: drop unposted drafts for entities the rebuild no
    // longer produces.
    await deleteUnpostedEomHeaders(m, drafts.map((d) => d.entity));

    await saveEomRun({
      month,
      pool: toJson(pool),
      revenue: toJson({ test: revenueTest, shares }),
      attention: toJson(attention),
    });

    const headers = await listEomHeaders(m);
    const draftsResponse = await Promise.all(
      headerIds.map(async (id, i) => {
        const loaded = await loadDraft(id);
        const lines: JournalLine[] = loaded ? loaded.lines : drafts[i].lines;
        return { headerId: id, entity: drafts[i].entity, lines };
      }),
    );

    return NextResponse.json({
      headers,
      drafts: draftsResponse,
      revenueTest,
      shares,
      poolCount: pool.length,
      attention,
      warnings,
    });
  } catch (error) {
    console.error('[payroll/eom/generate POST]', error);
    const message = error instanceof Error ? error.message : 'Failed to generate month-end allocation';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
