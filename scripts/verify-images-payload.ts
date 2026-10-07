// 사진 세트 payload 확인: submit 함수의 파일 검증(1~3장, 사진마다 크기·확장자·MIME·서명)과
// 교사 화면의 예전 단일 사진 기록 호환(attachImages). 네트워크·DB 없음.
// 실행: node scripts/verify-images-payload.ts
import { checkFiles, MAX_BYTES } from '../supabase/functions/submit/files.ts';
import { attachImages } from '../src/lib/backend/common.ts';
import type { Submission } from '../src/lib/types.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));
const png = (name = 'a.png') => new File([PNG], name, { type: 'image/png' });
const jpg = (name = 'b.jpg') => new File([JPG], name, { type: 'image/jpeg' });
const webp = (name = 'c.webp') => new File([WEBP], name, { type: 'image/webp' });
const code = async (files: unknown[]) => {
  const r = await checkFiles(files);
  return r.ok ? `ok:${r.images.map((i) => i.mime).join(',')}` : r.code;
};

check('0장 → no_image', (await code([])) === 'no_image');
check('1장 PNG 통과', (await code([png()])) === 'ok:image/png');
check('3장(PNG·JPEG·WebP) 통과, 순서 유지', (await code([png(), jpg(), webp()])) === 'ok:image/png,image/jpeg,image/webp');
check('4장 → too_many_images', (await code([png(), png(), png(), png()])) === 'too_many_images');
check('문자열 값(파일 아님) → bad_request', (await code([png(), 'x'])) === 'bad_request');
check('빈 파일 → bad_request', (await code([new File([], 'e.png', { type: 'image/png' })])) === 'bad_request');
const big = new Uint8Array(MAX_BYTES + 1);
big.set(PNG);
check('2장째가 2MB 초과 → too_large(전체 거절)', (await code([png(), new File([big], 'big.png', { type: 'image/png' })])) === 'too_large');
const exact = new Uint8Array(MAX_BYTES);
exact.set(PNG);
check('정확히 2MB는 통과(사진마다 한도)', (await code([new File([exact], 'x.png', { type: 'image/png' }), png(), png()])) === 'ok:image/png,image/png,image/png');
check('확장자·MIME 불일치 → bad_type', (await code([new File([PNG], 'a.jpg', { type: 'image/png' })])) === 'bad_type');
check('허용 외 MIME(GIF) → bad_type', (await code([new File([PNG], 'a.gif', { type: 'image/gif' })])) === 'bad_type');
check('서명 위조(JPEG라 하고 PNG 내용) → bad_type', (await code([png(), new File([PNG], 'x.jpg', { type: 'image/jpeg' })])) === 'bad_type');
check('서명 없음(텍스트) → bad_type', (await code([new File([new TextEncoder().encode('hello world!')], 'x.png', { type: 'image/png' })])) === 'bad_type');

// 예전 단일 사진 기록 호환
const base = {
  term_id: 't', student_id: 's', record_date: '2026-10-06', image_mime: 'image/webp', image_bytes: 1000,
  first_submitted_at: '2026-10-06T00:00:00Z', image_updated_at: '2026-10-06T00:00:00Z', self_minutes: null,
  student_note: null, review_status: 'unchecked', reviewed_version: null, revision_message: null, reviewed_at: null,
  resubmit_open: false,
} as const;
const subs: Array<Omit<Submission, 'images'>> = [
  { ...base, id: 'legacy', image_path: 'legacy.webp', image_version: 1 },
  { ...base, id: 'multi', image_path: 'm2-1.webp', image_version: 2 },
];
const rows = [
  { submission_id: 'multi', image_version: 1, sort_order: 1, storage_path: 'm1-1.webp', image_mime: 'image/webp', image_bytes: 1 },
  { submission_id: 'multi', image_version: 2, sort_order: 3, storage_path: 'm2-3.webp', image_mime: 'image/png', image_bytes: 3 },
  { submission_id: 'multi', image_version: 2, sort_order: 1, storage_path: 'm2-1.webp', image_mime: 'image/webp', image_bytes: 1 },
  { submission_id: 'multi', image_version: 2, sort_order: 2, storage_path: 'm2-2.webp', image_mime: 'image/jpeg', image_bytes: 2 },
];
const [legacy, multi] = attachImages(subs, rows);
check('사진 행 없는 예전 제출 → image_path 1장 세트', legacy.images.length === 1 && legacy.images[0].path === 'legacy.webp' && legacy.images[0].sort_order === 1);
check('사진 세트는 현재 버전만, sort_order 순', multi.images.map((i) => i.path).join(',') === 'm2-1.webp,m2-2.webp,m2-3.webp');

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과 (사진 세트 payload·호환)`);
process.exit(failed ? 1 : 0);
