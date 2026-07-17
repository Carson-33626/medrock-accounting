import type { JournalDraft, Entity } from './types';
import type { JsonValue } from './store';
import { qbQueryAll, qbPost } from '../quickbooks-multi';

export interface Refs {
  accounts: Record<string, string>; departments: Record<string, string>; classes: Record<string, string>;
  /** account FullyQualifiedName -> QB account number (AcctNum), for accounts that carry one. */
  accountNums?: Record<string, string>;
}
interface QbRefLine { Amount: number; DetailType: 'JournalEntryLineDetail'; Description?: string;
  JournalEntryLineDetail: { PostingType: 'Debit' | 'Credit'; AccountRef: { value: string }; DepartmentRef?: { value: string }; ClassRef?: { value: string }; }; }
export interface QbJournalEntryPayload { DocNumber: string; TxnDate: string; PrivateNote?: string; Line: QbRefLine[]; }

const pad2 = (s: string): string => s.padStart(2, '0');
const docNumber = (payDate: string): string => { const [m, d, y] = payDate.split('/'); return `PR ${y}.${pad2(m)}.${pad2(d)}`; };
const txnDate = (payDate: string): string => { const [m, d, y] = payDate.split('/'); return `${y}-${pad2(m)}-${pad2(d)}`; };

export function buildJePayload(draft: JournalDraft, refs: Refs): QbJournalEntryPayload {
  const Line: QbRefLine[] = draft.lines.map((l) => {
    const acct = refs.accounts[l.accountName];
    if (!acct) throw new Error(`unresolved account: ${l.accountName}`);
    const detail: QbRefLine['JournalEntryLineDetail'] = { PostingType: l.postingType, AccountRef: { value: acct } };
    if (l.departmentName) { const dep = refs.departments[l.departmentName]; if (!dep) throw new Error(`unresolved department: ${l.departmentName}`); detail.DepartmentRef = { value: dep }; }
    if (l.className) { const cls = refs.classes[l.className]; if (!cls) throw new Error(`unresolved class: ${l.className}`); detail.ClassRef = { value: cls }; }
    return { Amount: l.amount, DetailType: 'JournalEntryLineDetail', Description: l.memo || undefined, JournalEntryLineDetail: detail };
  });
  return {
    DocNumber: draft.docNumber ?? docNumber(draft.payDate),
    TxnDate: draft.txnDate ?? txnDate(draft.payDate),
    PrivateNote: draft.privateNote ?? `Auto payroll JE — ${draft.payGroup} ${draft.payDate}`,
    Line,
  };
}

interface NameId { Id: string; Name?: string; FullyQualifiedName?: string; }
interface AccountRow extends NameId { AcctNum?: string; }
export async function fetchDimensions(entity: Entity): Promise<Refs> {
  const [accounts, departments, classes] = await Promise.all([
    qbQueryAll<AccountRow>(entity, 'Account', ''), qbQueryAll<NameId>(entity, 'Department', ''), qbQueryAll<NameId>(entity, 'Class', ''),
  ]);
  const idx = (xs: NameId[]): Record<string, string> => Object.fromEntries(xs.map((x) => [x.FullyQualifiedName ?? x.Name ?? '', x.Id]));
  const accountNums: Record<string, string> = Object.fromEntries(
    accounts.filter((a) => a.AcctNum).map((a) => [a.FullyQualifiedName ?? a.Name ?? '', a.AcctNum as string]),
  );
  return { accounts: idx(accounts), departments: idx(departments), classes: idx(classes), accountNums };
}

export interface PostResult {
  mode: 'dry_run' | 'live';
  payload: QbJournalEntryPayload;
  response?: JsonValue;
  qbEntryId?: string;
  qbDocNumber?: string;
}

export async function postJournalEntry(
  entity: Entity,
  draft: JournalDraft,
  opts: { mode: 'dry_run' | 'live' },
): Promise<PostResult> {
  const refs = await fetchDimensions(entity);
  const payload = buildJePayload(draft, refs);

  if (opts.mode === 'dry_run') {
    return { mode: 'dry_run', payload };
  }

  const response = await qbPost<{ JournalEntry?: { Id?: string; DocNumber?: string } }>(
    entity,
    'journalentry?minorversion=75',
    payload as unknown as JsonValue,
  );
  return {
    mode: 'live',
    payload,
    response: response as JsonValue,
    qbEntryId: response.JournalEntry?.Id,
    qbDocNumber: response.JournalEntry?.DocNumber,
  };
}
