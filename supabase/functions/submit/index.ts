// 공개 학번 제출(학생 로그인 없음). verify_jwt=false로 배포하며, 그 자체는 보안 장치가 아니다.
// 모든 검증은 여기와 DB 함수 public_submit()에서 한다. 학생 브라우저는 DB·Storage에 직접 쓰지 않는다.
//
// POST application/json {action:'info'}  → 제출 일정(학생 이름·제출 현황 없음)
// POST multipart/form-data               → 제출
//   student_no, record_date, request_id(재시도에도 같은 값), replacement_token(선택), self_minutes(선택), note(선택), file
//
// 순서: 입력·파일 검증 → DB 사전 확인(재시도면 바로 결과) → Storage 업로드(서버 키) → DB 반영(실패 시 업로드 삭제)
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

const MAX_BYTES = 2 * 1024 * 1024; // 브라우저에서 2MB 이하로 압축해 올린다(버킷 한도와 같음)
const MAX_BODY = MAX_BYTES + 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

// 허용 학번: 정확히 10901~10934 (34개)
const STUDENT_NOS = new Set(Array.from({ length: 34 }, (_, i) => `109${String(i + 1).padStart(2, '0')}`));

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXT_OK: Record<string, string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };

function sniff(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

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
  invalid_student_no: 400, bad_request: 400, bad_type: 400, too_large: 413, bad_minutes: 400, note_too_long: 400,
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
  const file = form.get('file');

  if (!STUDENT_NOS.has(studentNo)) return fail(req, 'invalid_student_no');
  if (!validDate(recordDate) || !UUID.test(requestId)) return fail(req, 'bad_request');
  if (token && !TOKEN.test(token)) return fail(req, 'bad_request');
  const minutes = minutesRaw === '' ? null : Number(minutesRaw);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) return fail(req, 'bad_minutes');
  if (note.length > 100) return fail(req, 'note_too_long');

  if (!(file instanceof File) || file.size === 0) return fail(req, 'bad_request');
  if (file.size > MAX_BYTES) return fail(req, 'too_large', 413);
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!EXT_OK[file.type]?.includes(ext)) return fail(req, 'bad_type');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (mime !== file.type) return fail(req, 'bad_type');

  const tokenHash = token ? await sha256Hex(token) : null;
  const newToken = randomHex(32);
  const newTokenHash = await sha256Hex(newToken);
  const base = {
    p_student_no: studentNo, p_record_date: recordDate, p_request_id: requestId,
    p_token_hash: tokenHash, p_new_token_hash: newTokenHash,
    p_mime: mime, p_bytes: bytes.length, p_self_minutes: minutes, p_note: note || null,
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
  const pre = await admin.rpc('public_submit', { ...base, p_object_path: null });
  if (pre.error) return dbFail(pre.error);
  if (pre.data?.replayed) return respond(pre.data);
  const { student_id: studentId, term_id: termId } = pre.data as { student_id: string; term_id: string };

  // 2) 서버 키로 비공개 버킷에 새 경로로 업로드(덮어쓰기 없음)
  const path = `${studentId}/${termId}/${crypto.randomUUID()}.${EXT[mime]}`;
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false, cacheControl: '0' });
  if (up.error) return fail(req, 'upload_failed', 500);

  // 3) 반영. 실패하거나 다른 요청이 먼저 반영돼 재시도 결과가 오면 이번 업로드는 지운다.
  const done = await admin.rpc('public_submit', { ...base, p_object_path: path });
  if (done.error || done.data?.replayed) await admin.storage.from(BUCKET).remove([path]);
  if (done.error) return dbFail(done.error);
  return respond(done.data);
});
