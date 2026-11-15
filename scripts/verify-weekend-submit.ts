import assert from 'node:assert/strict';
import * as flow from '../src/lib/weekendSubmit.ts';
import type { PublicSubmitInput, PublicSubmitResult } from '../src/lib/backend/types.ts';

assert.equal(typeof flow.submitWeekendDays, 'function');
const make = (date: string) => ({ input: { studentNo: '10901', recordDate: date, requestId: crypto.randomUUID(),
  token: null, images: [{ blob: new Blob([date]), mime: 'image/webp' }], selfMinutes: null, note: null } });
const attempts = [make('2026-11-21'), make('2026-11-22')];
const calls: PublicSubmitInput[] = [];
let fail = true;
const submit = async (input: PublicSubmitInput): Promise<PublicSubmitResult> => {
  calls.push(input);
  if (input.recordDate === '2026-11-22' && fail) throw new Error('network');
  return { record_date: input.recordDate, replayed: false, replaced: false, version: 1,
    first_submitted_at: '2026-11-23T00:01:00Z', deadline_at: '2026-11-23T00:00:00Z', late: true };
};
await flow.submitWeekendDays(attempts, submit, () => {});
assert.equal(attempts.filter(a => a.result).length, 1, '부분 성공을 전체 완료로 표시하지 않음');
fail = false;
await flow.submitWeekendDays(attempts, submit, () => {});
assert.deepEqual(calls.map(c => c.recordDate), ['2026-11-21', '2026-11-22', '2026-11-22']);
assert.equal(calls[1].requestId, calls[2].requestId, '실패 날짜 requestId 유지');
assert.notEqual(calls[0].requestId, calls[1].requestId, '날짜별 독립 requestId');
await flow.submitWeekendDays(attempts, submit, () => {});
assert.equal(calls.length, 3, '완료된 날짜를 다시 제출하지 않음');
const wrongDate = [make('2026-11-21')];
await flow.submitWeekendDays(wrongDate, async i => ({ ...await submit(i), record_date: '2026-11-22' }), () => {});
assert.equal(wrongDate[0].result, undefined, '다른 날짜 결과는 완료 처리하지 않음');
console.log('PASS: 날짜별 부분 성공, 실패만 재시도, 요청 ID 유지, 중복 제출 방지, 결과 날짜 검증');
