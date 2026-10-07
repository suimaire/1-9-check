// 공개 학번 제출(학생 로그인 없음). verify_jwt=false로 배포하며, 그 자체는 보안 장치가 아니다.
// 모든 검증은 여기와 DB 함수 public_submit_images()에서 한다. 학생 브라우저는 DB·Storage에 직접 쓰지 않는다.
//
// POST application/json {action:'info'}  → 제출 일정(학생 이름·제출 현황 없음)
// POST multipart/form-data               → 제출
//   student_no, record_date, request_id(재시도에도 같은 값), replacement_token(선택), self_minutes(선택), note(선택),
//   files(1~3개, 같은 key 반복 · 순서 = 사진 순서). 예전 화면이 보내는 단일 file도 1장으로 받는다.
//
// 하루 기록 1개 = 사진 세트 1개. request_id·replacement token·버전은 사진 세트 전체에 적용된다.
// 순서: 입력·파일 전부 검증 → DB 사전 확인(재시도면 바로 결과) → Storage 업로드(서버 키, 전부)
//       → DB 한 번에 반영. 업로드·반영 중 하나라도 실패하면 이번에 올린 객체를 모두 지운다(부분 제출 없음).
// replacement token 원문은 응답으로만 돌려주고, DB에는 SHA-256 hash만 넘긴다.
import {
  adminClient,
  BUCKET,
  clientIp,
  corsHeaders,
  dbErrorCode,
  fail,
  json,
  readJson,
  randomHex,
} from '../_shared/util.ts';
import { checkFiles, EXT, MAX_BYTES, MAX_FILES } from './files.ts';

const MAX_BODY = MAX_FILES * MAX_BYTES + 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

// 허용 학번: 정확히 10901~10934 (34개)
const STUDENT_NOS = new Set(Array.from({ length: 34 }, (_, i) => `109${String(i + 1).padStart(2, '0')}`));

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

const STATUS: Record<string, number> = {
  invalid_student_no: 400, bad_request: 400, bad_type: 400, too_large: 413, no_image: 400, too_many_images: 400, bad_minutes: 400, note_too_long: 400,
  date_out_of_range: 409, not_target_day: 409, not_on_roster: 409, window_not_open: 409, window_closed: 409,
  already_submitted: 409, not_allowed: 409, too_many_attempts: 429,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405);

  const admin = adminClient();
  const type = req.headers.get('content-type') ?? '';

  if (type.startsWith('application/json')) {
    const b = await readJson(req);
    if (b?.action !== 'info') return fail(req, 'bad_request');
    const { data, error } = await admin.rpc('public_info');
    if (error) return fail(req, 'server_error', 500);
    return json(req, data);
  }

  if (!type.startsWith('multipart/form-data')) return fail(req, 'bad_request');
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY) return fail(req, 'too_large', 413);

  // 같은 IP(학교 와이파이 포함)에서 15분에 120회까지
  const limit = await admin.rpc('login_rate_check', { p_key: `submit-ip:${clientIp(req)}`, p_max: 120, p_window_seconds: 900 });
  if (limit.error) return fail(req, 'server_error', 500);
  if (limit.data === false) return fail(req, 'too_many_attempts', 429);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(req, 'bad_request');
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };
  const studentNo = str('student_no');
  const recordDate = str('record_date');
  const requestId = str('request_id').toLowerCase();
  const token = str('replacement_token').toLowerCase();
  const minutesRaw = str('self_minutes');
  const note = str('note');
  let files = form.getAll('files');
  if (files.length === 0) files = form.getAll('file');

  if (!STUDENT_NOS.has(studentNo)) return fail(req, 'invalid_student_no');
  if (!validDate(recordDate) || !UUID.test(requestId)) return fail(req, 'bad_request');
  if (token && !TOKEN.test(token)) return fail(req, 'bad_request');
  const minutes = minutesRaw === '' ? null : Number(minutesRaw);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) return fail(req, 'bad_minutes');
  if (note.length > 100) return fail(req, 'note_too_long');

  // 사진마다 크기·확장자·MIME·파일 서명을 모두 확인한 뒤에만 업로드한다(하나라도 틀리면 전체 거절)
  const checked = await checkFiles(files);
  if (!checked.ok) return fail(req, checked.code, checked.status);
  const images = checked.images;

  const tokenHash = token ? await sha256Hex(token) : null;
  const newToken = randomHex(32);
  const newTokenHash = await sha256Hex(newToken);
  const base = {
    p_student_no: studentNo, p_record_date: recordDate, p_request_id: requestId,
    p_token_hash: tokenHash, p_new_token_hash: newTokenHash,
    p_self_minutes: minutes, p_note: note || null,
  };
  const respond = (data: Record<string, unknown>) => {
    const { token_issued, ...rest } = data;
    return json(req, token_issued ? { ...rest, replacement_token: newToken } : rest);
  };
  const dbFail = (error: { message?: string }) => {
    const code = dbErrorCode(error);
    return fail(req, code, STATUS[code] ?? (code === 'server_error' ? 500 : 409));
  };

  // 1) 사전 확인: 학번·날짜·제출 창·기존 제출/token. 같은 요청의 재시도면 업로드 없이 결과만.
  const pre = await admin.rpc('public_submit_images', { ...base, p_images: null });
  if (pre.error) return dbFail(pre.error);
  if (pre.data?.replayed) return respond(pre.data);
  const { student_id: studentId, term_id: termId } = pre.data as { student_id: string; term_id: string };

  // 2) 서버 키로 비공개 버킷에 사진마다 새 경로로 업로드(덮어쓰기 없음). 하나라도 실패하면 올린 것을 지운다.
  const planned = images.map((img) => ({
    ...img, path: `${studentId}/${termId}/${crypto.randomUUID()}.${EXT[img.mime]}`,
  }));
  const uploads = await Promise.all(planned.map((img) =>
    admin.storage.from(BUCKET).upload(img.path, img.bytes, { contentType: img.mime, upsert: false, cacheControl: '0' })
  ));
  const uploaded = planned.filter((_, i) => !uploads[i].error).map((img) => img.path);
  if (uploaded.length !== planned.length) {
    if (uploaded.length) await admin.storage.from(BUCKET).remove(uploaded);
    return fail(req, 'upload_failed', 500);
  }

  // 3) 사진 세트 전체를 한 트랜잭션으로 반영. 실패하거나 다른 요청이 먼저 반영돼 재시도 결과가 오면
  //    이번 업로드는 모두 지운다(기존 제출은 그대로 남는다).
  const done = await admin.rpc('public_submit_images', {
    ...base,
    p_images: planned.map((img) => ({ path: img.path, mime: img.mime, bytes: img.bytes.length })),
  });
  if (done.error || done.data?.replayed) await admin.storage.from(BUCKET).remove(uploaded);
  if (done.error) return dbFail(done.error);
  return respond(done.data);
});
