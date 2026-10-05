import type { Term } from '../types.ts';

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

export function uuid(): string {
  return crypto.randomUUID();
}
