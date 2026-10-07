// 사진 세트 실연결 읽기 전용 확인(제출을 만들지 않는다).
//  - 예전 단일 사진 제출이 submission_images로 옮겨졌는지(서버 키, 개수만)
//  - TST-TEACHER 세션으로 앱 어댑터 loadTeacherData → 제출마다 사진 세트가 붙는지
//  - anon은 submission_images를 볼 수 없는지
//  - 배포된 submit 함수가 사진 0장을 no_image로 거절하는지(DB 반영 전 단계에서 거절)
// 사용: node --env-file=.env.server scripts/verify-images-live.mjs
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBackend } from '../src/lib/backend/supabase.ts';
import { readCredentials, requireEnv, TEACHER } from './live-test-lib.mjs';

requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
const URL_ = process.env.SUPABASE_URL;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
let bad = 0;
const check = (name, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const admin = createClient(URL_, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: subs } = await admin.from('submissions').select('id, image_path, image_version');
const { data: imgs } = await admin.from('submission_images').select('submission_id, image_version, sort_order, storage_path');
const covered = (subs ?? []).filter((s) => (imgs ?? []).some((i) => i.submission_id === s.id && i.image_version === s.image_version && i.sort_order === 1 && i.storage_path === s.image_path));
check('기존 제출 전부 현재 버전 1번 사진으로 옮겨짐', subs.length > 0 && covered.length === subs.length, `submissions ${subs.length} / 사진 행 ${imgs.length}`);

const anon = createClient(URL_, PUB, { auth: { persistSession: false } });
const a = await anon.from('submission_images').select('id');
check('anon: submission_images 조회 불가', !!a.error || (a.data ?? []).length === 0);

const password = readCredentials().get(TEACHER.loginId)?.password ?? '';
const teacher = createSupabaseBackend(URL_, PUB);
await teacher.signIn(TEACHER.loginId, password);
const data = await teacher.loadTeacherData();
const withImages = data.submissions.filter((s) => s.images.length >= 1 && s.images[0].path === s.image_path);
check('교사 화면 데이터: 제출마다 사진 세트(1장 이상) 연결', data.submissions.length > 0 && withImages.length === data.submissions.length,
  data.submissions.map((s) => `${data.students.find((x) => x.id === s.student_id)?.student_no}:${s.record_date}:사진${s.images.length}장`).join(', '));
const blob = await teacher.fetchImage(data.submissions[0].images[0].path);
check('교사: 사진 세트 경로로 이미지 내려받기', blob.size > 0);
await teacher.signOut();

const form = new FormData();
form.append('student_no', '10901');
form.append('record_date', '2026-10-06');
form.append('request_id', crypto.randomUUID());
const res = await fetch(`${URL_}/functions/v1/submit`, { method: 'POST', headers: { apikey: PUB, authorization: `Bearer ${PUB}` }, body: form });
const body = await res.json().catch(() => ({}));
check('배포된 submit: 사진 0장 → no_image(반영 없음)', res.status === 400 && body.error === 'no_image', `${res.status} ${JSON.stringify(body)}`);

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과(읽기 전용)');
process.exit(bad ? 1 : 0);
