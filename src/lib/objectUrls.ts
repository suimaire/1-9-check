// 이미지 object URL 추적: 화면을 떠나거나 로그아웃할 때 모두 해제한다.
const urls = new Set<string>();

export function createTrackedUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

export function revokeUrl(url: string | null | undefined): void {
  if (!url) return;
  URL.revokeObjectURL(url);
  urls.delete(url);
}

export function revokeAllObjectUrls(): void {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
  blobs.clear();
}

// 같은 화면에서 썸네일·큰 사진이 같은 파일을 두 번 내려받지 않도록 메모리에만 잠깐 둔다(로그아웃 시 비움).
const blobs = new Map<string, Promise<Blob>>();
const MAX_CACHED = 60;

export function cachedBlob(path: string, load: (path: string) => Promise<Blob>): Promise<Blob> {
  const hit = blobs.get(path);
  if (hit) {
    blobs.delete(path);
    blobs.set(path, hit);
    return hit;
  }
  const p = load(path);
  blobs.set(path, p);
  p.catch(() => blobs.delete(path));
  while (blobs.size > MAX_CACHED) blobs.delete(blobs.keys().next().value!);
  return p;
}
