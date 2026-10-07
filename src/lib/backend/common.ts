import type { Submission, SubmissionImage, Term } from '../types.ts';

/** 진행 중이거나 다가오는 운영 기간을 우선, 없으면 가장 최근 운영 기간 */
export function pickTerm(terms: Term[], now: number): Term | null {
  const open = terms
    .filter((t) => Date.parse(t.final_close_at) >= now)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  if (open.length) return open[0];
  const past = [...terms].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  return past[0] ?? null;
}

export function extFor(mime: string): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

export interface SubmissionImageRow {
  submission_id: string;
  image_version: number;
  sort_order: number;
  storage_path: string;
  image_mime: string;
  image_bytes: number;
}

/**
 * 제출마다 현재 버전 사진 세트를 붙인다. submission_images 행이 없으면(예전 단일 사진 제출)
 * submissions.image_path를 1장짜리 세트로 쓴다.
 */
export function attachImages(subs: Array<Omit<Submission, 'images'>>, rows: SubmissionImageRow[]): Submission[] {
  const bySub = new Map<string, SubmissionImageRow[]>();
  for (const r of rows) {
    const list = bySub.get(r.submission_id);
    if (list) list.push(r);
    else bySub.set(r.submission_id, [r]);
  }
  return subs.map((s) => {
    const current = (bySub.get(s.id) ?? [])
      .filter((r) => r.image_version === s.image_version)
      .sort((a, b) => a.sort_order - b.sort_order);
    const images: SubmissionImage[] = current.length
      ? current.map((r) => ({ path: r.storage_path, mime: r.image_mime, bytes: r.image_bytes, sort_order: r.sort_order }))
      : [{ path: s.image_path, mime: s.image_mime, bytes: s.image_bytes, sort_order: 1 }];
    return { ...s, images };
  });
}

export function uuid(): string {
  return crypto.randomUUID();
}
