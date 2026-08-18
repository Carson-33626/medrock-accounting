import { describe, it, expect } from 'vitest';
import { buildJeExportSheet, buildRunJeExportWorkbook, type JeExportPiece } from './je-export';
import type { JournalLine } from './types';

const header = { entity: 'MedRock FL', pay_date: '07/01/2026', pay_group: 'MRFL', qb_doc_number: null };

const line = (over: Partial<JournalLine>): JournalLine => ({
  postingType: 'Debit', amount: 100, accountName: 'COGS - Lab Wages', departmentName: null,
  className: null, memo: '', creditBucket: null, origin: 'generated', sourceRowKeys: ['k1'], ...over,
});

describe('buildJeExportSheet', () => {
  it('puts debit amounts in the Debit column and credit amounts in the Credit column', () => {
    const lines = [
      line({ postingType: 'Debit', amount: 1000, accountName: 'COGS - Lab Wages' }),
      line({ postingType: 'Credit', amount: 800, accountName: 'Payroll Withholdings', creditBucket: 'Net Pay' }),
    ];
    const { rows } = buildJeExportSheet(header, lines);
    const debit = rows.find((r) => r.account === 'COGS - Lab Wages');
    const credit = rows.find((r) => r.account === 'Payroll Withholdings');
    expect(debit?.debit).toBe(1000);
    expect(debit?.credit).toBeNull();
    expect(credit?.credit).toBe(800);
    expect(credit?.debit).toBeNull();
  });

  it('appends a TOTAL row summing debits and credits', () => {
    const lines = [
      line({ postingType: 'Debit', amount: 1000 }),
      line({ postingType: 'Debit', amount: 200 }),
      line({ postingType: 'Credit', amount: 1200 }),
    ];
    const { rows } = buildJeExportSheet(header, lines);
    const total = rows[rows.length - 1];
    expect(total.type).toBe('TOTAL');
    expect(total.debit).toBe(1200);
    expect(total.credit).toBe(1200);
  });

  it('carries memo, department and class through per line', () => {
    const lines = [line({ memo: 'Accounting Wages', departmentName: 'Miami Region', className: 'Allocate - %' })];
    const { rows } = buildJeExportSheet(header, lines);
    expect(rows[0]).toMatchObject({ memo: 'Accounting Wages', department: 'Miami Region', className: 'Allocate - %' });
  });

  it('derives DocNumber (PR YYYY.MM.DD) and TxnDate (YYYY-MM-DD) from the pay date', () => {
    const { docNumber, txnDate } = buildJeExportSheet(header, [line({})]);
    expect(docNumber).toBe('PR 2026.07.01');
    expect(txnDate).toBe('2026-07-01');
  });

  it('prefers an existing qb_doc_number over the derived one (already posted)', () => {
    const posted = { ...header, qb_doc_number: 'PR 2026.06.30' };
    const { docNumber } = buildJeExportSheet(posted, [line({})]);
    expect(docNumber).toBe('PR 2026.06.30');
  });

  it('produces a filesystem-safe filename (no spaces) from entity + doc number', () => {
    const { filename } = buildJeExportSheet(header, [line({})]);
    expect(filename).not.toMatch(/\s/);
    expect(filename).toContain('MedRock_FL');
    expect(filename).toContain('PR_2026.07.01');
  });

  it('adds an Account # column resolved from the QB account-number map (Barbara: show the mapped account name AND number)', () => {
    const acctNums = { 'COGS - Lab Wages': '5010', 'Payroll Withholdings': '2100' };
    const lines = [
      line({ accountName: 'COGS - Lab Wages' }),
      line({ postingType: 'Credit', accountName: 'Payroll Withholdings', creditBucket: 'Net Pay' }),
    ];
    const { columns, rows } = buildJeExportSheet(header, lines, acctNums);
    expect(columns.map((c) => c.key)).toEqual([
      'type', 'acctNum', 'account', 'memo', 'department', 'className', 'debit', 'credit', 'origin',
    ]);
    expect(rows.find((r) => r.account === 'COGS - Lab Wages')?.acctNum).toBe('5010');
    expect(rows.find((r) => r.account === 'Payroll Withholdings')?.acctNum).toBe('2100');
  });

  it('leaves Account # blank for accounts with no number and on the TOTAL row', () => {
    const { rows } = buildJeExportSheet(header, [line({ accountName: 'COGS - Lab Wages' })], {});
    expect(rows.find((r) => r.account === 'COGS - Lab Wages')?.acctNum).toBe('');
    expect(rows[rows.length - 1].acctNum).toBe('');
  });

  it('omits account numbers gracefully when no map is supplied (offline export still works)', () => {
    const { rows } = buildJeExportSheet(header, [line({})]);
    expect(rows[0].acctNum).toBe('');
  });
});

// Split-run workbook (Barbara 2026-08-18: the download only ever contained ONE piece of a split
// payroll — half the report — and switching sub-tabs re-downloaded that same piece).
describe('buildRunJeExportWorkbook', () => {
  const splitHeader = { entity: 'MedRock FL', pay_date: '07/01/2026', pay_group: 'MRFL', qb_doc_number: null };
  const junPiece: JeExportPiece = {
    header: splitHeader,
    lines: [
      line({ postingType: 'Debit', amount: 600, accountName: 'COGS - Lab Wages' }),
      line({ postingType: 'Credit', amount: 600, accountName: 'Payroll Withholdings', creditBucket: 'Net Pay' }),
    ],
    periodSegment: '2026-06',
    docNumber: 'PR 2026.07.01A',
    txnDate: '2026-06-30',
  };
  const julPiece: JeExportPiece = {
    header: splitHeader,
    lines: [
      line({ postingType: 'Debit', amount: 400, accountName: 'COGS - Lab Wages' }),
      line({ postingType: 'Credit', amount: 400, accountName: 'Payroll Withholdings', creditBucket: 'Net Pay' }),
    ],
    periodSegment: '2026-07',
    docNumber: 'PR 2026.07.01B',
    txnDate: '2026-07-01',
  };

  it('emits one sheet per piece plus a Combined sheet, pieces in chronological order', () => {
    const { sheets } = buildRunJeExportWorkbook([julPiece, junPiece]); // deliberately out of order
    expect(sheets).toHaveLength(3);
    expect(sheets[0].name).toBe('Jun (PR 2026.07.01A)');
    expect(sheets[1].name).toBe('Jul (PR 2026.07.01B)');
    expect(sheets[2].name).toBe('Combined');
  });

  it('keeps every sheet name a legal Excel tab name (≤31 chars, no \\ / ? * [ ] :)', () => {
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece]);
    for (const s of sheets) {
      expect(s.name.length).toBeLessThanOrEqual(31);
      expect(s.name).not.toMatch(/[\\/?*[\]:]/);
    }
  });

  it('Combined sheet holds EVERY line from EVERY piece and a TOTAL row summing across pieces', () => {
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece]);
    const combined = sheets[2];
    // 2 lines per piece + 1 TOTAL
    expect(combined.rows).toHaveLength(5);
    const total = combined.rows[combined.rows.length - 1];
    expect(total.type).toBe('TOTAL');
    expect(total.debit).toBe(1000);
    expect(total.credit).toBe(1000);
  });

  it('Combined rows carry a JE column naming the piece each line posts under', () => {
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece]);
    const combined = sheets[2];
    expect(combined.columns[0]).toMatchObject({ header: 'JE', key: 'je' });
    const jes = combined.rows.slice(0, -1).map((r) => r.je);
    expect(jes).toEqual(['PR 2026.07.01A', 'PR 2026.07.01A', 'PR 2026.07.01B', 'PR 2026.07.01B']);
    // piece sheets do NOT have the JE column
    expect(sheets[0].columns.map((c) => c.key)).not.toContain('je');
  });

  it('Combined note says it is a review view of N separate journal entries, never one postable JE', () => {
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece]);
    expect(sheets[2].note).toContain('2 separate journal entries');
    expect(sheets[2].note).toContain('PR 2026.07.01A');
    expect(sheets[2].note).toContain('PR 2026.07.01B');
  });

  it('each piece sheet keeps its own DocNumber/TxnDate note and its own TOTAL row', () => {
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece]);
    expect(sheets[0].note).toContain('PR 2026.07.01A');
    expect(sheets[0].note).toContain('2026-06-30');
    const junTotal = sheets[0].rows[sheets[0].rows.length - 1];
    expect(junTotal.debit).toBe(600);
    expect(sheets[1].note).toContain('PR 2026.07.01B');
  });

  it('resolves Account # on every sheet including Combined', () => {
    const acctNums = { 'COGS - Lab Wages': '5010', 'Payroll Withholdings': '2100' };
    const { sheets } = buildRunJeExportWorkbook([junPiece, julPiece], acctNums);
    expect(sheets[0].rows[0].acctNum).toBe('5010');
    expect(sheets[2].rows.find((r) => r.account === 'Payroll Withholdings')?.acctNum).toBe('2100');
  });

  it('names the file after the run stem doc number, filesystem-safe, marked _split', () => {
    const { filename } = buildRunJeExportWorkbook([junPiece, julPiece]);
    expect(filename).not.toMatch(/\s/);
    expect(filename).toContain('MedRock_FL');
    expect(filename).toContain('PR_2026.07.01');
    expect(filename).toMatch(/_split$/);
  });

  it('a single-piece run degrades to the plain single-sheet export (no Combined sheet)', () => {
    const single: JeExportPiece = {
      header, lines: [line({ postingType: 'Debit', amount: 100 }), line({ postingType: 'Credit', amount: 100, creditBucket: 'Net Pay', accountName: 'Payroll Withholdings' })],
      periodSegment: '2026-07', docNumber: 'PR 2026.07.01', txnDate: '2026-07-01',
    };
    const { sheets, filename } = buildRunJeExportWorkbook([single]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Journal Entry');
    expect(filename).not.toMatch(/_split$/);
  });

  it('a posted piece keeps its real qb_doc_number in its sheet name and rows note', () => {
    const posted: JeExportPiece = { ...junPiece, header: { ...splitHeader, qb_doc_number: 'PR 2026.07.01A' } };
    const { sheets } = buildRunJeExportWorkbook([posted, julPiece]);
    expect(sheets[0].name).toBe('Jun (PR 2026.07.01A)');
  });
});
