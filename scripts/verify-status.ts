// 화면 집계 규칙 확인(항목 5): KST 마감 전/정각/직후, 면제, 늦은 제출, 2일 연속 미제출, 숫자 정합성.
// Node 22.18+ 타입 제거 실행: node scripts/verify-status.ts
import { buildDemoStore, DEMO_CLOCKS } from '../src/lib/backend/demoData.ts';
import { dayWindow, kstDateOf, kstStartOf } from '../src/lib/kst.ts';
import { dayRows, indexBoard, submitState, summarize, twoDayMissing } from '../src/lib/status.ts';
import type { Student, TermDay } from '../src/lib/types.ts';

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
check('2일 연속 미제출: s14(10/11·10/12 미제출) 표시', twoDayMissing(stu('s14'), store.days, board, DEMO_CLOCKS[0].ms));
check('2일 연속 미제출: s27은 마감 전(10/13 대기)이면 미표시', !twoDayMissing(stu('s27'), store.days, board, DEMO_CLOCKS[0].ms));
check('2일 연속 미제출: s27은 10/13 마감 후 표시', twoDayMissing(stu('s27'), store.days, board, DEMO_CLOCKS[2].ms));
check('2일 연속 미제출: 면제일은 건너뜀(s09 미표시)', !twoDayMissing(stu('s09'), store.days, board, DEMO_CLOCKS[2].ms));
check('kstStartOf(10/14) = UTC 10/13 15:00', new Date(kstStartOf('2026-10-14')).toISOString() === '2026-10-13T15:00:00.000Z');

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
