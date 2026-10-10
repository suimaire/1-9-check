// 화면 집계 규칙 확인(항목 5): KST 마감 전/정각/직후, 면제, 늦은 제출, 연속 미제출 일수, 숫자 정합성.
// Node 22.18+ 타입 제거 실행: node scripts/verify-status.ts
import { buildDemoStore, DEMO_CLOCKS } from '../src/lib/backend/demoData.ts';
import { dayWindow, kstDateOf, kstStartOf } from '../src/lib/kst.ts';
import { consecutiveMissingCount, dayRows, indexBoard, submitState, summarize } from '../src/lib/status.ts';
import type { Exemption, Student, Submission, TermDay } from '../src/lib/types.ts';

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean) => results.push({ name, ok });

const w = dayWindow('2026-10-05', 480);
const day: TermDay = {
  term_id: 't', record_date: '2026-10-05', is_target: true,
  window_open_at: new Date(w.openAt).toISOString(), deadline_at: new Date(w.deadlineAt).toISOString(), note: null,
};
const st = { roster_from: null, roster_until: null };
const at = (ms: number) => ({ first_submitted_at: new Date(ms).toISOString() });

check('제출 창 = 10/6 00:00 KST (UTC 10/5 15:00)', new Date(w.openAt).toISOString() === '2026-10-05T15:00:00.000Z');
check('마감 = 10/6 08:00 KST (UTC 10/5 23:00)', new Date(w.deadlineAt).toISOString() === '2026-10-05T23:00:00.000Z');
check('KST 날짜 경계: UTC 14:59:59 → 10/5, 15:00 → 10/6', kstDateOf(Date.parse('2026-10-05T14:59:59Z')) === '2026-10-05' && kstDateOf(Date.parse('2026-10-05T15:00:00Z')) === '2026-10-06');
check('당일 23:59 KST → 예정(제출 창 전)', submitState({ day, student: st, exempt: false, submission: null, now: w.openAt - 60000 }) === 'scheduled');
check('07:59 미접수 → 제출 대기', submitState({ day, student: st, exempt: false, submission: null, now: w.deadlineAt - 60000 }) === 'waiting');
check('08:00 정각 미접수 → 아직 대기', submitState({ day, student: st, exempt: false, submission: null, now: w.deadlineAt }) === 'waiting');
check('08:00:00.001 미접수 → 미제출', submitState({ day, student: st, exempt: false, submission: null, now: w.deadlineAt + 1 }) === 'missing');
check('정각 접수 → 정시', submitState({ day, student: st, exempt: false, submission: at(w.deadlineAt), now: w.deadlineAt + 9e6 }) === 'on_time');
check('1ms 후 접수 → 지각', submitState({ day, student: st, exempt: false, submission: at(w.deadlineAt + 1), now: w.deadlineAt + 9e6 }) === 'late');
check('미제출 후 나중에 제출 → 지각 접수(미제출 명단에서 빠짐)', submitState({ day, student: st, exempt: false, submission: at(w.deadlineAt + 3 * 3600e3), now: w.deadlineAt + 5 * 3600e3 }) === 'late');
check('면제 → 면제(접수 있어도)', submitState({ day, student: st, exempt: true, submission: at(w.openAt + 1000), now: w.deadlineAt + 1 }) === 'exempt');
check('수집 제외일 → 미대상', submitState({ day: { ...day, is_target: false }, student: st, exempt: false, submission: null, now: w.deadlineAt + 1 }) === 'not_target');
check('명단 범위 밖(비활성화 이후) → 미대상', submitState({ day, student: { roster_from: null, roster_until: '2026-10-04' }, exempt: false, submission: null, now: w.deadlineAt + 1 }) === 'not_target');

// 데모 자료(학생 34명)로 날짜별 숫자 정합성
const store = buildDemoStore();
const board = indexBoard(store.submissions, store.exemptions, store.excuses);
for (const clock of DEMO_CLOCKS) {
  let consistent = true;
  for (const d of store.days) {
    const rows = dayRows(d, store.students, board, clock.ms);
    const s = summarize(rows, d);
    const parts = s.received + s.waiting + s.scheduled + s.missing;
    if (d.is_target && (s.target !== parts || s.roster !== s.target + s.exempt || s.received !== s.unchecked + s.checked + s.revision)) consistent = false;
    if (rows.length !== store.students.length) consistent = false;
  }
  check(`[${clock.label}] 모든 날짜: 명단 = 대상 + 면제, 대상 = 접수 + 대기 + 예정 + 미제출`, consistent);
}
const d13 = store.days.find((d) => d.record_date === '2026-10-13')!;
const s13 = (ms: number) => summarize(dayRows(d13, store.students, board, ms), d13);
const before = s13(DEMO_CLOCKS[0].ms);
const exact = s13(DEMO_CLOCKS[1].ms);
const afterS = s13(DEMO_CLOCKS[2].ms);
check('10/13 기록: 마감 전에는 미제출 0, 대기로 표시', before.missing === 0 && before.waiting > 0);
check('10/13 기록: 마감 정각에도 미제출 0', exact.missing === 0 && exact.waiting === before.waiting);
check('10/13 기록: 마감 직후 대기 → 미제출로 같은 수만큼 이동', afterS.waiting === 0 && afterS.missing === before.waiting);

const d12 = store.days.find((d) => d.record_date === '2026-10-12')!;
const s12 = summarize(dayRows(d12, store.students, board, DEMO_CLOCKS[0].ms), d12);
check('10/12 기록: 면제 2명(s09 체험학습, s17 사유 승인)이 분모에서 빠짐', s12.exempt === 2 && s12.target === 32 && s12.roster === 34);
check('10/12 기록: 사유 도착(승인 전) 학생은 여전히 미제출로 집계', dayRows(d12, store.students, board, DEMO_CLOCKS[0].ms).find((r) => r.student.id === 's25')?.state === 'missing' && s12.excuses === 1);

const stu = (id: string) => store.students.find((s) => s.id === id) as Student;
const streak = (id: string, ms: number) => consecutiveMissingCount(stu(id), store.days, board, ms);
check('데모: s14(10/11·10/12 미제출) → 2', streak('s14', DEMO_CLOCKS[0].ms) === 2);
check('데모: s27은 마감 전(10/13 대기)이면 2 미만', streak('s27', DEMO_CLOCKS[0].ms) < 2);
check('데모: s27은 10/13 마감 후 2 이상', streak('s27', DEMO_CLOCKS[2].ms) >= 2);

// 연속 미제출 일수: 10/7~10/11 기록, 각 칸 상태를 지정해 계산
type Cell = 'miss' | 'on' | 'late' | 'exempt' | 'off';
const sDays = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((date): TermDay => {
  const win = dayWindow(date, 480);
  return { term_id: 't', record_date: date, is_target: true, window_open_at: new Date(win.openAt).toISOString(), deadline_at: new Date(win.deadlineAt).toISOString(), note: null };
});
const lastDeadline = (n: number) => Date.parse(sDays[n - 1].deadline_at);
function count(cells: Cell[], now = lastDeadline(cells.length) + 1, roster: Partial<Student> = {}): number {
  const days = sDays.slice(0, cells.length).map((d, i) => (cells[i] === 'off' ? { ...d, is_target: false } : d));
  const subs = cells.flatMap((c, i) => (c === 'on' || c === 'late'
    ? [{ student_id: 'x', record_date: days[i].record_date, first_submitted_at: new Date(Date.parse(days[i].deadline_at) + (c === 'late' ? 1 : 0)).toISOString() } as unknown as Submission]
    : []));
  const exs = cells.flatMap((c, i) => (c === 'exempt' ? [{ student_id: 'x', record_date: days[i].record_date } as unknown as Exemption] : []));
  const student = { id: 'x', roster_from: null, roster_until: null, ...roster } as unknown as Student;
  return consecutiveMissingCount(student, days, indexBoard(subs, exs, []), now);
}
check('연속: 미제출 1일 → 1', count(['miss']) === 1);
check('연속: 미제출 2일 → 2', count(['miss', 'miss']) === 2);
check('연속: 미제출 3일 → 3', count(['miss', 'miss', 'miss']) === 3);
check('연속: 미제출 4일(예시 A) → 4', count(['miss', 'miss', 'miss', 'miss']) === 4);
check('연속: 미제출 5일 → 5', count(['miss', 'miss', 'miss', 'miss', 'miss']) === 5);
check('연속: 중간 정시 접수(예시 B) → 2', count(['miss', 'on', 'miss', 'miss']) === 2);
check('연속: 중간 지각 접수 → 끊김', count(['miss', 'miss', 'late', 'miss']) === 1);
check('연속: 최근 날 정시 접수 → 0', count(['miss', 'miss', 'on']) === 0);
check('연속: 면제일 건너뜀(예시 C) → 3', count(['miss', 'exempt', 'miss', 'miss']) === 3);
check('연속: 수집 제외일 건너뜀(예시 D) → 3', count(['miss', 'miss', 'off', 'miss']) === 3);
check('연속: 마감 전 날짜 건너뜀(예시 E) → 3', count(['miss', 'miss', 'miss', 'miss'], lastDeadline(4) - 60000) === 3);
check('연속: 마지막 날 마감 정각 → 아직 3', count(['miss', 'miss', 'miss', 'miss'], lastDeadline(4)) === 3);
check('연속: 마지막 날 마감 직후(+1ms) → 4', count(['miss', 'miss', 'miss', 'miss'], lastDeadline(4) + 1) === 4);
check('연속: 명단 시작 전 날짜 제외(roster_from 10/9) → 2', count(['miss', 'miss', 'miss', 'miss'], undefined, { roster_from: '2026-10-09' }) === 2);
check('연속: 명단 종료 후 날짜 제외(roster_until 10/9) → 3', count(['miss', 'miss', 'miss', 'miss', 'miss'], undefined, { roster_until: '2026-10-09' }) === 3);
check('kstStartOf(10/14) = UTC 10/13 15:00', new Date(kstStartOf('2026-10-14')).toISOString() === '2026-10-13T15:00:00.000Z');

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
