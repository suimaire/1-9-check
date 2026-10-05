import type {
  ClassInfo, Excuse, Exemption, Me, ReviewStatus, Student, Submission, TeacherNote, Term, TermDay,
} from '../types.ts';

export interface TeacherData {
  klass: ClassInfo;
  terms: Term[];
  term: Term | null;
  days: TermDay[];
  students: Student[];
  submissions: Submission[];
  excuses: Excuse[];
  exemptions: Exemption[];
}

/** 공개 제출 화면용 일정(학생 이름·제출 현황 없음) */
export interface PublicDay {
  record_date: string;
  window_open_at: string;
  deadline_at: string;
}

export interface PublicInfo {
  server_now: string;
  /** 공개 제출 학급이 지정돼 있는가 */
  ready: boolean;
  app_title?: string;
  app_subtitle?: string;
  term: { name: string; instructions: string; final_close_at: string } | null;
  /** 지금 제출할 수 있는 대상일(최신순) */
  open_days: PublicDay[];
  next_day: PublicDay | null;
}

export interface PublicSubmitInput {
  studentNo: string;
  recordDate: string;
  blob: Blob;
  mime: string;
  /** 같은 제출 시도(재시도 포함)에서 유지되는 값 */
  requestId: string;
  /** 이 기기에 저장된 replacement token(없으면 null) */
  token: string | null;
  selfMinutes: number | null;
  note: string | null;
}

export interface PublicSubmitResult {
  replayed: boolean;
  replaced: boolean;
  record_date: string;
  version: number;
  first_submitted_at: string;
  deadline_at: string;
  late: boolean;
  /** 첫 제출(또는 담임 허용 후 재제출) 때만 서버가 발급. 이 기기에만 저장한다. */
  replacement_token?: string;
}

export interface TermInput {
  termId: string | null;
  name: string;
  startDate: string;
  lastRecordDate: string;
  deadlineMinutes: number;
  finalCloseAt: string | null;
  retentionUntil: string | null;
  instructions: string;
}

export interface PurgePreview {
  term_id: string;
  name: string;
  start_date: string;
  last_record_date: string;
  submissions: number;
  submission_events: number;
  excuse_requests: number;
  exemptions: number;
  teacher_notes: number;
  term_days: number;
  objects: number;
}

export interface PurgeResult {
  status: 'done' | 'partial';
  objects_deleted: number;
  objects_failed?: number;
  db_error?: string;
}

/** 서버가 돌려준 오류 코드(사용자 문구로 변환해서 보여준다) */
export class BackendError extends Error {
  code: string;
  /** 네트워크 단절 등으로 서버 응답 자체를 받지 못함 */
  network: boolean;
  constructor(code: string, opts: { network?: boolean } = {}) {
    super(code);
    this.code = code;
    this.network = opts.network ?? false;
  }
}

export interface Backend {
  mode: 'supabase' | 'demo';
  // 교사 Auth
  getMe(): Promise<Me | null>;
  signIn(loginId: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  onAuthChange(cb: () => void): () => void;
  serverNow(): Promise<number>;
  fetchImage(path: string): Promise<Blob>;

  // 공개 학번 제출(로그인 없음 — 서버 함수만 호출)
  publicInfo(): Promise<PublicInfo>;
  publicSubmit(input: PublicSubmitInput): Promise<PublicSubmitResult>;

  // 교사
  loadTeacherData(termId?: string | null): Promise<TeacherData | null>;
  reviewSubmission(submissionId: string, version: number, status: ReviewStatus, message: string): Promise<void>;
  allowResubmission(submissionId: string, open: boolean): Promise<void>;
  resolveExcuse(excuseId: string, approve: boolean): Promise<void>;
  setExemptions(termId: string, studentId: string, from: string, to: string, exempt: boolean, reason: string): Promise<number>;
  listNotes(studentId: string, termId: string): Promise<TeacherNote[]>;
  addNote(studentId: string, termId: string, recordDate: string | null, body: string): Promise<void>;
  deleteNote(noteId: string): Promise<void>;
  addStudents(classId: string, rows: Array<{ student_no: string; name: string; roster_from: string | null }>): Promise<void>;
  updateStudent(studentId: string, patch: { student_no?: string; name?: string; roster_from?: string | null; roster_until?: string | null }): Promise<void>;
  setStudentActive(studentId: string, active: boolean, rosterUntil: string | null): Promise<void>;
  saveClassTitle(classId: string, title: string, subtitle: string): Promise<void>;
  saveTerm(classId: string, input: TermInput): Promise<string>;
  setDayTarget(termId: string, date: string, isTarget: boolean, note: string): Promise<void>;
  cleanupImages(termId: string): Promise<{ found: number; deleted: number; failed: number }>;
  purgePreview(termId: string): Promise<PurgePreview>;
  purgeExecute(termId: string, confirmName: string): Promise<PurgeResult>;
}
