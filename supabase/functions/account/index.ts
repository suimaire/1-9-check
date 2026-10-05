// 본인 계정: 최초 로그인 비밀번호 변경.
// 현재 비밀번호를 Auth로 다시 확인한 뒤 서버 키로 변경하고 must_change_password를 해제한다.
// (클라이언트가 플래그만 풀 수 있는 경로는 없다.)
import { adminClient, corsHeaders, fail, json, publicClient, readJson, requireUser } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405);

  const user = await requireUser(req);
  if (!user || !user.email) return fail(req, 'unauthorized', 401);

  const body = await readJson(req);
  if (body?.action !== 'change_password') return fail(req, 'bad_request');
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';

  if (next.length < 8 || next.length > 72) return fail(req, 'weak_password');
  if (next === current) return fail(req, 'same_password');
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return fail(req, 'weak_password');

  const check = await publicClient().auth.signInWithPassword({ email: user.email, password: current });
  if (check.error || check.data.user?.id !== user.id) return fail(req, 'wrong_password', 400);

  const admin = adminClient();
  const { data: profile } = await admin.from('profiles').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!profile) return fail(req, 'not_allowed', 403);

  const upd = await admin.auth.admin.updateUserById(user.id, { password: next });
  if (upd.error) return fail(req, 'weak_password');

  const { error } = await admin.from('profiles').update({ must_change_password: false }).eq('user_id', user.id);
  if (error) return fail(req, 'server_error', 500);
  return json(req, { ok: true });
});
