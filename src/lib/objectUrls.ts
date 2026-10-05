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
}
