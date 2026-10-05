// Asia/Seoul 기준 날짜 도구. 한국은 서머타임이 없어 UTC+9 고정으로 계산한다.
// (DB는 'Asia/Seoul' 타임존으로 계산하며 결과는 같다.)

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 시각(ms) → KST 기준 'YYYY-MM-DD' */
export function kstDateOf(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'의 KST 00:00 시각(ms) */
export function kstStartOf(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - KST_OFFSET_MS;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function isWeekend(date: string): boolean {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
}

/** '10월 5일(일)' */
export function fmtDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일(${weekday(date)})`;
}

/** '10/5' */
export function fmtShortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}`;
}

/** '10월 6일(월) 08:00' (KST) */
export function fmtDateTime(ms: number): string {
  return `${fmtDate(kstDateOf(ms))} ${fmtTime(ms)}`;
}

/** '08:00' (KST) */
export function fmtTime(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 16);
}

/** '10/6 07:41' (KST) */
export function fmtShortDateTime(ms: number): string {
  return `${fmtShortDate(kstDateOf(ms))} ${fmtTime(ms)}`;
}

/** 기록일 D의 제출 창 시작(D+1 00:00 KST)과 마감(+분) */
export function dayWindow(date: string, deadlineMinutes: number): { openAt: number; deadlineAt: number } {
  const openAt = kstStartOf(addDays(date, 1));
  return { openAt, deadlineAt: openAt + deadlineMinutes * 60 * 1000 };
}

/** 분 → '08:00' */
export function minutesToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** 사용 시간(분) → '3시간 12분' */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** 'YYYY-MM-DDTHH:MM' (KST, datetime-local 입력용) */
export function toKstLocalInput(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16);
}

export function fromKstLocalInput(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  return Date.parse(`${v}:00Z`) - KST_OFFSET_MS;
}
