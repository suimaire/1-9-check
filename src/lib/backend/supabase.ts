// 실제 Supabase 연결. 프런트엔드에는 publishable key만 둔다.
// 연결 오류가 나도 데모 데이터나 가짜 성공으로 바꾸지 않고 오류를 그대로 보여준다.
import {
  createClient, FunctionsFetchError, FunctionsHttpError, type SupabaseClient,
} from '@supabase/supabase-js';
import type {
  ClassInfo, Excuse, Exemption, Me, Student, Submission, TeacherNote, Term, TermDay,
} from '../types.ts';
import { extFor, pickTerm } from './common.ts';
import {
  BackendError, type Backend, type PublicInfo, type PublicSubmitResult, type TeacherData,
} from './types.ts';

const BUCKET = 'screenshots';
// replacement token hash는 교사 화면에도 내려보내지 않는다
const SUBMISSION_COLS = 'id, term_id, student_id, record_date, image_path, image_version, image_mime, image_bytes, first_submitted_at, image_updated_at, self_minutes, student_note, review_status, reviewed_version, revision_message, reviewed_at, resubmit_open';
const PAGE = 1000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw toBackendError(error);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  const e = error as { message?: string; code?: string; status?: number; name?: string };
  const msg = e?.message ?? '';
  if (e?.name === 'TypeError' || /fetch|network|load failed/i.test(msg)) {
    return new BackendError('network', { network: true });
  }
  if (/^[a-z_]{3,40}$/.test(msg)) return new BackendError(msg);
  if (e?.code === '42501' || e?.code === 'PGRST301') return new BackendError('not_allowed');
  return new BackendError('server_error');
}

export function createSupabaseBackend(url: string, publishableKey: string): Backend {
  const sb: SupabaseClient = createClient(url, publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  let clockOffset: { offset: number; at: number } | null = null;

  async function uid(): Promise<string> {
    const { data } = await sb.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new BackendError('unauthorized');
    return id;
  }

  async function invoke<T>(fn: string, body: Record<string, unknown> | FormData): Promise<T> {
    const { data, error } = await sb.functions.invoke(fn, { body });
    if (!error) return data as T;
    if (error instanceof FunctionsHttpError) {
      let code = 'server_error';
      try {
        const payload = await (error.context as Response).json();
        if (payload && typeof payload.error === 'string') code = payload.error;
      } catch {
        // 응답 본문이 JSON이 아니면 server_error로 둔다
      }
      throw new BackendError(code);
    }
    if (error instanceof FunctionsFetchError) throw new BackendError('network', { network: true });
    throw new BackendError('server_error');
  }

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw toBackendError(error);
    return data as T;
  }

  async function serverNow(): Promise<number> {
    if (clockOffset && Date.now() - clockOffset.at < 5 * 60 * 1000) return Date.now() + clockOffset.offset;
    const t0 = Date.now();
    const iso = await rpc<string>('server_time', {});
    const t1 = Date.now();
    const server = Date.parse(iso) + (t1 - t0) / 2;
    clockOffset = { offset: server - t1, at: t1 };
    return server;
  }

  return {
    mode: 'supabase',

    async getMe(): Promise<Me | null> {
      const { data } = await sb.auth.getSession();
      const user = data.session?.user;
      if (!user) return null;
      const { data: p, error } = await sb
        .from('profiles')
        .select('user_id, role, display_name, must_change_password')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw toBackendError(error);
      if (!p) throw new BackendError('no_profile');
      return { userId: p.user_id, role: p.role, displayName: p.display_name, mustChangePassword: p.must_change_password };
    },

    async signIn(loginId, password) {
      const { email } = await invoke<{ email: string }>('login-resolve', { login_id: loginId });
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.status === 429) throw new BackendError('too_many_attempts');
        if (/fetch|network/i.test(error.message)) throw new BackendError('network', { network: true });
        throw new BackendError('invalid_credentials');
      }
    },

    async signOut() {
      clockOffset = null;
      await sb.auth.signOut({ scope: 'local' });
    },

    async changePassword(current, next) {
      const { data } = await sb.auth.getSession();
      const email = data.session?.user.email;
      await invoke('account', { action: 'change_password', current_password: current, new_password: next });
      // 서버(Admin API)에서 비밀번호를 바꾸면 기존 세션이 폐기되므로 새 비밀번호로 다시 로그인한다.
      // (refreshSession만 하면 이후 Edge Function 호출이 unauthorized가 된다 — 실연결에서 확인)
      if (!email) throw new BackendError('unauthorized');
      const { error } = await sb.auth.signInWithPassword({ email, password: next });
      if (error) throw new BackendError(error.status === 429 ? 'too_many_attempts' : 'unauthorized');
    },

    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(cb, 0);
      });
      return () => data.subscription.unsubscribe();
    },

    serverNow,

    async fetchImage(path) {
      const { data, error } = await sb.storage.from(BUCKET).download(path);
      if (error || !data) throw toBackendError(error ?? new Error('not_found'));
      return data;
    },

    // 공개 학번 제출: 학생 브라우저는 DB·Storage에 직접 접근하지 않고 submit 함수만 호출한다.
    async publicInfo(): Promise<PublicInfo> {
      return invoke<PublicInfo>('submit', { action: 'info' });
    },

    async publicSubmit(input): Promise<PublicSubmitResult> {
      const form = new FormData();
      form.append('student_no', input.studentNo);
      form.append('record_date', input.recordDate);
      form.append('request_id', input.requestId);
      if (input.token) form.append('replacement_token', input.token);
      if (input.selfMinutes !== null) form.append('self_minutes', String(input.selfMinutes));
      if (input.note) form.append('note', input.note);
      form.append('file', new File([input.blob], `screenshot.${extFor(input.mime)}`, { type: input.mime }));
      return invoke<PublicSubmitResult>('submit', form);
    },

    async loadTeacherData(termId): Promise<TeacherData | null> {
      const id = await uid();
      const now = await serverNow();
      const { data: links, error } = await sb.from('class_teachers').select('class_id').eq('teacher_id', id);
      if (error) throw toBackendError(error);
      const classId = links?.[0]?.class_id as string | undefined;
      if (!classId) return null;
      const { data: klass, error: e2 } = await sb.from('classes').select('id, name, app_title, app_subtitle').eq('id', classId).single<ClassInfo>();
      if (e2) throw toBackendError(e2);
      const { data: termRows, error: e3 } = await sb.from('terms').select('*').eq('class_id', classId);
      if (e3) throw toBackendError(e3);
      const terms = (termRows ?? []) as Term[];
      const term = (termId && terms.find((t) => t.id === termId)) || pickTerm(terms, now);
      const students = await fetchAll<Student>((a, b) => sb.from('students').select('id, class_id, student_no, name, active, roster_from, roster_until').eq('class_id', classId).order('student_no').range(a, b));
      if (!term) return { klass, terms, term: null, days: [], students, submissions: [], excuses: [], exemptions: [] };
      const [days, submissions, excuses, exemptions] = await Promise.all([
        fetchAll<TermDay>((a, b) => sb.from('term_days').select('*').eq('term_id', term.id).order('record_date').range(a, b)),
        fetchAll<Submission>((a, b) => sb.from('submissions').select(SUBMISSION_COLS).eq('term_id', term.id).order('id').range(a, b)),
        fetchAll<Excuse>((a, b) => sb.from('excuse_requests').select('*').eq('term_id', term.id).order('id').range(a, b)),
        fetchAll<Exemption>((a, b) => sb.from('exemptions').select('term_id, student_id, record_date, reason').eq('term_id', term.id).order('record_date').range(a, b)),
      ]);
      return { klass, terms, term, days, students, submissions, excuses, exemptions };
    },

    async reviewSubmission(submissionId, version, status, message) {
      await rpc('review_submission', { p_submission_id: submissionId, p_version: version, p_status: status, p_message: message });
    },

    async allowResubmission(submissionId, open) {
      await rpc('allow_resubmission', { p_submission_id: submissionId, p_open: open });
    },

    async resolveExcuse(excuseId, approve) {
      await rpc('resolve_excuse', { p_excuse_id: excuseId, p_approve: approve });
    },

    async setExemptions(termId, studentId, from, to, exempt, reason) {
      return rpc<number>('set_exemptions', {
        p_term_id: termId, p_student_id: studentId, p_from: from, p_to: to, p_exempt: exempt, p_reason: reason,
      });
    },

    async listNotes(studentId, termId) {
      const { data, error } = await sb
        .from('teacher_notes')
        .select('*')
        .eq('student_id', studentId)
        .eq('term_id', termId)
        .order('created_at', { ascending: false });
      if (error) throw toBackendError(error);
      return (data ?? []) as TeacherNote[];
    },

    async addNote(studentId, termId, recordDate, body) {
      const { error } = await sb.from('teacher_notes').insert({ student_id: studentId, term_id: termId, record_date: recordDate, body });
      if (error) throw toBackendError(error);
    },

    async deleteNote(noteId) {
      const { error } = await sb.from('teacher_notes').delete().eq('id', noteId);
      if (error) throw toBackendError(error);
    },

    async addStudents(classId, rows) {
      if (!rows.length) return;
      const { error } = await sb.from('students').insert(rows.map((r) => ({ class_id: classId, ...r })));
      if (error) throw toBackendError(error);
    },

    async updateStudent(studentId, patch) {
      const { error } = await sb.from('students').update(patch).eq('id', studentId);
      if (error) throw toBackendError(error);
    },

    async setStudentActive(studentId, active, rosterUntil) {
      await invoke('teacher-admin', { action: 'set_active', student_id: studentId, active, roster_until: rosterUntil });
    },

    async saveClassTitle(classId, title, subtitle) {
      const { error } = await sb.from('classes').update({ app_title: title, app_subtitle: subtitle }).eq('id', classId);
      if (error) throw toBackendError(error);
    },

    async saveTerm(classId, t) {
      return rpc<string>('save_term', {
        p_class_id: classId,
        p_term_id: t.termId,
        p_name: t.name,
        p_start: t.startDate,
        p_last: t.lastRecordDate,
        p_deadline_minutes: t.deadlineMinutes,
        p_final_close_at: t.finalCloseAt,
        p_retention_until: t.retentionUntil,
        p_instructions: t.instructions,
      });
    },

    async setDayTarget(termId, date, isTarget, note) {
      await rpc('set_day_target', { p_term_id: termId, p_record_date: date, p_is_target: isTarget, p_note: note });
    },

    async cleanupImages(termId) {
      return invoke('teacher-admin', { action: 'cleanup_images', term_id: termId });
    },

    async purgePreview(termId) {
      return invoke('teacher-admin', { action: 'purge_preview', term_id: termId });
    },

    async purgeExecute(termId, confirmName) {
      return invoke('teacher-admin', { action: 'purge_execute', term_id: termId, confirm_name: confirmName });
    },
  };
}
