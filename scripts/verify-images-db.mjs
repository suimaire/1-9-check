// 사진 세트(20261007000000_submission_images) 전용 확인 — PGlite에 기존 두 migration을 적용하고
// 예전 단일 사진 제출을 만든 뒤 새 migration을 적용해 backfill·권한·1~3장 제출·재제출·재시도·정리 대상을 검사한다.
// Storage API·Edge Function 자체는 실행하지 않는다.
// 실행: node scripts/verify-images-db.mjs
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
const T2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const C2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const S01 = '5a5a5a5a-0000-4000-8000-000000000001';
const S02 = '5a5a5a5a-0000-4000-8000-000000000002';
const S04 = '5a5a5a5a-0000-4000-8000-000000000004';

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
const err = (r) => (r.error ?? '').match(/[a-z_]{3,}/)?.[0] ?? '';

await db.exec(STUB);
await db.exec(read('20261005000000_haru_check.sql'));
await db.exec(read('20261005130000_student_no_submission.sql'));
await db.exec(`
insert into auth.users (id) values ('${T1}'), ('${T2}');
insert into public.profiles (user_id, role, display_name, must_change_password) values
  ('${T1}', 'teacher', '교사', false), ('${T2}', 'teacher', '다른 반 교사', false);
insert into public.classes (id, name, public_submit) values ('${C1}', '1학년 9반', true), ('${C2}', '다른 반', false);
insert into public.class_teachers values ('${C1}', '${T1}'), ('${C2}', '${T2}');
insert into public.students (id, class_id, student_no, name) values
  ('${S01}', '${C1}', '10901', '학생 01'), ('${S02}', '${C1}', '10902', '학생 02'), ('${S04}', '${C1}', '10904', '학생 04');
`);
const { rows: [{ today }] } = await db.query(`select ((now() at time zone 'Asia/Seoul')::date)::text as today`);
const d = (n) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const TERM = (await as('authenticated', T1, `select public.save_term($1, null, '기간', $2, $3, 480, null, null, '') as id`, [C1, d(-5), d(3)])).rows[0].id;
const D = d(-1);

async function put(studentId, ext = 'webp') {
  const name = `${studentId}/${TERM}/${uuid()}.${ext}`;
  await db.query(`insert into storage.objects (bucket_id, name, owner_id) values ('screenshots', $1, null)`, [name]);
  return name;
}
const img = (path, mime = 'image/webp', bytes = 1000) => ({ path, mime, bytes });
async function legacySubmit(no, date, req, path) {
  const r = await as('service_role', null,
    `select public.public_submit($1, $2, $3, null, $4, $5, 'image/webp', 1000, null, null) as r`,
    [no, date, req, sha(token()), path ?? null]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
async function submit(no, date, req, tok, images, newHash = sha(token())) {
  const r = await as('service_role', null,
    `select public.public_submit_images($1, $2, $3, $4, $5, $6::jsonb, null, null) as r`,
    [no, date, req, tok ? sha(tok) : null, newHash, images === undefined || images === null ? null : JSON.stringify(images)]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
const counts = async () => (await db.query(`select
  (select count(*) from public.submissions)::int s,
  (select count(*) from public.submission_events)::int e,
  (select count(*) from public.submission_images)::int i`)).rows[0];
const subOf = async (sid) => (await db.query(`select * from public.submissions where student_id = $1 and record_date = $2`, [sid, D])).rows[0];
const imagesOf = async (subId, version) => (await db.query(
  `select sort_order, storage_path from public.submission_images where submission_id = $1 and image_version = $2 order by sort_order`, [subId, version])).rows;

// ── 예전 단일 사진 제출(새 migration 전) ──
const legacyPath = await put(S02);
await legacySubmit('10902', D, uuid());
const legacy = await legacySubmit('10902', D, uuid(), legacyPath);
check('migration 전: 예전 단일 사진 제출 생성', legacy.version === 1, JSON.stringify(legacy));

await db.exec(read('20261007000000_submission_images.sql'));
const legacyRow = await subOf(S02);
const legacyImgs = await imagesOf(legacyRow.id, 1);
check('backfill: 예전 제출 → 1번 사진 1행', legacyImgs.length === 1 && legacyImgs[0].storage_path === legacyPath && legacyImgs[0].sort_order === 1);
check('backfill: 예전 컬럼(image_path) 보존', legacyRow.image_path === legacyPath);

// ── 권한 ──
check('anon: submission_images SELECT 거절', denied(await as('anon', null, `select id from public.submission_images`)));
check('anon: submission_images INSERT 거절', denied(await as('anon', null,
  `insert into public.submission_images (submission_id, image_version, sort_order, storage_path, image_mime, image_bytes) values ($1, 1, 2, 'x', 'image/webp', 1)`, [legacyRow.id])));
check('anon: public_submit_images 실행 거절', denied(await as('anon', null,
  `select public.public_submit_images('10901', $1, $2, null, $3, null, null, null)`, [D, uuid(), sha('x')])));
check('교사(authenticated): public_submit_images 실행 거절', denied(await as('authenticated', T1,
  `select public.public_submit_images('10901', $1, $2, null, $3, null, null, null)`, [D, uuid(), sha('x')])));
check('담당 교사: 사진 목록 조회 가능', (await as('authenticated', T1, `select storage_path from public.submission_images`)).rows?.length === 1);
check('다른 반 교사: 사진 목록 0행', (await as('authenticated', T2, `select storage_path from public.submission_images`)).rows?.length === 0);
check('교사: 사진 행 INSERT 거절', denied(await as('authenticated', T1,
  `insert into public.submission_images (submission_id, image_version, sort_order, storage_path, image_mime, image_bytes) values ($1, 1, 2, 'y', 'image/webp', 1)`, [legacyRow.id])));
check('교사: 사진 행 DELETE 불가', ((r) => denied(r) || r.affected === 0)(await as('authenticated', T1, `delete from public.submission_images`)));
check('교사: 사진 목록 + 제출 term_id 조인 조회(화면 쿼리 형태)', (await as('authenticated', T1,
  `select i.storage_path from public.submission_images i join public.submissions s on s.id = i.submission_id where s.term_id = $1`, [TERM])).rows?.length === 1);

// ── 1~3장 검증(하나라도 틀리면 아무것도 반영하지 않음) ──
const before = await counts();
const a = await put(S01), b = await put(S01), c = await put(S01), e4 = await put(S01);
check('0장 → no_image', err(await submit('10901', D, uuid(), null, [])) === 'no_image');
check('4장 → too_many_images', err(await submit('10901', D, uuid(), null, [img(a), img(b), img(c), img(e4)])) === 'too_many_images');
check('배열 아님 → bad_request', err(await submit('10901', D, uuid(), null, { path: a })) === 'bad_request');
check('허용 외 MIME → bad_type', err(await submit('10901', D, uuid(), null, [img(a), img(b, 'image/gif')])) === 'bad_type');
check('2MB 초과 → too_large', err(await submit('10901', D, uuid(), null, [img(a), img(b, 'image/webp', 2097153)])) === 'too_large');
check('확장자·MIME 불일치 경로 → bad_path', err(await submit('10901', D, uuid(), null, [img(a, 'image/png')])) === 'bad_path');
check('같은 경로 중복 → bad_path', err(await submit('10901', D, uuid(), null, [img(a), img(a)])) === 'bad_path');
check('다른 학생 경로 섞임 → bad_path', err(await submit('10901', D, uuid(), null, [img(a), img(await put(S04))])) === 'bad_path');
check('3장 중 1장 업로드 안 됨 → object_missing', err(await submit('10901', D, uuid(), null, [img(a), img(b), img(`${S01}/${TERM}/${uuid()}.webp`)])) === 'object_missing');
check('이미 쓴(예전) 경로 재사용 → path_reused', err(await submit('10902', D, uuid(), null, [img(legacyPath)])) === 'path_reused');
const mid = await counts();
check('실패한 요청은 submission·사진·이벤트를 하나도 만들지 않음', mid.s === before.s && mid.e === before.e && mid.i === before.i);

// ── 첫 제출(2장) + 재시도 ──
const req1 = uuid();
const pre = await submit('10901', D, req1, null, null);
check('사전 확인 → ready, 쓰기 없음', pre.ready === true && pre.student_id === S01 && (await counts()).s === mid.s);
const first = await submit('10901', D, req1, null, [img(a), img(b)]);
const row1 = await subOf(S01);
const imgs1 = await imagesOf(row1.id, 1);
check('첫 제출 2장 → v1, image_count 2, token 발급', first.version === 1 && first.image_count === 2 && first.token_issued === true, JSON.stringify(first));
check('사진 순서 = 배열 순서(1:a, 2:b)', imgs1.map((x) => x.storage_path).join() === [a, b].join() && imgs1.map((x) => x.sort_order).join() === '1,2');
check('호환 컬럼 image_path = 1번 사진', row1.image_path === a);
const c1 = await counts();
const replay = await submit('10901', D, req1, null, null);
const replay2 = await submit('10901', D, req1, null, [img(c)]); // 응답 유실 후 같은 request_id로 새 업로드가 와도 반영하지 않음
const c2 = await counts();
const row1b = await subOf(S01);
check('같은 request_id 재시도 → replayed, 사진·제출·이벤트 중복 없음', replay.replayed === true && replay2.replayed === true && c1.s === c2.s && c1.i === c2.i && c1.e === c2.e);
check('재시도에도 버전·최초 접수 시각 유지', row1b.image_version === 1 && +new Date(row1b.first_submitted_at) === +new Date(row1.first_submitted_at));

// ── token 재제출(3장 세트로 전체 교체) ──
check('token 없이 덮어쓰기 거절', err(await submit('10901', D, uuid(), null, [img(c)])) === 'already_submitted');
const tok = token();
await db.query(`update public.submissions set replacement_token_hash = $1, review_status = 'checked', reviewed_version = 1 where id = $2`, [sha(tok), row1.id]);
const x1 = await put(S01), x2 = await put(S01, 'png'), x3 = await put(S01, 'jpg');
const req2 = uuid();
const rep = await submit('10901', D, req2, tok, [img(x1), img(x2, 'image/png'), img(x3, 'image/jpeg')]);
const row2 = await subOf(S01);
check('교체 → v2, 3장, replaced', rep.version === 2 && rep.replaced === true && rep.image_count === 3 && (await imagesOf(row1.id, 2)).length === 3, JSON.stringify(rep));
check('교체 → first_submitted_at·정시/지각 판정 유지', +new Date(row2.first_submitted_at) === +new Date(row1.first_submitted_at) && rep.late === first.late);
check('교체 → 교사 확인 미확인으로', row2.review_status === 'unchecked' && row2.reviewed_version === null);
check('교체 → 이전 버전 사진 행은 이력으로 남음(v1 2장)', (await imagesOf(row1.id, 1)).length === 2);
const c3 = await counts();
check('교체 재시도 → 중복 없음', (await submit('10901', D, req2, tok, null)).version === 2 && (await counts()).i === c3.i && (await counts()).e === c3.e);

// ── 담임 재제출 허용(다른 기기, 1장) ──
check('교사: 재제출 허용', !(await as('authenticated', T1, `select public.allow_resubmission($1, true)`, [row1.id])).error);
const y1 = await put(S01);
const open = await submit('10901', D, uuid(), null, [img(y1)]);
const row3 = await subOf(S01);
check('허용 후 token 없이 교체 → v3 1장 + 새 token, 허용 자동 해제', open.version === 3 && open.image_count === 1 && open.token_issued === true && row3.resubmit_open === false);
check('이전 token은 무효', err(await submit('10901', D, uuid(), tok, [img(await put(S01))])) === 'already_submitted');

// ── 예전 단일 사진 계약(public_submit)도 사진 행을 만든다 ──
const z = await put(S04);
await legacySubmit('10904', D, uuid());
const viaOld = await legacySubmit('10904', D, uuid(), z);
const row4 = await subOf(S04);
check('예전 public_submit 호출 → 1장 세트로 저장', viaOld.version === 1 && (await imagesOf(row4.id, 1)).map((x) => x.storage_path).join() === z);

// ── 정리 대상(고아 객체) ──
await db.query(`update storage.objects set created_at = now() - interval '2 hours'`);
const orphans = new Set((await as('service_role', null, `select public.term_object_names($1, true) as n`, [TERM])).rows.map((r) => r.n));
check('현재 버전 사진(2·3번 포함)은 정리 대상 아님', !orphans.has(y1) && !orphans.has(z) && !orphans.has(legacyPath));
check('이전 버전 사진은 정리 대상', [a, b, x1, x2, x3].every((p) => orphans.has(p)));

let failed = 0;
for (const x of results) {
  console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? `  (${x.detail})` : ''}`);
  if (!x.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과 (PGlite, 사진 세트)`);
process.exit(failed ? 1 : 0);
