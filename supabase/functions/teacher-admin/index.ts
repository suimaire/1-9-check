// 교사 전용 관리 기능(Admin API·Storage API가 필요한 것만). 학생 계정 발급·비밀번호 초기화는 없다(학번 제출).
// 모든 동작에서 호출자가 해당 학급 담당 교사인지 서버 DB로 확인한다.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  adminClient,
  BUCKET,
  corsHeaders,
  dbErrorCode,
  fail,
  json,
  readJson,
  requireUser,
} from '../_shared/util.ts';

const BAN_FOREVER = '876000h';

async function teacherClassIds(admin: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data: profile } = await admin
    .from('profiles')
    .select('role, must_change_password')
    .eq('user_id', userId)
    .maybeSingle();
  if (!profile || profile.role !== 'teacher' || profile.must_change_password) return new Set();
  const { data } = await admin.from('class_teachers').select('class_id').eq('teacher_id', userId);
  return new Set((data ?? []).map((r) => r.class_id as string));
}

async function studentInClasses(admin: SupabaseClient, studentId: unknown, classes: Set<string>) {
  if (typeof studentId !== 'string') return null;
  const { data } = await admin.from('students').select('*').eq('id', studentId).maybeSingle();
  return data && classes.has(data.class_id) ? data : null;
}

async function termInClasses(admin: SupabaseClient, termId: unknown, classes: Set<string>) {
  if (typeof termId !== 'string') return null;
  const { data } = await admin.from('terms').select('*').eq('id', termId).maybeSingle();
  return data && classes.has(data.class_id) ? data : null;
}

async function removeObjects(admin: SupabaseClient, names: string[]) {
  let deleted = 0;
  const failed: string[] = [];
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100);
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk);
    if (error) {
      failed.push(...chunk);
      continue;
    }
    const removed = new Set((data ?? []).map((o) => o.name));
    deleted += removed.size;
    for (const n of chunk) if (!removed.has(n)) failed.push(n);
  }
  return { deleted, failed: failed.length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405);

  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthorized', 401);
  const admin = adminClient();
  const classes = await teacherClassIds(admin, user.id);
  if (classes.size === 0) return fail(req, 'not_allowed', 403);

  const body = (await readJson(req)) ?? {};
  const action = body.action;

  // 비활성화: 기록은 지우지 않고 roster_until 이후 날짜만 대상에서 빠진다(공개 제출도 거절).
  // 예전 방식의 학생 Auth 계정이 연결돼 있으면 그 로그인도 차단한다.
  if (action === 'set_active') {
    const s = await studentInClasses(admin, body.student_id, classes);
    if (!s) return fail(req, 'not_allowed', 403);
    const active = body.active === true;
    const until = typeof body.roster_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.roster_until) ? body.roster_until : null;
    const { error } = await admin
      .from('students')
      .update({ active, roster_until: active ? null : until, updated_at: new Date().toISOString() })
      .eq('id', s.id);
    if (error) return fail(req, dbErrorCode(error));
    if (s.user_id) await admin.auth.admin.updateUserById(s.user_id, { ban_duration: active ? 'none' : BAN_FOREVER });
    return json(req, { ok: true });
  }

  // 현재 제출에 연결되지 않은 이미지(교체 전 이미지·확정 실패 업로드) 정리
  if (action === 'cleanup_images') {
    const term = await termInClasses(admin, body.term_id, classes);
    if (!term) return fail(req, 'not_allowed', 403);
    const { data, error } = await admin.rpc('term_object_names', { p_term_id: term.id, p_only_orphans: true });
    if (error) return fail(req, 'server_error', 500);
    const names = (data ?? []) as string[];
    const result = await removeObjects(admin, names);
    return json(req, { found: names.length, ...result });
  }

  if (action === 'purge_preview') {
    const term = await termInClasses(admin, body.term_id, classes);
    if (!term) return fail(req, 'not_allowed', 403);
    const { data, error } = await admin.rpc('purge_preview', { p_term_id: term.id });
    if (error) return fail(req, 'server_error', 500);
    return json(req, data);
  }

  // 운영 기간 자료 삭제: Storage 객체를 Storage API로 먼저 지우고, 모두 지워졌을 때만 DB 행을 지운다.
  if (action === 'purge_execute') {
    const term = await termInClasses(admin, body.term_id, classes);
    if (!term) return fail(req, 'not_allowed', 403);
    if (body.confirm_name !== term.name) return fail(req, 'confirm_mismatch');
    const { data, error } = await admin.rpc('term_object_names', { p_term_id: term.id, p_only_orphans: false });
    if (error) return fail(req, 'server_error', 500);
    const names = (data ?? []) as string[];
    const result = await removeObjects(admin, names);
    if (result.failed > 0) {
      return json(req, { status: 'partial', objects_deleted: result.deleted, objects_failed: result.failed });
    }
    const rows = await admin.rpc('purge_term_rows', { p_term_id: term.id });
    if (rows.error) {
      return json(req, { status: 'partial', objects_deleted: result.deleted, objects_failed: 0, db_error: dbErrorCode(rows.error) });
    }
    return json(req, { status: 'done', objects_deleted: result.deleted, rows: rows.data });
  }

  return fail(req, 'bad_request');
});
