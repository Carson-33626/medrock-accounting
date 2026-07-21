import { describe, it, expect } from 'vitest';
import { buildJeExportSheet } from './je-export';
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
});
