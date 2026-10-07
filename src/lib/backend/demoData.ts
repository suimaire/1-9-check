// 데모 전용 합성 데이터. 실제 학생 정보·스크린샷 없음.
// 데모 운영 기간(2026-10-05 ~ 10-16)은 화면 확인용 예시이며 실제 운영 일정이 아니다.
import { addDays, dateRange, dayWindow, kstStartOf } from '../kst.ts';
import type {
  ClassInfo, Excuse, Exemption, Student, Submission, TeacherNote, Term, TermDay, ReviewStatus,
} from '../types.ts';

export const DEMO_CLASS_ID = 'demo-class';
export const DEMO_TERM_ID = 'demo-term';

/** 데모 시각 선택지(모두 10/13 기록의 마감 10/14 08:00 전후) */
export const DEMO_CLOCKS: Array<{ id: string; label: string; ms: number }> = [
  { id: 'before', label: '10/14 07:20 (마감 전)', ms: kstStartOf('2026-10-14') + (7 * 60 + 20) * 60000 },
  { id: 'exact', label: '10/14 08:00 (마감 정각)', ms: kstStartOf('2026-10-14') + 8 * 3600000 },
  { id: 'after', label: '10/14 08:30 (마감 후)', ms: kstStartOf('2026-10-14') + (8 * 60 + 30) * 60000 },
];

export interface DemoStore {
  klass: ClassInfo;
  terms: Term[];
  days: TermDay[];
  students: Student[];
  submissions: Submission[];
  excuses: Excuse[];
  exemptions: Exemption[];
  notes: TeacherNote[];
  /** 합성 이미지 저장(경로 → Blob). 사용자가 고른 실제 사진은 받지 않는다. */
  images: Map<string, Blob>;
  /** 제출 요청 기록(재시도 멱등성) */
  events: Map<string, { submissionId: string; version: number; issuedToken: boolean }>;
  /** 제출별 replacement token(데모: 메모리에만) */
  tokens: Map<string, string>;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function buildDemoStore(): DemoStore {
  const start = '2026-10-05';
  const last = '2026-10-16';
  const deadlineMinutes = 480;
  const finalClose = dayWindow(last, deadlineMinutes).deadlineAt + 7 * 86400000;

  const term: Term = {
    id: DEMO_TERM_ID,
    class_id: DEMO_CLASS_ID,
    name: '데모 운영 기간',
    start_date: start,
    last_record_date: last,
    deadline_minutes: deadlineMinutes,
    final_close_at: iso(finalClose),
    retention_until: addDays(new Date(finalClose + 9 * 3600000).toISOString().slice(0, 10), 30),
    instructions: '대표 스마트폰 1대의 하루 전체(00:00~23:59) 화면 시간 화면을 올려 주세요. 날짜와 총 사용 시간이 보이면 됩니다.',
  };

  const days: TermDay[] = dateRange(start, last).map((d) => {
    const w = dayWindow(d, deadlineMinutes);
    const excluded = d === '2026-10-09';
    return {
      term_id: DEMO_TERM_ID,
      record_date: d,
      is_target: !excluded,
      window_open_at: iso(w.openAt),
      deadline_at: iso(w.deadlineAt),
      note: excluded ? '예시 제외일' : null,
    };
  });

  const students: Student[] = Array.from({ length: 34 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      id: `s${n}`,
      class_id: DEMO_CLASS_ID,
      student_no: `109${n}`,
      name: `학생 ${n}`,
      active: true,
      roster_from: null,
      roster_until: null,
    };
  });

  const submissions: Submission[] = [];
  const excuses: Excuse[] = [];
  const exemptions: Exemption[] = [];
  const notes: TeacherNote[] = [];

  const exempt = (sid: string, date: string, reason: string) =>
    exemptions.push({ term_id: DEMO_TERM_ID, student_id: sid, record_date: date, reason });

  // 학생별 예외 상황
  const missing = new Set(['s14|2026-10-11', 's14|2026-10-12', 's27|2026-10-12', 's25|2026-10-12', 's33|2026-10-12', 's34|2026-10-12']);
  const lateAt = new Map<string, number>([
    ['s05|2026-10-12', kstStartOf('2026-10-13') + (9 * 60 + 10) * 60000],
    ['s12|2026-10-12', kstStartOf('2026-10-13') + (12 * 60 + 40) * 60000],
    ['s20|2026-10-12', kstStartOf('2026-10-13') + (21 * 60 + 5) * 60000],
    ['s08|2026-10-07', kstStartOf('2026-10-08') + (8 * 60 + 1) * 60000],
    ['s31|2026-10-06', kstStartOf('2026-10-08') + (19 * 60 + 30) * 60000],
  ]);
  // 10/13 기록은 10/14 07:20 기준 22명만 접수(나머지는 마감 전 대기)
  const submittedOn13 = new Set(
    Array.from({ length: 22 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`).filter((s) => s !== 's14' && s !== 's09'),
  );
  submittedOn13.add('s23');
  submittedOn13.add('s24');

  for (const s of students) {
    for (const day of days) {
      if (!day.is_target) continue;
      const d = day.record_date;
      if (d > '2026-10-13') continue;
      const k = `${s.id}|${d}`;
      if (missing.has(k)) continue;
      if (d === '2026-10-13' && !submittedOn13.has(s.id)) continue;
      if (s.id === 's09' && d >= '2026-10-11' && d <= '2026-10-12') continue; // 면제 기간 중 미제출
      if ((s.id === 's33' || s.id === 's34')) continue; // 아직 한 번도 제출하지 않음

      const h = hash(k);
      const openAt = Date.parse(day.window_open_at);
      let at = lateAt.get(k) ?? openAt + (6 * 3600 + (h % 7200)) * 1000; // 06:00~08:00 사이
      if (d === '2026-10-13') at = openAt + (40 * 60 + (h % (6 * 3600))) * 1000; // 00:40~06:40
      const reviewed = d <= '2026-10-10' || (d <= '2026-10-12' && h % 3 !== 0);
      let review: ReviewStatus = reviewed ? 'checked' : 'unchecked';
      let message: string | null = null;
      let version = 1;
      let updated = at;
      if (k === 's03|2026-10-12' || k === 's22|2026-10-11') {
        review = 'revision_requested';
        message = '날짜와 총 사용 시간이 함께 보이도록 다시 찍어 주세요.';
      }
      if (k === 's03|2026-10-11') {
        version = 2;
        updated = at + 3 * 3600000;
        review = 'unchecked';
      }
      // 사진 1~3장이 섞이게(1장 위주)
      const count = h % 5 < 2 ? 1 : h % 5 < 4 ? 2 : 3;
      const images = Array.from({ length: count }, (_, i) => ({
        path: `demo/${s.id}/${d}/v${version}/p${i + 1}`, mime: 'image/webp', bytes: 150000 + ((h >> (i + 2)) % 300000), sort_order: i + 1,
      }));
      submissions.push({
        id: `sub-${k}`,
        term_id: DEMO_TERM_ID,
        student_id: s.id,
        record_date: d,
        image_path: images[0].path,
        image_version: version,
        image_mime: 'image/webp',
        image_bytes: images[0].bytes,
        first_submitted_at: iso(at),
        image_updated_at: iso(updated),
        self_minutes: h % 3 === 0 ? 60 + (h % 360) : null,
        student_note: k === 's11|2026-10-12' ? '어제는 시험공부 때문에 거의 안 썼어요.' : null,
        review_status: review,
        reviewed_version: review === 'unchecked' ? null : version,
        revision_message: message,
        reviewed_at: review === 'unchecked' ? null : iso(at + 2 * 3600000),
        resubmit_open: false,
        images,
      });
    }
  }

  // 면제: s09 체험학습(10/10~10/12, 10/10은 이미 제출되어 있어도 접수 이력 보존)
  for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) exempt('s09', d, '체험학습(예시)');
  // s17: 기기 고장 사유 승인 → 면제
  exempt('s17', '2026-10-12', '사유 승인');
  submissions.splice(submissions.findIndex((x) => x.id === 'sub-s17|2026-10-12'), 1);
  excuses.push({
    id: 'ex-s17', term_id: DEMO_TERM_ID, student_id: 's17', record_date: '2026-10-12', reason: 'device_unavailable',
    note: '휴대폰 수리 맡김', status: 'approved', created_at: iso(kstStartOf('2026-10-13') + 7 * 3600000),
    updated_at: iso(kstStartOf('2026-10-13') + 7 * 3600000),
  });
  // s25: 사유 도착(승인 전) → 상태는 여전히 미제출
  excuses.push({
    id: 'ex-s25', term_id: DEMO_TERM_ID, student_id: 's25', record_date: '2026-10-12', reason: 'device_unavailable',
    note: '부모님이 시험기간에 보관 중이에요', status: 'pending', created_at: iso(kstStartOf('2026-10-13') + 7.5 * 3600000),
    updated_at: iso(kstStartOf('2026-10-13') + 7.5 * 3600000),
  });

  notes.push({
    id: 'note-1', term_id: DEMO_TERM_ID, student_id: 's14', record_date: '2026-10-12',
    body: '이틀 연속 미제출. 쉬는 시간에 개별 확인 예정(예시 메모).',
    created_at: iso(kstStartOf('2026-10-13') + 13 * 3600000), updated_at: iso(kstStartOf('2026-10-13') + 13 * 3600000),
  });

  return {
    klass: { id: DEMO_CLASS_ID, name: '1학년 9반(데모)', app_title: '1-9 체크', app_subtitle: '시험기간 우리 반 루틴' },
    terms: [term],
    days,
    students,
    submissions,
    excuses,
    exemptions,
    notes,
    images: new Map(),
    events: new Map(),
    tokens: new Map(),
  };
}

/** 합성 스크린타임 이미지(실제 기기 화면 아님). page 2·3은 추가 화면 예시(앱 이름 없이). */
export async function renderSyntheticScreenshot(title: string, date: string, minutes: number, page = 1): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1600;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f2f4f7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(48, 140, 984, 1340);
  ctx.fillStyle = '#b42318';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('데모용 합성 이미지 · 실제 기록 아님', 72, 90);
  ctx.fillStyle = '#101828';
  ctx.font = 'bold 64px sans-serif';
  if (page > 1) {
    ctx.fillText(page === 2 ? '항목별 사용 시간 (예시)' : '시간대별 사용 (예시)', 96, 250);
    ctx.font = '44px sans-serif';
    ctx.fillStyle = '#475467';
    ctx.fillText(`${date} · ${title} · 사진 ${page}`, 96, 330);
    if (page === 2) {
      ['항목 A', '항목 B', '항목 C', '항목 D', '항목 E'].forEach((label, i) => {
        const v = [0.9, 0.6, 0.45, 0.3, 0.15][i] * (0.6 + ((minutes + i * 37) % 40) / 100);
        ctx.fillStyle = '#344054';
        ctx.font = '40px sans-serif';
        ctx.fillText(label, 96, 470 + i * 160);
        ctx.fillStyle = '#7a5af8';
        ctx.fillRect(96, 500 + i * 160, 860 * v, 40);
      });
    } else {
      for (let i = 0; i < 24; i++) {
        const v = ((minutes * (i + 3)) % 97) / 97 * (i < 7 ? 0.2 : 1);
        ctx.fillStyle = '#12b76a';
        ctx.fillRect(96 + i * 38, 1200 - 600 * v, 26, 600 * v);
      }
      ctx.fillStyle = '#667085';
      ctx.font = '32px sans-serif';
      ['0시', '6시', '12시', '18시'].forEach((t, i) => ctx.fillText(t, 96 + i * 6 * 38, 1260));
    }
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'),
    );
  }
  ctx.fillText('화면 시간', 96, 250);
  ctx.font = '44px sans-serif';
  ctx.fillStyle = '#475467';
  ctx.fillText(`${date} (하루 전체)`, 96, 330);
  ctx.fillText(title, 96, 400);
  ctx.fillStyle = '#101828';
  ctx.font = 'bold 120px sans-serif';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  ctx.fillText(`${h}시간 ${m}분`, 96, 580);
  const bars = [0.3, 0.1, 0.05, 0.2, 0.6, 0.9, 0.4, 0.7, 0.5, 0.8, 0.3, 0.2];
  bars.forEach((v, i) => {
    ctx.fillStyle = '#2e90fa';
    const bh = 400 * v;
    ctx.fillRect(110 + i * 72, 1100 - bh, 44, bh);
  });
  ctx.fillStyle = '#98a2b3';
  ctx.font = '36px sans-serif';
  ctx.fillText('앱 목록 영역은 가린 예시', 96, 1300);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'),
  );
}
