// 발급 ID → Supabase Auth 이메일 별칭 변환.
// - 존재하지 않는 ID에도 같은 형태의 별칭(HMAC)을 돌려주므로 응답으로 존재 여부를 알 수 없다.
// - 비밀번호는 받지 않는다. 브라우저가 별칭으로 signInWithPassword를 직접 호출하므로
//   Supabase Auth의 IP별 로그인 제한이 학생 각자에게 적용된다.
// - 별칭은 본인 세션에서도 보이는 값이라 비밀이 아니다. 전체 매핑 목록은 어디에도 공개하지 않는다.
import {
  adminClient,
  aliasDomain,
  clientIp,
  corsHeaders,
  fail,
  json,
  normalizeLoginId,
  readJson,
} from '../_shared/util.ts';

async function fakeAlias(loginId: string): Promise<string> {
  const secret = Deno.env.get('LOGIN_ALIAS_PEPPER');
  if (!secret) throw new Error('missing LOGIN_ALIAS_PEPPER');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(loginId)));
  const hex = Array.from(sig.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
  return `u-${hex}@${aliasDomain()}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405);

  const body = await readJson(req);
  const loginId = normalizeLoginId(body?.login_id);
  if (!loginId) return fail(req, 'invalid_credentials', 400);

  const admin = adminClient();
  const [byId, byIp] = await Promise.all([
    admin.rpc('login_rate_check', { p_key: `id:${loginId}`, p_max: 10, p_window_seconds: 900 }),
    admin.rpc('login_rate_check', { p_key: `ip:${clientIp(req)}`, p_max: 60, p_window_seconds: 900 }),
  ]);
  if (byId.error || byIp.error) return fail(req, 'server_error', 500);
  if (byId.data === false || byIp.data === false) return fail(req, 'too_many_attempts', 429);

  const { data, error } = await admin.from('login_aliases').select('auth_email').eq('login_id', loginId).maybeSingle();
  if (error) return fail(req, 'server_error', 500);
  const email = data?.auth_email ?? (await fakeAlias(loginId));
  return json(req, { email });
});
