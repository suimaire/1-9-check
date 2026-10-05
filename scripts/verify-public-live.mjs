// 실제 Supabase 대상 학번 제출 최소 확인(합성 이미지 전용, 실제 학생 자료 없음).
//  - 학생 제출은 앱 어댑터(src/lib/backend/supabase.ts)의 publicSubmit 그대로 → 공개 submit 함수
//  - anon 직접 접근은 publishable key만 가진 클라이언트로 확인
//  - 교사 확인은 TST-TEACHER 세션(자격 증명은 verification.local/.../TEST_CREDENTIALS.txt, 출력하지 않음)
// 사용: node --env-file=.env.server scripts/verify-public-live.mjs [--student 10901] [--date YYYY-MM-DD]
// 같은 학번·날짜로 다시 돌리면 첫 제출 대신 '이미 제출됨'부터 확인한다(기존 TEST 제출을 지우지 않음).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBackend } from '../src/lib/backend/supabase.ts';
import { BackendError } from '../src/lib/backend/types.ts';
import { readCredentials, requireEnv, ROOT, TEACHER } from './live-test-lib.mjs';

requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
const URL_ = process.env.SUPABASE_URL;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const { values: args } = parseArgs({ options: { student: { type: 'string', default: '10901' }, date: { type: 'string' } } });
const NO = args.student;

let ok = 0;
let bad = 0;
function check(name, pass, detail = '') {
  pass ? ok++ : bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const code = async (p) => {
  try { await p; return 'ok'; } catch (e) { return e instanceof BackendError ? e.code : String(e?.message ?? e); }
};

function png(seed) {
  const w = 360, h = 240;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3;
    const on = y > h - 20 - ((Math.floor(x / 40) * 37 + seed * 53) % (h - 40));
    raw[i] = on ? 31 : 245; raw[i + 1] = on ? 95 + seed * 20 : 245; raw[i + 2] = on ? 168 : 248;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])], { type: 'image/png' });
}

const student = createSupabaseBackend(URL_, PUB); // 로그인하지 않은 공개 화면과 같은 상태
const info = await student.publicInfo();
const DATE = args.date ?? info.open_days?.[0]?.record_date;
check('공개 일정 조회(submit info) — 학생 이름 없음', info.ready && !!DATE && !JSON.stringify(info).includes('학생 0'), `기록일 ${DATE}`);
const input = (o) => ({ studentNo: NO, recordDate: DATE, blob: png(1), mime: 'image/png', requestId: crypto.randomUUID(), token: null, selfMinutes: null, note: null, ...o });

// C) 범위 밖 학번
check('C 10935 → 서버 거절', (await code(student.publicSubmit(input({ studentNo: '10935' })))) === 'invalid_student_no');
check('C 10900 → 서버 거절', (await code(student.publicSubmit(input({ studentNo: '10900' })))) === 'invalid_student_no');

// A) 첫 제출 + 재시도(같은 request_id)
let token = null;
const req1 = crypto.randomUUID();
const firstTry = await student.publicSubmit(input({ requestId: req1 })).catch((e) => e);
if (firstTry instanceof BackendError && firstTry.code === 'already_submitted') {
  console.log(`(참고) ${NO} ${DATE}는 이미 제출돼 있어 첫 제출 확인을 건너뜀`);
} else {
  check(`A ${NO} 첫 제출 성공`, !(firstTry instanceof Error) && firstTry.version === 1 && !firstTry.replayed, firstTry instanceof Error ? firstTry.message : `${firstTry.late ? '지각' : '정시'} 접수`);
  check('A replacement token 발급(응답으로만)', /^[0-9a-f]{64}$/.test(firstTry.replacement_token ?? ''));
  const replay = await student.publicSubmit(input({ requestId: req1 }));
  check('A 같은 요청 재시도 → replayed, 같은 접수 시각', replay.replayed && replay.first_submitted_at === firstTry.first_submitted_at);
  token = replay.replacement_token ?? firstTry.replacement_token; // 재시도는 token을 새로 발급
}

// F) token 없이 / 틀린 token으로 덮어쓰기
check('F token 없이 같은 날짜 덮어쓰기 거절', (await code(student.publicSubmit(input({ blob: png(2) })))) === 'already_submitted');
check('F 틀린 token 거절', (await code(student.publicSubmit(input({ blob: png(2), token: 'f'.repeat(64) })))) === 'already_submitted');

// B·H) 교사 Auth·대시보드
const teacher = createSupabaseBackend(URL_, PUB);
await teacher.signIn(TEACHER.loginId, readCredentials().get(TEACHER.loginId)?.password ?? '');
const me = await teacher.getMe();
check('H 교사 로그인 → role=teacher', me?.role === 'teacher' && !me.mustChangePassword);
let t = await teacher.loadTeacherData();
const s = t.students.find((x) => x.student_no === NO);
const sub = t.submissions.find((x) => x.student_id === s?.id && x.record_date === DATE);
check('H 교사 대시보드 자료(활성 34명)', t.students.filter((x) => x.active).length === 34, `${t.klass.name} · ${t.term?.name}`);
check(`B 교사 화면에 ${NO} 제출 반영`, !!sub, sub ? `v${sub.image_version}` : '');
const img = sub ? await teacher.fetchImage(sub.image_path).catch(() => null) : null;
check('B 교사 세션으로 비공개 이미지 열람', !!img && img.size > 0);

// G) 올바른 token으로 교체
if (token && sub) {
  await teacher.reviewSubmission(sub.id, sub.image_version, 'checked', '');
  const rep = await student.publicSubmit(input({ blob: png(3), token }));
  t = await teacher.loadTeacherData();
  const after = t.submissions.find((x) => x.id === sub.id);
  check('G 올바른 token 교체 성공', rep.replaced && rep.version === sub.image_version + 1);
  check('G first_submitted_at 보존', Date.parse(after.first_submitted_at) === Date.parse(sub.first_submitted_at));
  check('G version 증가', after.image_version === sub.image_version + 1);
  check('G 교사 확인 → 미확인 초기화', after.review_status === 'unchecked');
} else {
  console.log('(참고) 이번 실행에서 발급된 token이 없어 G는 건너뜀 — 새 학번/날짜로 다시 실행');
}

// D) anon DB 직접 접근
const anon = createClient(URL_, PUB, { auth: { persistSession: false } });
const blocked = (r) => !!r.error || (Array.isArray(r.data) && r.data.length === 0);
for (const tb of ['submissions', 'students', 'submission_events', 'classes', 'terms']) {
  check(`D anon ${tb} SELECT 차단`, blocked(await anon.from(tb).select('*').limit(1)));
}
check('D anon submissions INSERT 차단', !!(await anon.from('submissions').insert({ record_date: DATE, image_path: 'x' })).error);
check('D anon public_submit RPC 차단', !!(await anon.rpc('public_submit', {})).error);
check('D anon public_info RPC 차단', !!(await anon.rpc('public_info')).error);
// 교사 세션도 token hash는 못 읽음
const traw = createClient(URL_, PUB, { auth: { persistSession: false } });
await traw.auth.signInWithPassword({ email: (await traw.functions.invoke('login-resolve', { body: { login_id: TEACHER.loginId } })).data.email, password: readCredentials().get(TEACHER.loginId).password });
check('교사 세션 replacement_token_hash 조회 차단', !!(await traw.from('submissions').select('replacement_token_hash').limit(1)).error);

// E) anon Storage 직접 접근
const path = sub?.image_path ?? `${s?.id}/${t.term?.id}/x.png`;
check('E anon 이미지 다운로드 차단', !!(await anon.storage.from('screenshots').download(path)).error);
const list = await anon.storage.from('screenshots').list(path.split('/')[0]);
check('E anon 목록 조회 0건', !!list.error || (list.data ?? []).length === 0);
check('E anon 업로드 차단', !!(await anon.storage.from('screenshots').upload(`${s?.id}/${t.term?.id}/${crypto.randomUUID()}.png`, png(4), { contentType: 'image/png' })).error);
check('E anon 공개 URL 접근 차단', (await fetch(anon.storage.from('screenshots').getPublicUrl(path).data.publicUrl)).status >= 400);

// 빌드 산출물에 비밀 키 없음
const dist = join(ROOT, 'dist', 'assets');
if (existsSync(dist)) {
  const js = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
  check('I 빌드 번들에 secret key 없음', !js.includes(process.env.SUPABASE_SECRET_KEY) && !/sb_secret_[A-Za-z0-9_-]{16,}/.test(js));
}

await teacher.signOut();
console.log(`\n${ok}/${ok + bad} 통과`);
process.exit(bad ? 1 : 0);
