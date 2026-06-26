import type { QBEntry, CodingMap, PatchPayload, PatchLineItem, MemoPayload, AccountingFieldSelection } from './types';

const GL_FIELD = 'QuickbooksCategory';
const CLASS_FIELD = 'QuickbooksClass';
const LOCATION_FIELD = 'QuickbooksDepartment';

export function buildPatchPayload(qb: QBEntry, coding: CodingMap): { payload: PatchPayload; flags: string[] } {
  const flags: string[] = [];
  const lineItems: PatchLineItem[] = qb.lines.map((line) => {
    const selections: AccountingFieldSelection[] = [];

    const glOption = coding.gl[line.glAccountId];
    if (glOption) selections.push({ field_external_id: GL_FIELD, field_option_external_id: glOption });
    else flags.push(`GL account ${line.glAccountId} (${line.glAccountName ?? '?'}) not in Ramp coding map`);

    if (line.classId) {
      const klassOption = coding.klass[line.classId];
      if (klassOption) selections.push({ field_external_id: CLASS_FIELD, field_option_external_id: klassOption });
      else flags.push(`Class ${line.classId} not in Ramp coding map`);
    }

    if (line.locationId) {
      const locOption = coding.location[line.locationId];
      if (locOption) selections.push({ field_external_id: LOCATION_FIELD, field_option_external_id: locOption });
      else flags.push(`Location ${line.locationId} not in Ramp coding map`);
    }

    return { amount: line.amountCents, memo: line.description, accounting_field_selections: selections };
  });

  return { payload: { line_items: lineItems }, flags };
}

export function buildMemo(qb: QBEntry): MemoPayload {
  const order = qb.orderNo ?? 'unknown';
  return { memo: `Matched to QB Amazon order# ${order} (${qb.lines.length} items)` };
}
