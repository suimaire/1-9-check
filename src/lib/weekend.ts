import type { PublicDay } from './backend/types.ts';
import { addDays, kstStartOf, weekday } from './kst.ts';
import type { TermDay } from './types.ts';

export const WEEKEND_SATURDAYS = ['2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05'] as const;
export const WEEKEND_FINAL_CLOSE = '2026-12-07T14:59:59.999Z';

export function weekendDays(termId: string, deadlineMinutes: number): TermDay[] {
  return WEEKEND_SATURDAYS.flatMap(saturday => {
    const open = kstStartOf(addDays(saturday, 2));
    return [saturday, addDays(saturday, 1)].map(record_date => ({
      term_id: termId, record_date, is_target: true, note: null,
      window_open_at: new Date(open).toISOString(),
      deadline_at: new Date(open + deadlineMinutes * 60000).toISOString(),
    }));
  });
}

export interface WeekendPair<T extends PublicDay = PublicDay> {
  saturday: T;
  sunday: T;
}

/** 서버가 반환한 날짜만 짝짓는다. 클라이언트가 미래 제출일을 만들어 내지 않는다. */
export function weekendPairs<T extends PublicDay>(days: T[]): WeekendPair<T>[] {
  return days.filter(d => weekday(d.record_date) === '토').flatMap(saturday => {
    const sunday = days.find(d => d.record_date === addDays(saturday.record_date, 1)
      && d.window_open_at === saturday.window_open_at && d.deadline_at === saturday.deadline_at);
    return sunday ? [{ saturday, sunday }] : [];
  }).sort((a, b) => b.saturday.record_date.localeCompare(a.saturday.record_date));
}
