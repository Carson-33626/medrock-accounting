/**
 * Kind-aware JE identity: the DocNumber / TxnDate / PrivateNote a draft header posts under,
 * for ALL three JE kinds that live in payroll_journal_headers. One source of truth shared by
 * the QBO import CSV export and the EOM pool's external-post dedupe — each kind's derivation
 * is lifted verbatim from its live post route so an exported/imported JE is byte-identical to
 * what the Post button would have written.
 *
 *   pay_date            -> qb-journal docNumber / split pieceDocNumber (+ Split i/n note)
 *   allocation          -> month-end eomDocNumber (month from txn_date)
 *   inventory           -> monthly-close invCloseDocNumber (month from txn_date)
 *   inventory/INV OPEN  -> openingCorrectionDocNumber — the one-time cutover, NOT a close
 *   accrual, reversal   -> lab-supplies labAccrualIdentity (pay_group 'LAB ACCRUAL')
 *
 * The last two branches were added 2026-09-04. Without them a lab-accrual header derived
 * `PR 2026.08.31` / 'Auto payroll JE — LAB ACCRUAL …' and the opening correction derived the
 * monthly close's 'FL Inv Adj 2026.03' — so the workbook an accountant downloads, and the CSV
 * Barbara imports by hand, both named the entry something the Post button would never write.
 */
import type { Entity } from './types';
import { docNumber as payDocNumber, txnDate as payTxnDate } from './qb-journal';
import { pieceDocNumber } from './split';
import { eomDocNumber } from './month-end';
import { longMonthName, type Month } from './month';
import {
  invCloseDocNumber,
  openingCorrectionDocNumber,
  INV_OPEN_PAY_GROUP,
  OPENING_CORRECTION_NOTE,
} from '../inventory/monthly-close';
import { labAccrualIdentity, LAB_ACCRUAL_PAY_GROUP } from '../inventory/lab-supplies-je';

/** The header fields identity derivation needs — a subset of store.PayrollHeader. */
export interface JeIdentityHeader {
  entity: string;
  kind: string;
  pay_date: string;
  pay_group: string;
  period_segment: string;
  period_start: string | null;
  period_end: string | null;
  txn_date: string | null;
  qb_doc_number: string | null;
}

export interface JeIdentity {
  docNumber: string;
  /** ISO YYYY-MM-DD. */
  txnDateIso: string;
  privateNote: string;
}

function monthFromIso(iso: string): Month {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/**
 * @param segIndex/segCount position of this header among its run's split pieces
 *   (0/1 for an unsplit run; ignored for allocation/inventory kinds).
 */
export function deriveJeIdentity(header: JeIdentityHeader, segIndex: number, segCount: number): JeIdentity {
  const txnDateIso = header.txn_date ?? payTxnDate(header.pay_date);

  if (header.kind === 'allocation') {
    const m = monthFromIso(txnDateIso);
    return {
      docNumber: header.qb_doc_number ?? eomDocNumber(header.entity as Entity, m),
      txnDateIso,
      privateNote: `Month-end allocation — ${longMonthName(m)} ${m.year}`,
    };
  }

  // The lab-supplies accrual/reversal pair. The month is the PERIOD, not the posting date:
  // the reversal lands on the 1st of the following month and would derive the wrong tag from
  // its own txn_date. Same rule the post route follows.
  if (header.pay_group === LAB_ACCRUAL_PAY_GROUP && (header.kind === 'accrual' || header.kind === 'reversal')) {
    const id = labAccrualIdentity((header.period_end ?? txnDateIso).slice(0, 7), header.kind);
    return {
      docNumber: header.qb_doc_number ?? id.docNumber,
      txnDateIso: id.txnDateIso,
      privateNote: id.privateNote,
    };
  }

  if (header.kind === 'inventory') {
    const month = txnDateIso.slice(0, 7);
    if (header.pay_group === INV_OPEN_PAY_GROUP) {
      return {
        docNumber: header.qb_doc_number ?? openingCorrectionDocNumber(header.entity, month),
        txnDateIso,
        privateNote: OPENING_CORRECTION_NOTE,
      };
    }
    return {
      docNumber: header.qb_doc_number ?? invCloseDocNumber(header.entity, month),
      txnDateIso,
      // Matches api/inventory/monthly-close/post — the stable note (basis detail lives in line memos).
      privateNote: `Inventory FIFO close adjustment — ${month}`,
    };
  }

  // pay_date (and any accrual/reversal kinds once they persist): split pieces carry the
  // suffixed DocNumber + the Split i/n note the post route writes.
  if (segCount > 1) {
    return {
      docNumber: header.qb_doc_number ?? pieceDocNumber(header.pay_date, segCount, segIndex),
      txnDateIso,
      privateNote: `Split ${segIndex + 1}/${segCount} of ${payDocNumber(header.pay_date)} — period ${header.period_start ?? ''}–${header.period_end ?? ''}`,
    };
  }
  return {
    docNumber: header.qb_doc_number ?? payDocNumber(header.pay_date),
    txnDateIso,
    privateNote: `Auto payroll JE — ${header.pay_group} ${header.pay_date}`,
  };
}
