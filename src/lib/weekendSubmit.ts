import { BackendError, type PublicSubmitInput, type PublicSubmitResult } from './backend/types.ts';

export interface WeekendAttempt {
  input: PublicSubmitInput;
  result?: PublicSubmitResult;
  error?: unknown;
}

const recoveryKey = (term: string, no: string, saturday: string) => `1-9-check:weekend-pending:${term}:${no}:${saturday}`;

/** 사진은 저장하지 않고 응답 유실 후 조회에 필요한 요청 번호를 보존한다. */
export function saveWeekendAttempts(attempts: WeekendAttempt[]): boolean {
  const first = attempts[0]?.input;
  if (!first?.termId) return false;
  try {
    localStorage.setItem(recoveryKey(first.termId, first.studentNo, first.recordDate), JSON.stringify(
      attempts.map(({ input, result }) => ({ input: { ...input, images: [] }, result })),
    ));
    return true;
  } catch { return false; }
}

export function loadWeekendAttempts(term: string, no: string, saturday: string): WeekendAttempt[] {
  try {
    const saved = JSON.parse(localStorage.getItem(recoveryKey(term, no, saturday)) ?? '[]') as WeekendAttempt[];
    if (saved.length !== 2 || saved[0].input.recordDate !== saturday || saved.some(a =>
      a.input.termId !== term || a.input.studentNo !== no || !/^[0-9a-f-]{36}$/.test(a.input.requestId)
      || (a.result && a.result.record_date !== a.input.recordDate))) return [];
    return saved.map(a => ({ input: { ...a.input, images: [] }, result: a.result }));
  } catch { return []; }
}

export function clearWeekendAttempts(term: string, no: string, saturday: string) {
  try { localStorage.removeItem(recoveryKey(term, no, saturday)); } catch { /* 현재 화면에서는 계속 재시도할 수 있다. */ }
}

/** 성공한 날짜는 건너뛰고 실패한 날짜는 원래 요청을 그대로 재전송한다. */
export async function submitWeekendDays(
  attempts: WeekendAttempt[],
  submit: (input: PublicSubmitInput) => Promise<PublicSubmitResult>,
  onSettled: (attempt: WeekendAttempt) => void,
): Promise<void> {
  for (const attempt of attempts) {
    if (attempt.result) continue;
    attempt.error = undefined;
    try {
      const result = await submit(attempt.input);
      if (result.record_date !== attempt.input.recordDate) throw new BackendError('server_error');
      attempt.result = result;
    } catch (error) {
      attempt.error = error;
    }
    onSettled(attempt);
  }
}
