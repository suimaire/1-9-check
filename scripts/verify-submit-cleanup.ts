import assert from 'node:assert/strict';
import { finalizeImageUpload } from '../supabase/functions/submit/cleanup.ts';

const objects = new Set(['uploaded-a', 'uploaded-b']);
const rows: string[] = [];
const remove = async (paths: string[]) => { paths.forEach(path => objects.delete(path)); };
// DB commits, then the transport loses its response. The uploaded images must survive.
await finalizeImageUpload(async () => {
  rows.push('uploaded-a');
  return { data: null, error: { message: 'Failed to fetch', code: '' } };
}, ['uploaded-a'], remove);
assert.ok(objects.has(rows[0]), '응답 유실 후 이미 확정된 사진 보존');
await finalizeImageUpload(async () => ({ data: { replayed: true }, error: null }), ['uploaded-b'], remove);
assert.ok(objects.has(rows[0]));
assert.ok(!objects.has('uploaded-b'), '확정된 다른 요청의 재시도용 고아 사진만 삭제');
objects.add('denied');
await finalizeImageUpload(async () => ({ data: null, error: { code: 'P0001', message: 'not_participant' } }), ['denied'], remove);
assert.ok(!objects.has('denied'), '확실히 롤백된 거절 요청만 정리');
console.log('PASS: 확정 응답 유실 시 사진 보존, 재시도 고아 정리, 명시적 거절 정리');
