// 학번 제출(20261005130000) 전용 확인 — PGlite에 두 migration을 차례로 적용하고
// anon / 예전 학생 세션 / 교사 / service_role(공개 Edge Function이 쓰는 역할)로 검사한다.
// Storage API·Edge Function 자체는 실행하지 않는다(실연결은 verify-public-live.mjs).
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const read = (f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8');

const STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner_id text, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

const T1 = '11111111-1111-4111-8111-111111111111';
const OLD_STUDENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const S01 = '5a5a5a5a-0000-4000-8000-000000000001';
const S02 = '5a5a5a5a-0000-4000-8000-000000000002';
const S03 = '5a5a5a5a-0000-4000-8000-000000000003';

const db = new PGlite();
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

async function as(role, uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}
const denied = (r) => !!r.error;
const uuid = () => crypto.randomUUID();
const token = () => randomBytes(32).toString('hex');
const sha = (t) => createHash('sha256').update(t).digest('hex');

await db.exec(STUB);
await db.exec(read('20261005000000_haru_check.sql'));
await db.exec(read('20261005130000_student_no_submission.sql'));
await db.exec(`
insert into auth.users (id) values ('${T1}'), ('${OLD_STUDENT}');
insert into public.profiles (user_id, role, display_name, must_change_password) values
  ('${T1}', 'teacher', '교사', false), ('${OLD_STUDENT}', 'student', '예전 학생 계정', false);
insert into public.classes (id, name, public_submit) values ('${C1}', '1학년 9반', true);
insert into public.class_teachers values ('${C1}', '${T1}');
insert into public.students (id, class_id, student_no, name, user_id) values
  ('${S01}', '${C1}', '10901', '학생 01', '${OLD_STUDENT}'),
  ('${S02}', '${C1}', '10902', '학생 02', null),
  ('${S03}', '${C1}', '10903', '학생 03', null);
update public.students set active = false where id = '${S03}';
`);
const { rows: [{ today }] } = await db.query(`select ((now() at time zone 'Asia/Seoul')::date)::text as today`);
const d = (n) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const TERM = (await as('authenticated', T1, `select public.save_term($1, null, '기간', $2, $3, 480, null, null, '') as id`, [C1, d(-5), d(3)])).rows[0].id;
const D = d(-1);

async function put(studentId) {
  const name = `${studentId}/${TERM}/${uuid()}.webp`;
  await db.query(`insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, null)`, [name]);
  return name;
}
/** 공개 Edge Function과 같은 두 단계 호출(사전 확인 → 업로드 → 반영) */
async function submit(no, date, req, tok, path) {
  const r = await as('service_role', null,
    `select public.public_submit($1, $2, $3, $4, $5, $6, 'image/webp', 1000, null, null) as r`,
    [no, date, req, tok ? sha(tok) : null, sha(token()), path ?? null]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
const err = (r) => (r.error ?? '').match(/[a-z_]{3,}/)?.[0] ?? '';
const subRow = async () => (await db.query(`select * from public.submissions where student_id = $1 and record_date = $2`, [S01, D])).rows[0];
const counts = async () => (await db.query(`select (select count(*) from public.submissions)::int s, (select count(*) from public.submission_events)::int e`)).rows[0];

// ── anon ──
check('anon: submissions SELECT 거절', denied(await as('anon', null, `select id from public.submissions`)));
check('anon: submissions INSERT 거절', denied(await as('anon', null,
  `insert into public.submissions (term_id, student_id, record_date, image_path, image_mime, image_bytes, first_submitted_at, image_updated_at) values ($1, $2, $3, 'x', 'image/webp', 1, now(), now())`, [TERM, S01, D])));
check('anon: students SELECT 거절', denied(await as('anon', null, `select id from public.students`)));
check('anon: public_submit 직접 실행 거절', denied(await as('anon', null, `select public.public_submit('10901', $1, $2, null, $3, null, null, null, null, null)`, [D, uuid(), sha('x')])));
check('anon: public_info 직접 실행 거절', denied(await as('anon', null, `select public.public_info()`)));
check('anon: Storage 업로드 거절', denied(await as('anon', null, `insert into storage.objects (bucket_id, name) values ('screenshots', $1)`, [`${S01}/${TERM}/${uuid()}.webp`])));

// ── 학번 검증 ──
check('10935 거절(invalid_student_no)', err(await submit('10935', D, uuid())) === 'invalid_student_no');
check('10900 거절', err(await submit('10900', D, uuid())) === 'invalid_student_no');
check("'109' 접두만 같은 값(1090a) 거절", err(await submit('1090a', D, uuid())) === 'invalid_student_no');
check('비활성 10903 거절', err(await submit('10903', D, uuid())) === 'invalid_student_no');
check('명단에 없는 10904 거절', err(await submit('10904', D, uuid())) === 'invalid_student_no');
check('끝나지 않은 오늘 날짜 거절', err(await submit('10901', d(0), uuid())) === 'window_not_open');
check('기간 밖 날짜 거절', err(await submit('10901', d(-20), uuid())) === 'date_out_of_range');
check('업로드되지 않은 객체로 반영 거절', err(await submit('10901', D, uuid(), null, `${S01}/${TERM}/${uuid()}.webp`)) === 'object_missing');
check('다른 학생 경로로 반영 거절', err(await submit('10901', D, uuid(), null, await put(S02))) === 'bad_path');

// ── 첫 제출 + 재시도 ──
const req1 = uuid();
const pre = await submit('10901', D, req1);
check('사전 확인 → ready, 아무것도 쓰지 않음', pre.ready === true && pre.student_id === S01 && (await counts()).s === 0, JSON.stringify(pre));
const p1 = await put(S01);
const first = await submit('10901', D, req1, null, p1);
const row1 = await subRow();
check('첫 제출 v1 + token 발급 + hash만 저장', first.version === 1 && first.token_issued === true && /^[0-9a-f]{64}$/.test(row1.replacement_token_hash), JSON.stringify(first));
const before = await counts();
const replay = await submit('10901', D, req1);
const row1b = await subRow();
const after = await counts();
check('같은 요청 재시도 → replayed, 행·이벤트 중복 없음', replay.replayed === true && replay.version === 1 && before.s === after.s && before.e === after.e);
check('재시도에도 최초 접수 시각 유지', new Date(row1b.first_submitted_at).getTime() === new Date(row1.first_submitted_at).getTime());
check('응답 유실 대비: token 발급 요청의 재시도는 token 재발급', replay.token_issued === true && row1b.replacement_token_hash !== row1.replacement_token_hash);

// ── 덮어쓰기 보호 ──
check('token 없이 같은 날짜 덮어쓰기 거절', err(await submit('10901', D, uuid())) === 'already_submitted');
check('틀린 token으로 덮어쓰기 거절', err(await submit('10901', D, uuid(), token())) === 'already_submitted');

// 현재 유효한 token(재시도에서 새로 발급된 것)을 알아내기 위해 직접 hash를 맞춘 token으로 교체한다
const tok = token();
await db.query(`update public.submissions set replacement_token_hash = $1, review_status = 'checked', reviewed_version = 1 where id = $2`, [sha(tok), row1.id]);
const req2 = uuid();
const pre2 = await submit('10901', D, req2, tok);
const p2 = await put(S01);
const rep = await submit('10901', D, req2, tok, p2);
const row2 = await subRow();
check('올바른 token 교체 → 사전 확인 통과(replace)', pre2.ready === true && pre2.replace === true);
check('교체 → version 2, 새 이미지', rep.version === 2 && rep.replaced === true && row2.image_path === p2);
check('교체 → first_submitted_at 보존', new Date(row2.first_submitted_at).getTime() === new Date(row1.first_submitted_at).getTime());
check('교체 → 교사 확인 미확인으로 초기화', row2.review_status === 'unchecked' && row2.reviewed_version === null);
check('token 교체는 token을 새로 발급하지 않음', rep.token_issued === false && row2.replacement_token_hash === sha(tok));
check('교체 요청 재시도 → replayed v2, 중복 없음', (await submit('10901', D, req2, tok)).version === 2 && (await counts()).e === after.e + 1);

// ── 담임 재제출 허용 ──
check('교사: token hash 컬럼 조회 거절', denied(await as('authenticated', T1, `select replacement_token_hash from public.submissions`)));
check('교사: 일반 컬럼 조회 가능', (await as('authenticated', T1, `select id, resubmit_open from public.submissions`)).rows?.length === 1);
check('예전 학생 세션: 제출 0행', (await as('authenticated', OLD_STUDENT, `select id from public.submissions`)).rows?.length === 0);
check('예전 학생 세션: 재제출 허용 거절', /not_allowed/.test((await as('authenticated', OLD_STUDENT, `select public.allow_resubmission($1, true)`, [row1.id])).error ?? ''));
check('교사: 재제출 허용', !(await as('authenticated', T1, `select public.allow_resubmission($1, true)`, [row1.id])).error);
const req3 = uuid();
await submit('10901', D, req3);
const p3 = await put(S01);
const open = await submit('10901', D, req3, null, p3);
const row3 = await subRow();
check('허용 후 다른 기기(token 없음) 교체 → v3 + 새 token, 허용 자동 해제', open.version === 3 && open.token_issued === true && row3.resubmit_open === false && row3.replacement_token_hash !== sha(tok));
check('허용 해제 후 이전 token은 무효', err(await submit('10901', D, uuid(), tok)) === 'already_submitted');

let failed = 0;
for (const x of results) {
  console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? `  (${x.detail})` : ''}`);
  if (!x.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과 (PGlite, 학번 제출)`);
process.exit(failed ? 1 : 0);
