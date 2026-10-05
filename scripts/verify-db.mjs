// 최소 접근권한 확인(1~5) — 실제 Postgres 엔진(PGlite)에 마이그레이션을 적용하고
// anon / authenticated(학생·교사) / service_role 역할을 실제로 바꿔 가며 검사한다.
// 주의: Supabase의 auth·storage 스키마는 최소 대역(stub)이다. Storage API·Auth 서버·Edge Function은
// 여기서 실행되지 않으므로 실제 프로젝트에서 다시 확인해야 한다(README 참고).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/20261005000000_haru_check.sql', import.meta.url), 'utf8');

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

const U = {
  T1: '11111111-1111-4111-8111-111111111111',
  T2: '22222222-2222-4222-8222-222222222222',
  A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  M: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', // 첫 로그인 전(비밀번호 미변경)
  X: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', // 다른 반 학생
};
const C1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const C2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const SA = '5a5a5a5a-0000-4000-8000-00000000000a';
const SB = '5b5b5b5b-0000-4000-8000-00000000000b';
const SM = '5c5c5c5c-0000-4000-8000-00000000000c';
const SX = '5d5d5d5d-0000-4000-8000-00000000000d';

const db = new PGlite();
const results = [];
let group = '';

function check(name, ok, detail = '') {
  results.push({ group, name, ok: !!ok, detail });
}

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
const empty = (r) => !r.error && r.rows.length === 0;
const uuid = () => crypto.randomUUID();
const objPath = (uid, term) => `${uid}/${term}/${uuid()}.webp`;

async function putObject(path, owner, size = 120000) {
  await db.query(
    `insert into storage.objects (bucket_id, name, owner_id, metadata) values ('screenshots', $1, $2, $3)`,
    [path, owner, JSON.stringify({ size, mimetype: 'image/webp' })],
  );
}

async function confirm(uid, term, date, path, requestId, expected) {
  return as('service_role', null,
    `select public.confirm_submission($1, $2, $3, $4, $5, $6, null, null, 'image/webp', 120000) as r`,
    [uid, term, date, path, requestId, expected]);
}

// ---------------------------------------------------------------------------
await db.exec(STUB);
await db.exec(migration);

await db.exec(`
insert into auth.users (id) values ('${U.T1}'), ('${U.T2}'), ('${U.A}'), ('${U.B}'), ('${U.M}'), ('${U.X}');
insert into public.profiles (user_id, role, display_name, must_change_password) values
  ('${U.T1}', 'teacher', '교사1', false), ('${U.T2}', 'teacher', '교사2', false),
  ('${U.A}', 'student', '학생 A', false), ('${U.B}', 'student', '학생 B', false),
  ('${U.M}', 'student', '학생 M', true), ('${U.X}', 'student', '학생 X', false);
insert into public.classes (id, name) values ('${C1}', '1반'), ('${C2}', '2반');
insert into public.class_teachers values ('${C1}', '${U.T1}'), ('${C2}', '${U.T2}');
insert into public.students (id, class_id, student_no, name, user_id, login_id) values
  ('${SA}', '${C1}', '10901', '학생 A', '${U.A}', '10901'),
  ('${SB}', '${C1}', '10902', '학생 B', '${U.B}', '10902'),
  ('${SM}', '${C1}', '10903', '학생 M', '${U.M}', '10903'),
  ('${SX}', '${C2}', '20901', '학생 X', '${U.X}', '20901');
insert into public.login_aliases values ('10901', '${U.A}', 'u-aaaa@example.invalid');
`);

const { rows: [{ today }] } = await db.query(`select ((now() at time zone 'Asia/Seoul')::date)::text as today`);
const d = (n) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// 교사1이 운영 기간 생성(오늘-6 ~ 오늘+2)
const termRes = await as('authenticated', U.T1, `select public.save_term($1, null, '테스트 기간', $2, $3, 480, null, null, '') as id`, [C1, d(-6), d(2)]);
if (termRes.error) throw new Error('save_term failed: ' + termRes.error);
const TERM = termRes.rows[0].id;
const termX = await as('authenticated', U.T2, `select public.save_term($1, null, '2반 기간', $2, $3, 480, null, null, '') as id`, [C2, d(-6), d(2)]);
const TERMX = termX.rows[0].id;

// 기본 제출 데이터: A(D-6), B(D-6), X(D-6)
const pA = objPath(U.A, TERM); await putObject(pA, U.A);
const pB = objPath(U.B, TERM); await putObject(pB, U.B);
const pX = objPath(U.X, TERMX); await putObject(pX, U.X);
await confirm(U.A, TERM, d(-6), pA, uuid(), 0);
await confirm(U.B, TERM, d(-6), pB, uuid(), 0);
await confirm(U.X, TERMX, d(-6), pX, uuid(), 0);
await as('authenticated', U.T1, `insert into public.teacher_notes (term_id, student_id, body) values ($1, $2, '교사 전용 메모')`, [TERM, SB]);

// ---------------------------------------------------------------------------
group = '1) 비로그인(anon) 접근 거절';
for (const t of ['students', 'submissions', 'teacher_notes', 'profiles', 'login_aliases', 'terms', 'excuse_requests', 'exemptions']) {
  check(`public.${t} 조회`, denied(await as('anon', null, `select * from public.${t}`)));
}
check('storage 이미지 객체 조회(0행)', empty(await as('anon', null, `select name from storage.objects`)));
check('이미지 업로드(INSERT) 거절', denied(await as('anon', null,
  `insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, null)`, [objPath(U.A, TERM)])));
check('RPC server_time 실행 거절', denied(await as('anon', null, `select public.server_time()`)));
check('RPC confirm_submission 실행 거절', denied(await confirmAs('anon')));
async function confirmAs(role, uid = null) {
  return as(role, uid, `select public.confirm_submission($1, $2, $3, $4, $5, 0, null, null, 'image/webp', 1)`, [U.A, TERM, d(-5), objPath(U.A, TERM), uuid()]);
}

// ---------------------------------------------------------------------------
group = '2) 학생 A ↛ 학생 B 기록·이미지';
const aSubs = await as('authenticated', U.A, `select student_id from public.submissions`);
check('A의 제출 조회는 본인 것만', !aSubs.error && aSubs.rows.length === 1 && aSubs.rows[0].student_id === SA);
check('B 제출을 student_id로 직접 조회해도 0행', empty(await as('authenticated', U.A, `select * from public.submissions where student_id = $1`, [SB])));
check('명단 조회는 본인 행만', (await as('authenticated', U.A, `select id from public.students`)).rows?.length === 1);
check('B 이미지 객체 조회 0행', empty(await as('authenticated', U.A, `select name from storage.objects where name = $1`, [pB])));
check('A 본인 이미지 객체 조회 가능', (await as('authenticated', U.A, `select name from storage.objects where name = $1`, [pA])).rows?.length === 1);
check('B 폴더 경로로 업로드(INSERT) 거절', denied(await as('authenticated', U.A,
  `insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, $2)`, [objPath(U.B, TERM), U.A])));
check('본인 폴더 새 경로 업로드는 허용', !(await as('authenticated', U.A,
  `insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, $2)`, [objPath(U.A, TERM), U.A])).error);
let r = await as('authenticated', U.A, `update storage.objects set metadata = '{}' where name = $1`, [pA]);
check('접수된 본인 이미지 덮어쓰기(UPDATE) 불가(0행)', !r.error && r.affected === 0);
r = await as('authenticated', U.A, `delete from storage.objects where name in ($1, $2)`, [pA, pB]);
check('이미지 삭제(DELETE) 불가(0행)', !r.error && r.affected === 0);
check('제출 행 직접 수정 거절', denied(await as('authenticated', U.A, `update public.submissions set first_submitted_at = now() where student_id = $1`, [SB])));
check('제출 행 직접 삽입 거절', denied(await as('authenticated', U.A,
  `insert into public.submissions (term_id, student_id, record_date, image_path, image_mime, image_bytes, first_submitted_at, image_updated_at) values ($1, $2, $3, 'x', 'image/webp', 1, now(), now())`, [TERM, SB, d(-5)])));
check('학생이 confirm_submission 직접 호출 거절(B ID 위조 포함)', denied(await confirmAs('authenticated', U.A)));
check('다른 반 학생 X는 1반 운영 기간 조회 0행', empty(await as('authenticated', U.X, `select id from public.terms where id = $1`, [TERM])));

// ---------------------------------------------------------------------------
group = '3) 학생 ↛ 교사 메모·교사 기능';
check('교사 메모 조회 0행', empty(await as('authenticated', U.B, `select * from public.teacher_notes`)));
check('교사 메모 작성 거절', denied(await as('authenticated', U.B, `insert into public.teacher_notes (term_id, student_id, body) values ($1, $2, '위조')`, [TERM, SB])));
const subB = (await db.query(`select id, image_version from public.submissions where student_id = $1`, [SB])).rows[0];
check('review_submission 거절', /not_allowed/.test((await as('authenticated', U.B, `select public.review_submission($1, $2, 'checked', '')`, [subB.id, subB.image_version])).error ?? ''));
check('set_exemptions 거절', /not_allowed/.test((await as('authenticated', U.B, `select public.set_exemptions($1, $2, $3, $3, true, '')`, [TERM, SB, d(-5)])).error ?? ''));
check('save_term 거절', /not_allowed/.test((await as('authenticated', U.B, `select public.save_term($1, $2, 'x', $3, $4, 480, null, null, '')`, [C1, TERM, d(-6), d(2)])).error ?? ''));
check('set_day_target 거절', /not_allowed/.test((await as('authenticated', U.B, `select public.set_day_target($1, $2, false, '')`, [TERM, d(-5)])).error ?? ''));
check('resolve_excuse 거절', /not_allowed/.test((await as('authenticated', U.B, `select public.resolve_excuse(gen_random_uuid(), true)`)).error ?? ''));
r = await as('authenticated', U.B, `update public.students set name = '변경' where id = $1`, [SB]);
check('명단 수정 불가(0행)', !r.error && r.affected === 0);
r = await as('authenticated', U.B, `update public.classes set app_title = '변경'`);
check('앱 이름 수정 불가(0행)', !r.error && r.affected === 0);
check('로그인 별칭 매핑 조회 거절', denied(await as('authenticated', U.B, `select * from public.login_aliases`)));
check('다른 학생 프로필(역할) 조회 0행', empty(await as('authenticated', U.B, `select * from public.profiles where user_id <> $1`, [U.B])));
check('프로필 역할 자기 수정 거절', denied(await as('authenticated', U.B, `update public.profiles set role = 'teacher' where user_id = $1`, [U.B])));
check('비밀번호 미변경 학생 M: 제출·운영기간 조회 0행', empty(await as('authenticated', U.M, `select * from public.terms`)));
check('비밀번호 미변경 학생 M: 업로드 거절', denied(await as('authenticated', U.M,
  `insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, $2)`, [objPath(U.M, TERM), U.M])));
check('다른 반 교사2: 1반 제출 조회 0행', empty(await as('authenticated', U.T2, `select * from public.submissions where term_id = $1`, [TERM])));
check('다른 반 교사2: 1반 이미지 조회 0행', empty(await as('authenticated', U.T2, `select name from storage.objects where name = $1`, [pB])));
check('다른 반 교사2: 1반 확인 처리 거절', /not_allowed/.test((await as('authenticated', U.T2, `select public.review_submission($1, $2, 'checked', '')`, [subB.id, subB.image_version])).error ?? ''));
check('담당 교사1: 학생 B 이미지·메모 조회 가능',
  (await as('authenticated', U.T1, `select name from storage.objects where name = $1`, [pB])).rows?.length === 1
  && (await as('authenticated', U.T1, `select id from public.teacher_notes`)).rows?.length === 1);

// ---------------------------------------------------------------------------
group = '4) 교체·실패·재시도 무결성';
const D4 = d(-5);
const p1 = objPath(U.A, TERM); await putObject(p1, U.A);
const req1 = uuid();
const c1 = await confirm(U.A, TERM, D4, p1, req1, 0);
const first = c1.rows?.[0]?.r;
check('최초 제출 확정 v1', first?.version === 1 && first?.replayed === false, JSON.stringify(c1.error ?? first));
const subA = (await db.query(`select * from public.submissions where student_id = $1 and record_date = $2`, [SA, D4])).rows[0];
await as('authenticated', U.T1, `select public.review_submission($1, 1, 'checked', '')`, [subA.id]);
const replay = (await confirm(U.A, TERM, D4, p1, req1, 0)).rows?.[0]?.r;
let now1 = (await db.query(`select review_status, image_version from public.submissions where id = $1`, [subA.id])).rows[0];
check('같은 요청 재시도 → 같은 결과, 확인 상태 유지', replay?.replayed === true && replay.version === 1 && now1.review_status === 'checked' && now1.image_version === 1);

const pMissing = objPath(U.A, TERM);
check('업로드 안 된 객체로 확정 → object_missing', /object_missing/.test((await confirm(U.A, TERM, D4, pMissing, uuid(), 1)).error ?? ''));
const pSvc = objPath(U.A, TERM); await putObject(pSvc, null);
check('서버 키로 올린(소유자 없는) 객체 → object_not_owned', /object_not_owned/.test((await confirm(U.A, TERM, D4, pSvc, uuid(), 1)).error ?? ''));
const pOther = objPath(U.B, TERM); await putObject(pOther, U.B);
check('다른 학생 경로 객체 → bad_path', /bad_path/.test((await confirm(U.A, TERM, D4, pOther, uuid(), 1)).error ?? ''));
now1 = (await db.query(`select * from public.submissions where id = $1`, [subA.id])).rows[0];
check('실패 후에도 기존 정상 제출 유지', now1.image_path === p1 && now1.image_version === 1 && now1.review_status === 'checked');

const p2 = objPath(U.A, TERM); await putObject(p2, U.A);
const c2 = (await confirm(U.A, TERM, D4, p2, uuid(), 1)).rows?.[0]?.r;
const after = (await db.query(`select * from public.submissions where id = $1`, [subA.id])).rows[0];
check('교체 → v2, 확인 상태 미확인으로 초기화', c2?.version === 2 && after.review_status === 'unchecked' && after.image_path === p2);
check('교체해도 최초 접수 시각 보존', new Date(after.first_submitted_at).getTime() === new Date(subA.first_submitted_at).getTime());
check('교사가 구버전(v1)에 확인 → stale_version', /stale_version/.test((await as('authenticated', U.T1, `select public.review_submission($1, 1, 'checked', '')`, [subA.id])).error ?? ''));
const p3 = objPath(U.A, TERM); await putObject(p3, U.A);
check('오래된 재시도(expected v1) → version_conflict', /version_conflict/.test((await confirm(U.A, TERM, D4, p3, uuid(), 1)).error ?? ''));
const final4 = (await db.query(`select image_path, image_version from public.submissions where id = $1`, [subA.id])).rows[0];
check('오래된 재시도가 최신 이미지를 덮지 않음', final4.image_path === p2 && final4.image_version === 2);
check('이미 쓴 경로 재사용 거절', /path_reused/.test((await confirm(U.A, TERM, D4, p1, uuid(), 2)).error ?? ''));
check('교사 확인은 현재 버전(v2)에는 적용', !(await as('authenticated', U.T1, `select public.review_submission($1, 2, 'checked', '')`, [subA.id])).error);
const orphan = (await as('service_role', null, `select public.term_object_names($1, false) as n`, [TERM])).rows?.length ?? 0;
check('정리 대상 목록 함수(서버 키 전용) 동작', orphan >= 5);

// ---------------------------------------------------------------------------
group = '5) KST 마감 판정·면제·늦은 제출';
async function boundary(date, offsetSql) {
  const path = objPath(U.B, TERM);
  await putObject(path, U.B);
  return db.transaction(async (tx) => {
    await tx.exec(`alter table public.term_days disable trigger term_days_lock_deadline`);
    await tx.query(`update public.term_days set deadline_at = now() ${offsetSql} where term_id = $1 and record_date = $2`, [TERM, date]);
    await tx.exec(`alter table public.term_days enable trigger term_days_lock_deadline`);
    await tx.exec(`set local role service_role`);
    const res = await tx.query(`select public.confirm_submission($1, $2, $3, $4, $5, 0, null, null, 'image/webp', 1000) as r`, [U.B, TERM, date, path, uuid()]);
    return res.rows[0].r;
  });
}
check('마감 1초 전 접수 → 정시', (await boundary(d(-5), "+ interval '1 second'")).late === false);
check('마감 정각 접수(= 마감) → 정시', (await boundary(d(-4), '')).late === false);
check('마감 1ms 후 접수 → 지각', (await boundary(d(-3), "- interval '1 millisecond'")).late === true);

const deadlineOf = async (date) => (await db.query(`select deadline_at, window_open_at from public.term_days where term_id = $1 and record_date = $2`, [TERM, date])).rows[0];
const ddl = await deadlineOf(d(-2));
const expectOpen = new Date(`${d(-1)}T00:00:00+09:00`).getTime();
check('기록일 D의 제출 창 = D+1 00:00 KST, 기본 마감 D+1 08:00 KST',
  new Date(ddl.window_open_at).getTime() === expectOpen && new Date(ddl.deadline_at).getTime() === expectOpen + 8 * 3600e3);

const pToday = objPath(U.B, TERM); await putObject(pToday, U.B);
check('끝나지 않은 당일 제출 거절', /window_not_open/.test((await confirm(U.B, TERM, d(0), pToday, uuid(), 0)).error ?? ''));
check('미래 날짜 제출 거절', /window_not_open/.test((await confirm(U.B, TERM, d(1), pToday, uuid(), 0)).error ?? ''));
check('기간 밖 날짜 제출 거절', /date_out_of_range/.test((await confirm(U.B, TERM, d(-10), pToday, uuid(), 0)).error ?? ''));
await as('authenticated', U.T1, `select public.set_day_target($1, $2, false, '행사')`, [TERM, d(-2)]);
check('수집 제외일 제출 거절', /not_target_day/.test((await confirm(U.B, TERM, d(-2), pToday, uuid(), 0)).error ?? ''));
await as('authenticated', U.T1, `select public.set_day_target($1, $2, true, '')`, [TERM, d(-2)]);

// 마감 변경은 아직 열리지 않은 날짜에만
const beforeOpen = await deadlineOf(d(-1));
const beforeFuture = await deadlineOf(d(1));
const upd = await as('authenticated', U.T1, `select public.save_term($1, $2, '테스트 기간', $3, $4, 540, null, null, '')`, [C1, TERM, d(-6), d(2)]);
const afterOpen = await deadlineOf(d(-1));
const afterFuture = await deadlineOf(d(1));
check('마감 09:00으로 변경 → 이미 열린 날짜 마감 유지(소급 없음)', !upd.error && new Date(afterOpen.deadline_at).getTime() === new Date(beforeOpen.deadline_at).getTime(), upd.error ?? '');
check('마감 변경 → 아직 열리지 않은 날짜에 적용', new Date(afterFuture.deadline_at).getTime() === new Date(beforeFuture.deadline_at).getTime() + 3600e3);
let lockErr = '';
try { await db.query(`update public.term_days set deadline_at = deadline_at + interval '1 hour' where term_id = $1 and record_date = $2`, [TERM, d(-1)]); } catch (e) { lockErr = e.message; }
check('열린 날짜 마감 직접 변경도 트리거가 거절', /deadline_locked/.test(lockErr));

// 면제: 접수 이력 보존
const exN = await as('authenticated', U.T1, `select public.set_exemptions($1, $2, $3, $3, true, '체험학습') as n`, [TERM, SA, D4]);
const keep = (await db.query(`select count(*)::int as n from public.submissions where student_id = $1 and record_date = $2`, [SA, D4])).rows[0].n;
check('면제 지정해도 기존 제출 이력 보존', exN.rows?.[0]?.n === 1 && keep === 1);
// 사유 요청은 자동 면제 아님
const exc = await as('authenticated', U.B, `select public.submit_excuse($1, $2, 'device_unavailable', '수리 중') as r`, [TERM, d(-1)]);
const autoEx = (await db.query(`select count(*)::int as n from public.exemptions where student_id = $1 and record_date = $2`, [SB, d(-1)])).rows[0].n;
check('사유 전달은 면제를 만들지 않음(교사 승인 전)', !exc.error && autoEx === 0, exc.error ?? '');
const excId = (await db.query(`select id from public.excuse_requests where student_id = $1`, [SB])).rows[0].id;
await as('authenticated', U.T1, `select public.resolve_excuse($1, true)`, [excId]);
check('교사 승인 시 면제 생성', (await db.query(`select count(*)::int as n from public.exemptions where student_id = $1 and record_date = $2`, [SB, d(-1)])).rows[0].n === 1);

// ---------------------------------------------------------------------------
let failed = 0;
let last = '';
for (const x of results) {
  if (x.group !== last) { console.log(`\n${x.group}`); last = x.group; }
  console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? `  (${x.detail})` : ''}`);
  if (!x.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과 (PGlite + auth/storage 대역)`);
process.exit(failed ? 1 : 0);
