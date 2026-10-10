// 제출 상태 판정과 집계. 학생 화면·교사 화면·데모가 같은 규칙을 쓴다.
// 접수 시각(first_submitted_at)과 날짜별 마감(deadline_at)은 서버가 정한 값만 사용한다.
import type { Exemption, Excuse, Student, Submission, TermDay } from './types.ts';

export type SubmitState = 'not_target' | 'exempt' | 'scheduled' | 'waiting' | 'on_time' | 'late' | 'missing';

export const STATE_LABEL: Record<SubmitState, string> = {
  not_target: '미대상',
  exempt: '면제',
  scheduled: '예정',
  waiting: '제출 대기',
  on_time: '정시 접수',
  late: '지각 접수',
  missing: '미제출',
};

export const STATE_SHORT: Record<SubmitState, string> = {
  not_target: '－',
  exempt: '면제',
  scheduled: '예정',
  waiting: '대기',
  on_time: '정시',
  late: '지각',
  missing: '미제출',
};

export function inRoster(student: Pick<Student, 'roster_from' | 'roster_until'>, date: string): boolean {
  return (!student.roster_from || date >= student.roster_from) && (!student.roster_until || date <= student.roster_until);
}

export interface CellInput {
  day: TermDay;
  student: Pick<Student, 'roster_from' | 'roster_until'>;
  exempt: boolean;
  submission: Pick<Submission, 'first_submitted_at'> | null;
  now: number;
}

export function submitState({ day, student, exempt, submission, now }: CellInput): SubmitState {
  if (!day.is_target || !inRoster(student, day.record_date)) return 'not_target';
  if (exempt) return 'exempt';
  if (submission) {
    return Date.parse(submission.first_submitted_at) <= Date.parse(day.deadline_at) ? 'on_time' : 'late';
  }
  if (now < Date.parse(day.window_open_at)) return 'scheduled';
  if (now <= Date.parse(day.deadline_at)) return 'waiting';
  return 'missing';
}

/** 학생이 지금 해당 날짜를 제출(또는 사유 전달)할 수 있는가 — 서버 규칙과 같은 조건 */
export function canSubmitDay(day: TermDay, student: Pick<Student, 'roster_from' | 'roster_until' | 'active'>, finalCloseAt: string, now: number): boolean {
  return (
    student.active &&
    day.is_target &&
    inRoster(student, day.record_date) &&
    now >= Date.parse(day.window_open_at) &&
    now <= Date.parse(finalCloseAt)
  );
}

/** 가장 최근에 끝난 수집 대상일(제출 창이 열린 날 중 가장 늦은 날) */
export function latestFinishedTargetDay(days: TermDay[], now: number): TermDay | null {
  let best: TermDay | null = null;
  for (const d of days) {
    if (d.is_target && now >= Date.parse(d.window_open_at) && (!best || d.record_date > best.record_date)) best = d;
  }
  return best;
}

export type Key = string;
export const cellKey = (studentId: string, date: string): Key => `${studentId}|${date}`;

export interface Board {
  submissions: Map<Key, Submission>;
  exemptions: Set<Key>;
  excuses: Map<Key, Excuse>;
}

export function indexBoard(submissions: Submission[], exemptions: Exemption[], excuses: Excuse[]): Board {
  return {
    submissions: new Map(submissions.map((s) => [cellKey(s.student_id, s.record_date), s])),
    exemptions: new Set(exemptions.map((e) => cellKey(e.student_id, e.record_date))),
    excuses: new Map(excuses.map((e) => [cellKey(e.student_id, e.record_date), e])),
  };
}

export interface Row {
  student: Student;
  state: SubmitState;
  submission: Submission | null;
  excuse: Excuse | null;
}

export function dayRows(day: TermDay, students: Student[], board: Board, now: number): Row[] {
  return students.map((student) => {
    const k = cellKey(student.id, day.record_date);
    const submission = board.submissions.get(k) ?? null;
    return {
      student,
      submission,
      excuse: board.excuses.get(k) ?? null,
      state: submitState({ day, student, exempt: board.exemptions.has(k), submission, now }),
    };
  });
}

export interface DaySummary {
  roster: number; // 해당 날짜 명단 인원(대상 범위 안의 학생)
  target: number; // 제출 대상 = 명단 − 면제 (미대상일이면 0)
  received: number; // 정시 + 지각
  onTime: number;
  late: number;
  waiting: number;
  scheduled: number;
  missing: number;
  exempt: number;
  unchecked: number; // 접수 중 미확인
  checked: number;
  revision: number; // 접수 중 수정 요청
  excuses: number; // 사유 도착(대기 중)
}

export function summarize(rows: Row[], day: TermDay): DaySummary {
  const s: DaySummary = {
    roster: 0, target: 0, received: 0, onTime: 0, late: 0, waiting: 0, scheduled: 0,
    missing: 0, exempt: 0, unchecked: 0, checked: 0, revision: 0, excuses: 0,
  };
  for (const r of rows) {
    if (inRoster(r.student, day.record_date)) s.roster++;
    switch (r.state) {
      case 'exempt': s.exempt++; break;
      case 'on_time': s.onTime++; break;
      case 'late': s.late++; break;
      case 'waiting': s.waiting++; break;
      case 'scheduled': s.scheduled++; break;
      case 'missing': s.missing++; break;
      default: break;
    }
    if ((r.state === 'on_time' || r.state === 'late') && r.submission) {
      if (r.submission.review_status === 'unchecked') s.unchecked++;
      else if (r.submission.review_status === 'checked') s.checked++;
      else s.revision++;
    }
    if (r.excuse && r.excuse.status === 'pending' && r.state !== 'not_target') s.excuses++;
  }
  s.received = s.onTime + s.late;
  s.target = day.is_target ? s.received + s.waiting + s.scheduled + s.missing : 0;
  return s;
}

/** 연속 미제출 표시 기준(교사 참고용): 이 일수 이상일 때만 표시 */
export const STREAK_MIN = 2;

/**
 * 연속 미제출 일수(교사 참고용).
 * 최신 날짜부터 거꾸로 보며 마감이 지난 수집 대상일의 미제출을 센다.
 * 정시·지각 접수를 만나면 끊기고, 면제·미대상(수집 제외·명단 범위 밖)·예정·대기(마감 전)는 건너뛴다.
 */
export function consecutiveMissingCount(student: Student, days: TermDay[], board: Board, now: number): number {
  const sorted = [...days].sort((a, b) => (a.record_date < b.record_date ? 1 : -1));
  let count = 0;
  for (const day of sorted) {
    const k = cellKey(student.id, day.record_date);
    const state = submitState({
      day, student, exempt: board.exemptions.has(k), submission: board.submissions.get(k) ?? null, now,
    });
    if (state === 'missing') count++;
    else if (state === 'on_time' || state === 'late') break;
  }
  return count;
}
