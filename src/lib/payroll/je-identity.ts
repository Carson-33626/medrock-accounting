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
 *   accrual, reversal   -> labAccrualIdentity ('LAB ACCRUAL') / shippingAccrualIdentity ('SHIP ACCRUAL')
 *
 * The last two branches were added 2026-09-04. Without them a lab-accrual header derived
 * `PR 2026.08.31` / 'Auto payroll JE — LAB ACCRUAL …' and the opening correction derived the
 * monthly close's 'FL Inv Adj 2026.03' — so the workbook an accountant downloads, and the CSV
 * Barbara imports by hand, both named the entry something the Post button would never write.
 *
 * AN ACCRUAL PAIR IS KEYED BY pay_group, NOT BY kind. 'accrual' and 'reversal' are shared by
 * every pair, so a pair whose pay_group is not listed above falls through to the pay_date
 * branch and is named `PR <date>` after payroll. That is exactly the bug found on 2026-09-04,
 * and it will recur for the NEXT pair unless whoever adds one adds a branch here. If you are
 * writing a new accrual, this file and `je-detail-fetch.ts` are the two places that need you.
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
import {
  shippingAccrualIdentity,
  SHIPPING_ACCRUAL_PAY_GROUP,
} from '../inventory/shipping-packaging-je';

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

  // The accrual/reversal pairs. The month is the PERIOD, not the posting date: the reversal
  // lands on the 1st of the following month and would derive the wrong tag from its own
  // txn_date. Same rule the post routes follow.
  //
  // Each pair is keyed by pay_group because the kind alone does not identify it — 'accrual'
  // is shared. A pair whose pay_group is missing here falls through to the pay_date branch
  // and derives `PR <date>`, which is how the lab accrual came to be named after payroll.
  if (header.kind === 'accrual' || header.kind === 'reversal') {
    const periodMonth = (header.period_end ?? txnDateIso).slice(0, 7);
    const id =
      header.pay_group === LAB_ACCRUAL_PAY_GROUP
        ? labAccrualIdentity(periodMonth, header.kind)
        : header.pay_group === SHIPPING_ACCRUAL_PAY_GROUP
          ? shippingAccrualIdentity(periodMonth, header.kind)
          : null;
    if (id !== null) {
      return {
        docNumber: header.qb_doc_number ?? id.docNumber,
        txnDateIso: id.txnDateIso,
        privateNote: id.privateNote,
      };
    }
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
