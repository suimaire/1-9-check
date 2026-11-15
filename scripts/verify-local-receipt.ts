import assert from 'node:assert/strict';
import { getToken, saveToken, getReceipt, saveReceipt } from '../src/lib/localReceipt.ts';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
saveToken('10901', '2026-11-21', 'daily-token');
saveToken('10901', '2026-11-21', 'weekend-token', 'weekend');
assert.equal(getToken('10901', '2026-11-21'), 'daily-token');
assert.equal(getToken('10901', '2026-11-21', 'weekend'), 'weekend-token');
const receipt = { firstSubmittedAt: '2026-11-23T00:00:00Z', late: false, version: 1 };
saveReceipt('10901', '2026-11-21', receipt);
saveReceipt('10901', '2026-11-21', { ...receipt, version: 2 }, 'weekend');
assert.equal(getReceipt('10901', '2026-11-21')?.version, 1);
assert.equal(getReceipt('10901', '2026-11-21', 'weekend')?.version, 2);
console.log('PASS: overlapping daily/weekend tokens and receipts remain independent');
