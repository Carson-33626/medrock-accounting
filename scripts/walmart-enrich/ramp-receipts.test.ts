import { describe, it, expect } from 'vitest';
import { buildReceiptForm, isUploadableUserStatus } from './ramp-receipts';

// Ramp rejects a receipt upload whose user_id is not an ACTIVE user with a MISLEADING
// 404 DEVELOPER_7002 "The requested User (...) does not exist" — the user does exist, it is
// suspended. Worse, the failed attempt still REGISTERS the idempotency key, so every later retry
// returns 400 DEVELOPER_7005 "Idempotency key already exists" and that transaction can never be
// receipted again. Evidence: txn cdb41b2b (cardholder Amy Murphy, USER_SUSPENDED) 404'd on
// 2026-07-29 and has failed 7005 every run since. So the ONLY safe behaviour is to refuse before
// the POST — a burned key is unrecoverable, a skipped txn is not.
describe('isUploadableUserStatus', () => {
  it('allows an active user', () => {
    expect(isUploadableUserStatus('USER_ACTIVE')).toBe(true);
  });

  it('refuses a suspended user (would 7002 and burn the idempotency key)', () => {
    expect(isUploadableUserStatus('USER_SUSPENDED')).toBe(false);
  });

  it('refuses an inactive user', () => {
    expect(isUploadableUserStatus('USER_INACTIVE')).toBe(false);
  });

  it('refuses an unknown status rather than gambling a key on it', () => {
    expect(isUploadableUserStatus('USER_SOMETHING_NEW')).toBe(false);
    expect(isUploadableUserStatus(null)).toBe(false);
  });
});

describe('buildReceiptForm', () => {
  it('includes transaction id, user id, idempotency key, and the file part', () => {
    const form = buildReceiptForm(Buffer.from('%PDF-1.4 test'), 'invoice.pdf', 'txn-123', 'user-abc', 'walmart-receipt-999');
    expect(form.get('transaction_id')).toBe('txn-123');
    expect(form.get('user_id')).toBe('user-abc');
    expect(form.get('idempotency_key')).toBe('walmart-receipt-999');
    const file = form.get('receipt');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('invoice.pdf');
  });
});
