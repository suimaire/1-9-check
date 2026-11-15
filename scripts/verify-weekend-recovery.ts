import assert from 'node:assert/strict';
import * as recovery from '../src/lib/weekendSubmit.ts';
import { createDemoBackend } from '../src/lib/backend/demo.ts';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
assert.equal(typeof recovery.saveWeekendAttempts, 'function', 'pending IDs must survive reload');
const backend = createDemoBackend();
await backend.signIn('teacher', 'demo');
const data = (await backend.loadTeacherData())!;
const termId = await backend.saveWeekendTerm(data.klass.id, { termId: null, name: 'Weekend', deadlineMinutes: 540, instructions: '' });
await backend.setTermParticipants(termId, ['s01']);
await backend.setPublicTerm(data.klass.id, termId);
backend.demo.setClock('weekend-before');
const attempts = ['2026-11-14','2026-11-15'].map(recordDate => ({ input: { termId, studentNo: '10901', recordDate,
  requestId: crypto.randomUUID(), token: null, selfMinutes: 120, note: null,
  images: [{ blob: new Blob(['photo']), mime: 'image/webp' }] } }));
assert.equal(recovery.saveWeekendAttempts(attempts), true);
backend.demo.setFailure('confirm_lost');
await assert.rejects(backend.publicSubmit(attempts[0].input), /network/);
const restored = recovery.loadWeekendAttempts(termId, '10901', '2026-11-14');
assert.deepEqual(restored.map(a => a.input.requestId), attempts.map(a => a.input.requestId));
assert.ok(restored.every(a => a.input.images.length === 0), 'photos are not stored in browser storage');
restored[0].result = (await backend.publicRecover(restored[0].input))!;
assert.ok(restored[0].result.replacement_token);
assert.equal(await backend.publicRecover(restored[1].input), null);
restored[1].input.images = attempts[1].input.images;
await recovery.submitWeekendDays(restored, input => backend.publicSubmit(input), () => recovery.saveWeekendAttempts(restored));
assert.equal((await backend.loadTeacherData(termId))!.submissions.length, 2);
assert.equal(restored[0].result.version, 1);
assert.deepEqual(recovery.loadWeekendAttempts('other', '10901', '2026-11-14'), []);
assert.deepEqual(recovery.loadWeekendAttempts(termId, '10902', '2026-11-14'), []);
recovery.clearWeekendAttempts(termId, '10901', '2026-11-14');
assert.deepEqual(recovery.loadWeekendAttempts(termId, '10901', '2026-11-14'), []);
console.log('PASS: reload recovers committed receipt/token, retries only uncommitted date, isolates term/student');
