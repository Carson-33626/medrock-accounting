/**
 * Turns a payroll post failure into something an accountant can act on.
 *
 * WHY: today a failed post surfaces the raw throw. In the good case that is an internal string
 * like `unresolved department: Tampa Region`; in the bad case it is a whole QuickBooks fault blob
 * — `QB API error for MedRock FL: 400 {"Fault":{"Error":[{"Message":"A business validation error
 * has occurred...","Detail":"Business Validation Error: ...","code":"6000"}]}}` — rendered
 * verbatim in the UI. Neither tells Barbara what to DO, which is the substance of her 2026-08-06
 * note: "Error review, need to get better error messaging and see about clearing these ourselves."
 *
 * Every explanation below names the thing that is wrong AND the next action, and `canSelfClear`
 * marks the ones an accountant can resolve without engineering.
 */

export interface PostErrorExplanation {
  /** One line an accountant can read at a glance. */
  summary: string;
  /** What to do next. */
  action: string;
  /** True when this is fixable from the app / QuickBooks without engineering help. */
  canSelfClear: boolean;
  /** True when simply retrying may work (transient). */
  retryable: boolean;
  /** The original message, kept for engineering — never the only thing shown. */
  raw: string;
}

interface QbFault {
  Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> };
}

/** Pull the first structured QuickBooks error out of a `QB API error for X: 400 {json}` string. */
function parseQbFault(raw: string): { message: string; detail: string; code: string } | null {
  const brace = raw.indexOf('{');
  if (brace < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(brace)) as QbFault;
    const first = parsed.Fault?.Error?.[0];
    if (!first) return null;
    return { message: first.Message ?? '', detail: first.Detail ?? '', code: String(first.code ?? '') };
  } catch {
    return null;
  }
}

const entityLabel = (entity: string | null): string => entity ?? 'this entity';

export function explainPostError(raw: string, entity: string | null = null): PostErrorExplanation {
  const base = { raw, canSelfClear: false, retryable: false };

  // ---- Our own pre-flight checks, thrown before anything reaches QuickBooks ----
  const unresolved = /^unresolved (account|department|class): (.+)$/.exec(raw.trim());
  if (unresolved) {
    const kind = unresolved[1];
    const name = unresolved[2];
    const where = kind === 'account' ? 'chart of accounts' : kind === 'department' ? 'departments' : 'classes';
    return {
      ...base,
      summary: `${entityLabel(entity)}'s QuickBooks has no ${kind} named "${name}".`,
      action:
        `Nothing was posted. Either create "${name}" in ${entityLabel(entity)}'s ${where}, or point the ` +
        `mapping at an ${kind} that already exists there (Mappings tab). Then Reconcile and post again.`,
      canSelfClear: true,
      retryable: false,
    };
  }

  // ---- QuickBooks itself rejected the entry ----
  const fault = parseQbFault(raw);
  if (fault) {
    const { message, detail, code } = fault;
    const combined = `${message} ${detail}`.toLowerCase();

    if (combined.includes('closing date') || combined.includes('closed period')) {
      return {
        ...base,
        summary: `QuickBooks refused the entry because its date falls in a CLOSED period in ${entityLabel(entity)}.`,
        action:
          'Nothing was posted. Either move the books\' closing date, or change the entry\'s posting date to an open period. ' +
          'For a split payroll, only the piece dated in the closed month is affected.',
        canSelfClear: true,
        retryable: false,
      };
    }
    if (code === '6240' || combined.includes('duplicate')) {
      return {
        ...base,
        summary: 'QuickBooks says this entry already exists (duplicate document number).',
        action:
          'Check QuickBooks for an entry with the same Doc No before retrying — posting again would double-book it. ' +
          'If the earlier attempt actually succeeded, mark this run posted rather than re-posting.',
        canSelfClear: true,
        retryable: false,
      };
    }
    if (code === '5010' || combined.includes('stale')) {
      return {
        ...base,
        summary: 'QuickBooks rejected the write because the record changed since we read it.',
        action: 'Safe to retry — the post will re-read the current version first.',
        canSelfClear: true,
        retryable: true,
      };
    }
    if (code === '610' || combined.includes('object not found')) {
      return {
        ...base,
        summary: `Something the entry refers to no longer exists in ${entityLabel(entity)}'s QuickBooks.`,
        action:
          'An account, class or department on this entry has been deleted or made inactive in QuickBooks. ' +
          'Re-activate it there, or remap the affected line, then Reconcile and post again.',
        canSelfClear: true,
        retryable: false,
      };
    }
    if (combined.includes('debit') && combined.includes('credit')) {
      return {
        ...base,
        summary: 'QuickBooks rejected the entry because its debits and credits do not match.',
        action:
          'Nothing was posted. Open the run and clear the variance shown in the footer — a run only posts at $0.00. ' +
          'An unmapped column is the usual cause.',
        canSelfClear: true,
        retryable: false,
      };
    }
    return {
      ...base,
      summary: `QuickBooks rejected the entry${code ? ` (error ${code})` : ''}: ${detail || message || 'no detail given'}`,
      action:
        'Nothing was posted. If the message names an account, class or department, fix it in QuickBooks or in ' +
        'Mappings and post again. Otherwise send this to engineering with the run and pay date.',
      canSelfClear: false,
      retryable: false,
    };
  }

  // ---- Connectivity / auth ----
  if (/could not reach quickbooks/i.test(raw) || /fetch failed|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    return {
      ...base,
      summary: 'Could not reach QuickBooks — a network problem, not an accounting one.',
      action: 'Nothing was posted. Wait a moment and post again; no reconnection is needed.',
      canSelfClear: true,
      retryable: true,
    };
  }
  if (/not connected|authorize first/i.test(raw)) {
    return {
      ...base,
      summary: `${entityLabel(entity)} is not connected to QuickBooks.`,
      action: 'Reconnect it on the admin QuickBooks page, then post again.',
      canSelfClear: true,
      retryable: false,
    };
  }

  return {
    ...base,
    summary: raw,
    action: 'Nothing was posted. If this is not self-explanatory, send it to engineering with the run and pay date.',
    canSelfClear: false,
    retryable: false,
  };
}
