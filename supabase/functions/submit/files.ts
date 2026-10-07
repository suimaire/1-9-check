// 사진 세트(1~3장) 파일 검증. 외부 의존성이 없어 Node 확인 스크립트에서도 그대로 불러 쓴다.
// 클라이언트 검증과 별개로 서버에서 장수·크기·확장자·MIME·파일 서명을 사진마다 모두 확인한다.

export const MAX_BYTES = 2 * 1024 * 1024; // 사진 1장당. 브라우저에서 2MB 이하로 압축해 올린다(버킷 한도와 같음)
export const MAX_FILES = 3;

export const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXT_OK: Record<string, string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };

export function sniff(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

export type CheckedFiles =
  | { ok: true; images: Array<{ bytes: Uint8Array; mime: string }> }
  | { ok: false; code: string; status: number };

/** FormData의 files 값들(순서 = 사진 순서)을 검증한다. 하나라도 틀리면 전체를 거절한다. */
export async function checkFiles(files: unknown[]): Promise<CheckedFiles> {
  if (files.length === 0) return { ok: false, code: 'no_image', status: 400 };
  if (files.length > MAX_FILES) return { ok: false, code: 'too_many_images', status: 400 };
  const images: Array<{ bytes: Uint8Array; mime: string }> = [];
  for (const file of files) {
    if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'bad_request', status: 400 };
    if (file.size > MAX_BYTES) return { ok: false, code: 'too_large', status: 413 };
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!EXT_OK[file.type]?.includes(ext)) return { ok: false, code: 'bad_type', status: 400 };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniff(bytes);
    if (!mime || mime !== file.type) return { ok: false, code: 'bad_type', status: 400 };
    images.push({ bytes, mime });
  }
  return { ok: true, images };
}
