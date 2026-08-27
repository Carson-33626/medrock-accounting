import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { loadDraft, listSiblings, setHeaderDocNumber, insertAudit } from '@/lib/payroll/store';
import { deriveJeIdentity } from '@/lib/payroll/je-identity';
import { isPayrollPeriodComplete, PERIOD_COMPLETE_MESSAGE } from '@/lib/payroll/period-locks';
import { nextFreeDocNumber, isValidRename, type ConflictingEntry } from '@/lib/payroll/doc-number-conflict';
import { qbQueryAll } from '@/lib/quickbooks-multi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RawLine {
  Amount?: number;
  JournalEntryLineDetail?: { PostingType?: string };
}
interface RawJe {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  Line?: RawLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** QBO query strings are single-quoted; double any quote in the value rather than interpolating raw. */
const qbEscape = (s: string): string => s.replace(/'/g, "''");

/** The DocNumber this header derives, given its position among its run's split pieces. */
async function derivedDocNumber(headerId: number): Promise<
  { ok: true; entity: string; payDate: string; base: string; current: string | null } | { ok: false; status: number; error: string }
> {
  const loaded = await loadDraft(headerId);
  if (!loaded) return { ok: false, status: 404, error: 'header not found' };
  const { header } = loaded;

  const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
  const segIndex = Math.max(0, siblings.findIndex((s) => s.id === headerId));

  // Derive from the UNPINNED header: the base is what this run would post under with no
  // override, so a run already renamed to -2 still resolves its next free suffix off the
  // original number instead of stacking into `PR 2026.07.21-2-2`.
  const base = deriveJeIdentity(
    {
      entity: header.entity,
      kind: header.kind,
      pay_date: header.pay_date,
      pay_group: header.pay_group,
      period_segment: header.period_segment,
      period_start: header.period_start,
      period_end: header.period_end,
      txn_date: header.txn_date,
      qb_doc_number: null,
    },
    segIndex,
    siblings.length,
  ).docNumber;

  return { ok: true, entity: header.entity, payDate: header.pay_date, base, current: header.qb_doc_number };
}

/**
 * GET /api/payroll/run/[id]/doc-number — who is holding this run's DocNumber, and what free
 * number could it post under instead.
 *
 * WHY: QuickBooks' duplicate fault (6240) names nothing — it says "Duplicate Document Number
 * Error" and stops. The accountant is then told to go find the offending entry by hand, in a
 * company with hundreds of journal entries. This answers it directly: the entry's QuickBooks Id,
 * its date and its amount, so she can see at a glance that (for example) FL's `PR 2026.07.21` is
 * held by a $7,948.33 accrual dated 08/31 that has nothing to do with the $2,691.25 payroll run
 * it is blocking.
 *
 * Read-only. `LIKE '<base>%'` pulls the base number AND every existing suffix in one query, which
 * is what `nextFreeDocNumber` needs to avoid renaming into a second collision.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const { id } = await context.params;
    const headerId = Number(id);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const derived = await derivedDocNumber(headerId);
    if (!derived.ok) return NextResponse.json({ error: derived.error }, { status: derived.status });
    const { entity, base, current } = derived;

    const family = await qbQueryAll<RawJe>(
      entity as Parameters<typeof qbQueryAll>[0],
      'JournalEntry',
      `WHERE DocNumber LIKE '${qbEscape(base)}%'`,
    );
    const taken = family.map((e) => e.DocNumber ?? '');

    // The number this run is actually trying to use right now — the pinned override if it has
    // one, else the derivation.
    const wanted = current ?? base;
    const conflicts: ConflictingEntry[] = family
      .filter((e) => e.DocNumber === wanted)
      .map((e) => ({
        qbEntryId: e.Id ?? '',
        docNumber: e.DocNumber ?? '',
        txnDate: e.TxnDate ?? '',
        amount: round2(
          (e.Line ?? [])
            .filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit')
            .reduce((s, l) => s + (l.Amount ?? 0), 0),
        ),
        privateNote: e.PrivateNote ?? '',
      }));

    return NextResponse.json({
      entity,
      docNumber: wanted,
      baseDocNumber: base,
      overridden: current !== null,
      conflicts,
      suggestedDocNumber: nextFreeDocNumber(base, taken),
    });
  } catch (error) {
    console.error('[payroll/run/[id]/doc-number GET]', error);
    const message = error instanceof Error ? error.message : 'Failed to check DocNumber';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface PatchBody {
  /** The suffixed DocNumber to post under, or null to drop the override. */
  docNumber: string | null;
}

/**
 * PATCH /api/payroll/run/[id]/doc-number — rename THIS run's entry so it can post.
 *
 * Renames ours, never theirs: the conflicting QuickBooks entry belongs to somebody else's work
 * and is never touched. Nothing here contacts QuickBooks to write — it pins `qb_doc_number` on
 * the header, and the existing Post button does the rest, because the post route derives its
 * DocNumber through `deriveJeIdentity`, which prefers the pin.
 *
 * Three gates:
 *   - the rename must be a suffix of the number this run actually derives (`isValidRename`) —
 *     a run may not be renamed to an arbitrary string, which would decouple the DocNumber from
 *     the run's identity that je-identity exists to keep stable;
 *   - the target must be free in QuickBooks, re-checked here rather than trusted from the GET,
 *     so a number taken between the two calls does not produce a second duplicate fault;
 *   - a posted header is refused (setHeaderDocNumber), and so is a closed period.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  await requireManager();

  try {
    const { id } = await context.params;
    const headerId = Number(id);
    if (!Number.isFinite(headerId)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    const body = (await request.json()) as PatchBody;
    const docNumber = body.docNumber;
    if (docNumber !== null && typeof docNumber !== 'string') {
      return NextResponse.json({ error: 'docNumber must be a string or null' }, { status: 400 });
    }

    const derived = await derivedDocNumber(headerId);
    if (!derived.ok) return NextResponse.json({ error: derived.error }, { status: derived.status });
    const { entity, payDate, base } = derived;

    if (isPayrollPeriodComplete(payDate)) {
      return NextResponse.json({ error: PERIOD_COMPLETE_MESSAGE }, { status: 409 });
    }

    if (docNumber !== null) {
      if (!isValidRename(base, docNumber)) {
        return NextResponse.json(
          { error: `"${docNumber}" is not a valid rename of "${base}" — only a numbered suffix like "${base}-2" is allowed.` },
          { status: 400 },
        );
      }

      const existing = await qbQueryAll<RawJe>(
        entity as Parameters<typeof qbQueryAll>[0],
        'JournalEntry',
        `WHERE DocNumber = '${qbEscape(docNumber)}'`,
      );
      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: `"${docNumber}" is also taken in ${entity} (QuickBooks entry ${existing[0].Id ?? '?'}). Re-check to get the next free number.`,
          },
          { status: 409 },
        );
      }
    }

    const updated = await setHeaderDocNumber(headerId, docNumber);
    if (!updated) {
      return NextResponse.json(
        { error: 'This run is already posted in QuickBooks — its Doc No cannot be changed.' },
        { status: 409 },
      );
    }

    await insertAudit({
      headerId,
      mode: 'dry_run',
      entity: entity as Parameters<typeof insertAudit>[0]['entity'],
      qbDocNumber: docNumber ?? undefined,
      outcome: 'doc_number_renamed',
      reason: docNumber === null ? `override cleared — back to "${base}"` : `renamed from "${base}" to "${docNumber}"`,
    });

    return NextResponse.json({ docNumber, baseDocNumber: base, overridden: docNumber !== null });
  } catch (error) {
    console.error('[payroll/run/[id]/doc-number PATCH]', error);
    const message = error instanceof Error ? error.message : 'Failed to set DocNumber';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
