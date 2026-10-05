// Edge Function 공용 도구. 서버 키는 이 파일을 쓰는 서버 함수 안에서만 사용한다.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export const BUCKET = 'screenshots';

// 허용 출처는 명시 목록만. 값이 없으면 어떤 브라우저 출처도 허용하지 않는다('*'는 무시).
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && s !== '*');

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fail(req: Request, code: string, status = 400): Response {
  return json(req, { error: code }, status);
}

function pickKey(jsonVar: string, legacyVar: string): string {
  const raw = Deno.env.get(jsonVar);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const key = parsed.default ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      // 형식이 다르면 레거시 변수로 진행
    }
  }
  const legacy = Deno.env.get(legacyVar);
  if (!legacy) throw new Error(`missing ${jsonVar}/${legacyVar}`);
  return legacy;
}

export function supabaseUrl(): string {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('missing SUPABASE_URL');
  return url;
}

const clientOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function adminClient(): SupabaseClient {
  return createClient(supabaseUrl(), pickKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), clientOpts);
}

export function publicClient(): SupabaseClient {
  return createClient(supabaseUrl(), pickKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), clientOpts);
}

/** Authorization 헤더의 사용자 토큰을 Auth 서버로 검증한다. */
export async function requireUser(req: Request): Promise<User | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await publicClient().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function aliasDomain(): string {
  const d = Deno.env.get('ALIAS_EMAIL_DOMAIN');
  if (!d) throw new Error('missing ALIAS_EMAIL_DOMAIN');
  return d;
}

export function normalizeLoginId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return /^[0-9a-z-]{1,32}$/.test(v) ? v : null;
}

/** Postgres 예외 메시지에서 우리가 정의한 코드만 꺼낸다. */
export function dbErrorCode(error: { message?: string } | null): string {
  const msg = error?.message ?? '';
  return /^[a-z_]{3,40}$/.test(msg) ? msg : 'server_error';
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  return fwd.split(',')[0].trim() || 'unknown';
}
