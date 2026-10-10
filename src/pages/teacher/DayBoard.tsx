import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ReviewChip, StateChip } from '../../components/ui.tsx';
import { copyText } from '../../lib/csv.ts';
import { fmtDate, fmtDateTime, fmtShortDateTime } from '../../lib/kst.ts';
import { consecutiveMissingCount, dayRows, latestFinishedTargetDay, STREAK_MIN, summarize, type Row } from '../../lib/status.ts';
import type { Student } from '../../lib/types.ts';
import { CellModal } from './CellModal.tsx';
import { useTeacher } from './TeacherLayout.tsx';

type Filter = 'all' | 'missing' | 'waiting' | 'late' | 'unchecked' | 'revision' | 'excuse';

const FILTERS: Array<{ id: Filter; label: string; test: (r: Row) => boolean }> = [
  { id: 'all', label: '전체', test: () => true },
  { id: 'missing', label: '현재 미제출', test: (r) => r.state === 'missing' },
  { id: 'waiting', label: '제출 대기', test: (r) => r.state === 'waiting' },
  { id: 'late', label: '지각', test: (r) => r.state === 'late' },
  { id: 'unchecked', label: '미확인', test: (r) => (r.state === 'on_time' || r.state === 'late') && r.submission?.review_status === 'unchecked' },
  { id: 'revision', label: '수정 요청', test: (r) => r.submission?.review_status === 'revision_requested' && r.state !== 'exempt' },
  { id: 'excuse', label: '사유 도착', test: (r) => !!r.excuse && r.excuse.status === 'pending' && r.state !== 'not_target' },
];

export default function DayBoard() {
  const { data, board, now } = useTeacher();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Student | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const days = data.days;
  const defaultDay = latestFinishedTargetDay(days, now) ?? days[0] ?? null;
  const day = days.find((d) => d.record_date === params.get('date')) ?? defaultDay;

  const rows = useMemo(() => (day ? dayRows(day, data.students, board, now) : []), [day, data.students, board, now]);
  const streaks = useMemo(() => new Map(data.students.map((s) => [s.id, consecutiveMissingCount(s, days, board, now)])), [data.students, days, board, now]);

  if (!data.term) {
    return <div className="card stack"><p>아직 운영 기간이 없습니다.</p><Link className="btn primary" to="/teacher/settings">운영 기간 설정하기</Link></div>;
  }
  if (!day) return <div className="card">운영 기간에 날짜가 없습니다.</div>;

  const sum = summarize(rows, day);
  const beforeDeadline = now <= Date.parse(day.deadline_at);
  const idx = days.indexOf(day);
  const q = query.trim();
  const activeFilter = FILTERS.find((f) => f.id === filter)!;
  const visible = rows.filter((r) => r.state !== 'not_target' || filter === 'all')
    .filter(activeFilter.test)
    .filter((r) => !q || r.student.student_no.includes(q) || r.student.name.includes(q));
  const missingRows = rows.filter((r) => r.state === 'missing');

  async function copyMissing() {
    const text = [`${fmtDate(day!.record_date)} 기록 미제출 ${missingRows.length}명 (마감 ${fmtDateTime(Date.parse(day!.deadline_at))})`,
      ...missingRows.map((r) => `${r.student.student_no} ${r.student.name}`)].join('\n');
    const ok = await copyText(text);
    setCopied(ok ? '복사했습니다. 메시지는 자동 전송되지 않습니다.' : text);
  }

  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between">
          <div className="stack" style={{ gap: 2 }}>
            <h1>{fmtDate(day.record_date)} 기록</h1>
            <span className="small muted">
              {day.is_target ? `제출 ${fmtDateTime(Date.parse(day.window_open_at))} ~ 마감 ${fmtDateTime(Date.parse(day.deadline_at))}` : `수집 제외일${day.note ? ` · ${day.note}` : ''}`}
            </span>
          </div>
          <div className="row">
            <button className="btn sm" disabled={idx <= 0} onClick={() => setParams({ date: days[idx - 1].record_date })} aria-label="이전 날짜">◀ 이전</button>
            <select value={day.record_date} onChange={(e) => setParams({ date: e.target.value })} style={{ width: 'auto', minHeight: 36 }} aria-label="날짜 선택">
              {days.map((d) => <option key={d.record_date} value={d.record_date}>{fmtDate(d.record_date)}{d.is_target ? '' : ' (제외)'}</option>)}
            </select>
            <button className="btn sm" disabled={idx >= days.length - 1} onClick={() => setParams({ date: days[idx + 1].record_date })} aria-label="다음 날짜">다음 ▶</button>
          </div>
        </div>
        {day.record_date !== defaultDay?.record_date && (
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => setParams({})}>가장 최근 끝난 대상일로</button>
        )}

        {day.is_target && (
          <>
            <div className="stats">
              <Stat label="전체 명단" value={sum.roster} />
              <Stat label="제출 대상" value={sum.target} sub={sum.exempt ? `면제 ${sum.exempt}명 제외` : undefined} />
              <Stat label="접수" value={sum.received} sub={`정시 ${sum.onTime} · 지각 ${sum.late}`} />
              {now < Date.parse(day.window_open_at)
                ? <Stat label="예정" value={sum.scheduled} sub="제출 창이 아직 열리지 않음" />
                : beforeDeadline
                  ? <Stat label="제출 대기(마감 전)" value={sum.waiting} sub="마감 후 미제출로 바뀜" />
                  : <Stat label="현재 미제출" value={sum.missing} />}
              <Stat label="면제" value={sum.exempt} />
            </div>
            <div className="row small muted" style={{ gap: 12 }}>
              <span>접수 중 · 지각 <strong>{sum.late}</strong></span>
              <span>미확인 <strong>{sum.unchecked}</strong></span>
              <span>확인 완료 <strong>{sum.checked}</strong></span>
              <span>수정 요청 <strong>{sum.revision}</strong></span>
              <span>사유 도착 <strong>{sum.excuses}</strong></span>
            </div>
          </>
        )}
      </section>

      <section className="stack">
        <div className="row between">
          <div className="filters" role="group" aria-label="필터">
            {FILTERS.filter((f) => f.id !== 'waiting' || sum.waiting > 0).map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} {f.id !== 'all' && <span className="xs">{rows.filter(f.test).length}</span>}
              </button>
            ))}
          </div>
          <input type="search" placeholder="학번·이름 검색" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 220 }} aria-label="학번 또는 이름 검색" />
        </div>
        {filter === 'missing' && (
          <div className="row">
            <button className="btn sm" disabled={missingRows.length === 0} onClick={() => void copyMissing()}>미제출자 목록 복사</button>
            {beforeDeadline && <span className="small muted">마감 전이라 미제출자는 아직 없습니다.</span>}
          </div>
        )}
        {copied && <div className="copy-box">{copied}</div>}

        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>학번</th><th>이름</th><th>제출 상태</th><th>최초 접수</th><th>확인</th><th>사유</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.student.id} className="clickable" onClick={() => setOpen(r.student)}>
                  <td className="mono nowrap">{r.student.student_no}</td>
                  <td className="nowrap">
                    {r.student.name}
                    {!r.student.active && <span className="chip neutral" style={{ marginLeft: 6 }}>비활성</span>}
                    {(streaks.get(r.student.id) ?? 0) >= STREAK_MIN && <span className="chip flag" style={{ marginLeft: 6 }} title="현재 시각 기준, 마감이 지난 수집 대상일을 최근부터 거슬러 센 연속 미제출 일수(면제·수집 제외·마감 전 날짜는 건너뜀)">{streaks.get(r.student.id)}일 연속 미제출</span>}
                  </td>
                  <td className="nowrap"><StateChip state={r.state} />{r.submission && <span className="xs muted"> 사진 {r.submission.images.length}장</span>}</td>
                  <td className="mono nowrap small">{r.submission ? fmtShortDateTime(Date.parse(r.submission.first_submitted_at)) : '–'}</td>
                  <td>{r.submission ? <ReviewChip status={r.submission.review_status} /> : <span className="faint">–</span>}</td>
                  <td>{r.excuse ? <span className="chip info">{r.excuse.status === 'pending' ? '도착' : r.excuse.status === 'approved' ? '승인' : '미승인'}</span> : <span className="faint">–</span>}</td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={6} className="muted">해당하는 학생이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="xs muted">'N일 연속 미제출'은 마감이 지난 수집 대상일 기준 연속 미제출 일수(2일 이상)를 보여 주는 교사 참고 표시입니다. 면제·수집 제외일은 건너뜁니다. 벌점·진단과 연결되지 않습니다. 정렬은 학번순입니다.</p>
      </section>

      {open && <CellModal student={open} date={day.record_date} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
