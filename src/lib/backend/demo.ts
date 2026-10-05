// 데모 백엔드: 브라우저 메모리에서만 동작(네트워크·운영 저장소와 완전히 분리).
// 서버와 같은 규칙(제출 창·버전 비교·재시도 멱등성·교사 버전 확인)을 흉내 낸다.
import { canSubmitDay } from '../status.ts';
import type { Me, Submission } from '../types.ts';
import { pickTerm, uuid } from './common.ts';
import {
  buildDemoStore, DEMO_CLASS_ID, DEMO_CLOCKS, renderSyntheticScreenshot, type DemoStore,
} from './demoData.ts';
import { BackendError, type Backend, type PublicSubmitResult } from './types.ts';

export type DemoFailure = 'none' | 'upload' | 'confirm_lost';

export interface DemoControls {
  clockId: string;
  setClock(id: string): void;
  failure: DemoFailure;
  setFailure(f: DemoFailure): void;
  subscribe(cb: () => void): () => void;
}

export function createDemoBackend(): Backend & { demo: DemoControls } {
  let store: DemoStore = buildDemoStore();
  let me: Me | null = null;
  const authListeners = new Set<() => void>();
  const controlListeners = new Set<() => void>();
  let clockId = DEMO_CLOCKS[0].id;
  let failure: DemoFailure = 'none';

  const now = () => DEMO_CLOCKS.find((c) => c.id === clockId)!.ms;
  const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const notifyAuth = () => authListeners.forEach((cb) => setTimeout(cb, 0));
  const clone = <T,>(v: T): T => structuredClone(v);

  function requireTeacher() {
    if (!me || me.role !== 'teacher') throw new BackendError('not_allowed');
  }
  function term() {
    return pickTerm(store.terms, now());
  }
  function assertSubmittable(studentId: string, termId: string, date: string) {
    const s = store.students.find((x) => x.id === studentId)!;
    const t = store.terms.find((x) => x.id === termId);
    if (!t) throw new BackendError('not_allowed');
    const day = store.days.find((d) => d.term_id === termId && d.record_date === date);
    if (!day) throw new BackendError('date_out_of_range');
    if (!day.is_target) throw new BackendError('not_target_day');
    if (now() < Date.parse(day.window_open_at)) throw new BackendError('window_not_open');
    if (!canSubmitDay(day, s, t.final_close_at, now())) throw new BackendError('window_closed');
    return day;
  }

  const controls: DemoControls = {
    get clockId() { return clockId; },
    setClock(id) { clockId = id; controlListeners.forEach((cb) => cb()); },
    get failure() { return failure; },
    setFailure(f) { failure = f; controlListeners.forEach((cb) => cb()); },
    subscribe(cb) { controlListeners.add(cb); return () => controlListeners.delete(cb); },
  };

  return {
    mode: 'demo',
    demo: controls,

    async getMe() { return me ? { ...me } : null; },

    async signIn(loginId) {
      await delay();
      if (loginId.trim().toLowerCase() !== 'teacher') throw new BackendError('invalid_credentials');
      me = { userId: 'demo-teacher', role: 'teacher', displayName: '담임(데모)', mustChangePassword: false };
      notifyAuth();
    },

    async signOut() {
      me = null;
      notifyAuth();
    },

    async changePassword(_current, next) {
      await delay();
      if (next.length < 8) throw new BackendError('weak_password');
      if (me) me.mustChangePassword = false;
    },

    onAuthChange(cb) {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },

    async serverNow() { return now(); },

    async fetchImage(path) {
      await delay(150);
      const existing = store.images.get(path);
      if (existing) return existing;
      const [, sid, date] = path.split('/');
      const s = store.students.find((x) => x.id === sid);
      const sub = store.submissions.find((x) => x.image_path === path);
      if (!s || !sub) throw new BackendError('not_found');
      if (me?.role !== 'teacher') throw new BackendError('not_allowed');
      const blob = await renderSyntheticScreenshot(s.name, date, sub.self_minutes ?? 95 + (date.charCodeAt(9) * 7) % 200);
      store.images.set(path, blob);
      return blob;
    },

    async publicInfo() {
      await delay(150);
      const t = term();
      const days = store.days.filter((d) => d.term_id === t?.id && d.is_target);
      const nowMs = now();
      const open = t && nowMs <= Date.parse(t.final_close_at)
        ? days.filter((d) => Date.parse(d.window_open_at) <= nowMs).sort((a, b) => (a.record_date < b.record_date ? 1 : -1)).slice(0, 7)
        : [];
      const next = days.filter((d) => Date.parse(d.window_open_at) > nowMs).sort((a, b) => (a.record_date < b.record_date ? -1 : 1))[0];
      const pick = (d: (typeof days)[number]) => ({ record_date: d.record_date, window_open_at: d.window_open_at, deadline_at: d.deadline_at });
      return {
        server_now: new Date(nowMs).toISOString(),
        ready: true,
        app_title: store.klass.app_title,
        app_subtitle: store.klass.app_subtitle,
        term: t ? { name: t.name, instructions: t.instructions, final_close_at: t.final_close_at } : null,
        open_days: open.map(pick),
        next_day: next ? pick(next) : null,
      };
    },

    async publicSubmit(input) {
      await delay(500);
      if (!/^109(0[1-9]|[12][0-9]|3[0-4])$/.test(input.studentNo)) throw new BackendError('invalid_student_no');
      const s = store.students.find((x) => x.student_no === input.studentNo && x.active);
      if (!s) throw new BackendError('invalid_student_no');
      if (failure === 'upload') {
        controls.setFailure('none');
        throw new BackendError('network', { network: true });
      }
      const newToken = () => uuid().replace(/-/g, '') + uuid().replace(/-/g, '');
      const result = (sub: Submission, replayed: boolean, replaced: boolean, token?: string): PublicSubmitResult => {
        const day = store.days.find((d) => d.record_date === sub.record_date)!;
        return {
          replayed, replaced, record_date: sub.record_date, version: sub.image_version,
          first_submitted_at: sub.first_submitted_at, deadline_at: day.deadline_at,
          late: Date.parse(sub.first_submitted_at) > Date.parse(day.deadline_at),
          ...(token ? { replacement_token: token } : {}),
        };
      };
      const replay = store.events.get(input.requestId);
      if (replay) {
        const sub = store.submissions.find((x) => x.id === replay.submissionId)!;
        // 응답을 못 받은 token 발급 요청의 재시도: token을 새로 발급한다(서버와 같은 규칙)
        const fresh = replay.issuedToken ? newToken() : undefined;
        if (fresh) store.tokens.set(sub.id, fresh);
        return result(sub, true, replay.version > 1, fresh);
      }
      const t = term();
      if (!t) throw new BackendError('date_out_of_range');
      assertSubmittable(s.id, t.id, input.recordDate);
      if (input.selfMinutes !== null && (input.selfMinutes < 0 || input.selfMinutes > 1440)) throw new BackendError('bad_minutes');
      if ((input.note ?? '').length > 100) throw new BackendError('note_too_long');

      const ts = new Date(now()).toISOString();
      const path = `demo/${s.id}/${input.recordDate}/${uuid()}`;
      let sub = store.submissions.find((x) => x.student_id === s.id && x.term_id === t.id && x.record_date === input.recordDate);
      let token: string | undefined;
      if (!sub) {
        sub = {
          id: `sub-${uuid()}`, term_id: t.id, student_id: s.id, record_date: input.recordDate,
          image_path: path, image_version: 1, image_mime: input.mime, image_bytes: input.blob.size,
          first_submitted_at: ts, image_updated_at: ts, self_minutes: input.selfMinutes,
          student_note: input.note?.trim() || null, review_status: 'unchecked', reviewed_version: null,
          revision_message: null, reviewed_at: null, resubmit_open: false,
        } satisfies Submission;
        store.submissions.push(sub);
        token = newToken();
      } else {
        const tokenOk = !!input.token && store.tokens.get(sub.id) === input.token;
        if (!tokenOk && !sub.resubmit_open) throw new BackendError('already_submitted');
        if (!tokenOk) token = newToken();
        store.images.delete(sub.image_path); // 데모: 교체 전 이미지는 바로 정리
        Object.assign(sub, {
          image_path: path, image_version: sub.image_version + 1, image_mime: input.mime, image_bytes: input.blob.size,
          image_updated_at: ts, self_minutes: input.selfMinutes, student_note: input.note?.trim() || null,
          review_status: 'unchecked', reviewed_version: null, reviewed_at: null, resubmit_open: false,
        });
      }
      if (token) store.tokens.set(sub.id, token);
      store.images.set(path, input.blob);
      store.events.set(input.requestId, { submissionId: sub.id, version: sub.image_version, path, issuedToken: !!token });
      if (failure === 'confirm_lost') {
        // 서버는 반영했지만 응답이 유실된 상황
        controls.setFailure('none');
        throw new BackendError('network', { network: true });
      }
      return result(sub, false, sub.image_version > 1, token);
    },

    async loadTeacherData(termId) {
      await delay();
      requireTeacher();
      const t = (termId && store.terms.find((x) => x.id === termId)) || term();
      return clone({
        klass: store.klass,
        terms: store.terms,
        term: t,
        days: store.days.filter((d) => d.term_id === t?.id),
        students: [...store.students].sort((a, b) => a.student_no.localeCompare(b.student_no)),
        submissions: store.submissions.filter((x) => x.term_id === t?.id),
        excuses: store.excuses.filter((x) => x.term_id === t?.id),
        exemptions: store.exemptions.filter((x) => x.term_id === t?.id),
      });
    },

    async reviewSubmission(submissionId, version, status, message) {
      await delay();
      requireTeacher();
      const sub = store.submissions.find((x) => x.id === submissionId);
      if (!sub) throw new BackendError('not_allowed');
      if (sub.image_version !== version) throw new BackendError('stale_version');
      if (status === 'revision_requested' && !message.trim()) throw new BackendError('message_required');
      sub.review_status = status;
      sub.reviewed_version = status === 'unchecked' ? null : version;
      if (status === 'revision_requested') sub.revision_message = message.trim();
      sub.reviewed_at = new Date(now()).toISOString();
    },

    async allowResubmission(submissionId, open) {
      await delay();
      requireTeacher();
      const sub = store.submissions.find((x) => x.id === submissionId);
      if (!sub) throw new BackendError('not_allowed');
      sub.resubmit_open = open;
    },

    async resolveExcuse(excuseId, approve) {
      await delay();
      requireTeacher();
      const ex = store.excuses.find((x) => x.id === excuseId);
      if (!ex) throw new BackendError('not_allowed');
      ex.status = approve ? 'approved' : 'declined';
      if (approve && !store.exemptions.some((e) => e.student_id === ex.student_id && e.record_date === ex.record_date)) {
        store.exemptions.push({ term_id: ex.term_id, student_id: ex.student_id, record_date: ex.record_date, reason: '사유 승인' });
      }
    },

    async setExemptions(termId, studentId, from, to, exempt, reason) {
      await delay();
      requireTeacher();
      const dates = store.days.filter((d) => d.term_id === termId && d.record_date >= from && d.record_date <= to).map((d) => d.record_date);
      store.exemptions = store.exemptions.filter((e) => !(e.student_id === studentId && dates.includes(e.record_date)));
      if (exempt) for (const d of dates) store.exemptions.push({ term_id: termId, student_id: studentId, record_date: d, reason: reason.trim() || null });
      return dates.length;
    },

    async listNotes(studentId, termId) {
      requireTeacher();
      return clone(store.notes.filter((n) => n.student_id === studentId && n.term_id === termId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
    },

    async addNote(studentId, termId, recordDate, body) {
      requireTeacher();
      const ts = new Date(now()).toISOString();
      store.notes.push({ id: `note-${uuid()}`, term_id: termId, student_id: studentId, record_date: recordDate, body, created_at: ts, updated_at: ts });
    },

    async deleteNote(noteId) {
      requireTeacher();
      store.notes = store.notes.filter((n) => n.id !== noteId);
    },

    async addStudents(classId, rows) {
      await delay();
      requireTeacher();
      for (const r of rows) {
        if (store.students.some((s) => s.student_no === r.student_no)) throw new BackendError('duplicate_student_no');
        store.students.push({
          id: `s-${uuid()}`, class_id: classId, student_no: r.student_no, name: r.name,
          active: true, roster_from: r.roster_from, roster_until: null,
        });
      }
    },

    async updateStudent(studentId, patch) {
      await delay();
      requireTeacher();
      const s = store.students.find((x) => x.id === studentId);
      if (!s) throw new BackendError('not_allowed');
      Object.assign(s, patch);
    },

    async setStudentActive(studentId, active, rosterUntil) {
      await delay();
      requireTeacher();
      const s = store.students.find((x) => x.id === studentId);
      if (!s) throw new BackendError('not_allowed');
      s.active = active;
      s.roster_until = active ? null : rosterUntil;
    },

    async saveClassTitle(_classId, title, subtitle) {
      requireTeacher();
      store.klass = { ...store.klass, app_title: title, app_subtitle: subtitle };
    },

    async saveTerm(_classId, input) {
      await delay();
      requireTeacher();
      const t = store.terms.find((x) => x.id === input.termId);
      if (!t) throw new BackendError('demo_term_fixed');
      // 데모에서는 이름·마감·안내문 변경만 반영(날짜 범위 고정). 열린 날짜의 마감은 유지.
      t.name = input.name;
      t.instructions = input.instructions;
      t.retention_until = input.retentionUntil;
      if (input.finalCloseAt) t.final_close_at = input.finalCloseAt;
      t.deadline_minutes = input.deadlineMinutes;
      for (const d of store.days) {
        if (Date.parse(d.window_open_at) > now()) {
          d.deadline_at = new Date(Date.parse(d.window_open_at) + input.deadlineMinutes * 60000).toISOString();
        }
      }
      return t.id;
    },

    async setDayTarget(termId, date, isTarget, note) {
      requireTeacher();
      const d = store.days.find((x) => x.term_id === termId && x.record_date === date);
      if (!d) throw new BackendError('date_out_of_range');
      d.is_target = isTarget;
      d.note = note.trim() || null;
    },

    async cleanupImages() {
      await delay();
      requireTeacher();
      return { found: 0, deleted: 0, failed: 0 };
    },

    async purgePreview(termId) {
      requireTeacher();
      const t = store.terms.find((x) => x.id === termId)!;
      const subs = store.submissions.filter((x) => x.term_id === termId);
      return {
        term_id: t.id, name: t.name, start_date: t.start_date, last_record_date: t.last_record_date,
        submissions: subs.length, submission_events: store.events.size,
        excuse_requests: store.excuses.filter((x) => x.term_id === termId).length,
        exemptions: store.exemptions.filter((x) => x.term_id === termId).length,
        teacher_notes: store.notes.filter((x) => x.term_id === termId).length,
        term_days: store.days.filter((x) => x.term_id === termId).length,
        objects: subs.length,
      };
    },

    async purgeExecute(termId, confirmName) {
      await delay(600);
      requireTeacher();
      const t = store.terms.find((x) => x.id === termId);
      if (!t || t.name !== confirmName) throw new BackendError('confirm_mismatch');
      const count = store.submissions.filter((x) => x.term_id === termId).length;
      // 데모는 처음 상태로 되돌린다(운영 저장소와 무관)
      store = buildDemoStore();
      return { status: 'done', objects_deleted: count };
    },
  };
}

export const DEMO_HINT = {
  teacherLogin: 'teacher',
  classId: DEMO_CLASS_ID,
};
