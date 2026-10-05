// 업로드 전 브라우저에서 재인코딩: 글자 판독 가능한 해상도 유지 + EXIF 등 부가 메타데이터 제거.
// 원본은 서버로 보내지 않는다.

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_STORED_BYTES = 2 * 1024 * 1024;
const MAX_WIDTH = 1440; // 스마트폰 스크린샷 원본 폭(대부분 1080~1320px)은 그대로 둔다
const MAX_HEIGHT = 4000;
const MIN_WIDTH = 900; // 이보다 줄이면 작은 글자를 읽기 어렵다

export interface PreparedImage {
  blob: Blob;
  mime: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  sourceBytes: number;
}

export class ImageError extends Error {}

async function sniff(file: Blob): Promise<string | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const s = String.fromCharCode(...b);
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError('사진 파일이 10MB를 넘습니다. 스크린샷을 다시 찍어 주세요.');
  const kind = await sniff(file);
  if (!kind) throw new ImageError('JPEG, PNG, WebP 스크린샷만 올릴 수 있습니다. (GIF·SVG·PDF·영상 불가)');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('이미지를 열 수 없습니다. 다른 스크린샷을 선택해 주세요.');
  }

  let scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('이 브라우저에서는 이미지를 처리할 수 없습니다.');

  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.86, 0.76, 0.66]) {
        // Safari 일부 버전은 WebP 인코딩을 지원하지 않아 PNG를 돌려준다 → JPEG로 대체
        let blob = await toBlob(canvas, 'image/webp', quality);
        let mime: PreparedImage['mime'] = 'image/webp';
        if (!blob || blob.type !== 'image/webp') {
          blob = await toBlob(canvas, 'image/jpeg', quality);
          mime = 'image/jpeg';
        }
        if (blob && blob.size <= MAX_STORED_BYTES) {
          return { blob, mime, width: canvas.width, height: canvas.height, sourceBytes: file.size };
        }
      }
      const nextScale = scale * 0.85;
      if (bitmap.width * nextScale < MIN_WIDTH) break;
      scale = nextScale;
    }
  } finally {
    bitmap.close();
  }
  throw new ImageError('글자를 읽을 수 있는 크기로 2MB 이하가 되지 않습니다. 필요한 부분만 잘라서 다시 선택해 주세요.');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
