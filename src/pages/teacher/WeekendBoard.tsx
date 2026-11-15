import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Gallery, ReviewChip, StateChip } from '../../components/ui.tsx';
import { fmtDate, fmtDateTime } from '../../lib/kst.ts';
import { cellKey, dayRows, STATE_LABEL, type Row } from '../../lib/status.ts';
import type { Student, TermDay } from '../../lib/types.ts';
import { weekendPairs, type WeekendPair } from '../../lib/weekend.ts';
import { CellModal } from './CellModal.tsx';
import { useTeacher } from './TeacherLayout.tsx';

function completionLabel(rows: Row[]): string {
  const received = rows.filter((row) => row.submission !== null).length;
  if (received === 2) return '두 날짜 접수 완료';
  const missing = rows.filter((row) => row.state === 'missing').length;
  if (missing > 0) return missing === 1 ? '한 날짜 미제출' : '두 날짜 미제출';
  if (received === 1) return '한 날짜 접수, 나머지 ' + STATE_LABEL[rows.find((row) => !row.submission)!.state];
  if (rows.some((row) => row.state === 'waiting')) return '제출 대기';
  if (rows.some((row) => row.state === 'scheduled')) return '제출 예정';
  return '접수 없음 (면제 또는 미대상)';
}

export default function WeekendBoard() {
  const { data, board, now } = useTeacher();
  const [open, setOpen] = useState<{ student: Student; date: string } | null>(null);
  const [comparison, setComparison] = useState<{ student: Student; pair: WeekendPair<TermDay> } | null>(null);
  const comparisonRef = useRef<HTMLElement>(null);
  useEffect(() => { if (comparison) comparisonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [comparison]);
  if (data.term?.submission_mode !== 'weekend') return <div className="card stack"><p>주말 운영 기간을 선택하면 주말별 현황을 볼 수 있습니다.</p><Link className="btn" to="/teacher/settings">운영 설정</Link></div>;
  const students = data.students.filter((student) => board.participants?.has(student.id));
  const pairs = weekendPairs(data.days).slice().reverse();
  return <div className="stack">
    <div className="row between"><div className="stack"><h1>주말별 현황</h1><p className="small muted">{data.term.name}, 참여자 {students.length}명. 토요일과 일요일의 접수를 따로 확인합니다.</p></div><Link className="btn" to="/teacher/roster">참여자 관리</Link></div>
    {students.length === 0 && <div className="banner info">선택된 참여자가 없습니다. 명단에서 이 기간의 신청자를 선택하고 저장하세요.</div>}
    {pairs.map((pair, index) => {
      const days = [pair.saturday, pair.sunday];
      const rowsByDay = days.map((day) => dayRows(day, students, board, now));
      return <section className="card stack" key={pair.saturday.record_date}>
        <h2>{index + 1}주차: {fmtDate(pair.saturday.record_date)} / {fmtDate(pair.sunday.record_date)}</h2>
        <p className="small muted">제출 시작 {fmtDateTime(Date.parse(pair.saturday.window_open_at))}, 마감 {fmtDateTime(Date.parse(pair.saturday.deadline_at))} (KST)</p>
        <div className="table-wrap"><table className="list">
          <thead><tr><th>학번 이름</th><th>토요일</th><th>일요일</th><th>두 날짜 접수</th><th>사진 비교</th></tr></thead>
          <tbody>{students.map((student, rowIndex) => {
            const rows = rowsByDay.map((dayRows) => dayRows[rowIndex]);
            const received = rows.filter((row) => row.submission !== null).length;
            return <tr key={student.id}>
              <th scope="row"><Link to={`/teacher/students/${student.id}`}>{student.student_no} {student.name}</Link></th>
              {rows.map((row, dayIndex) => <td key={days[dayIndex].record_date}>
                <button className="btn sm" onClick={() => setOpen({ student, date: days[dayIndex].record_date })} aria-label={`${student.name} ${fmtDate(days[dayIndex].record_date)} ${STATE_LABEL[row.state]} 확인`}>
                  <StateChip state={row.state} />
                  {row.submission && <span className="xs">사진 {row.submission.images.length}장</span>}
                </button>
                {row.submission && <div><ReviewChip status={row.submission.review_status} /></div>}
              </td>)}
              <td><strong>{received}/2</strong><div className="small">{completionLabel(rows)}</div></td>
              <td><button className="btn sm" disabled={received === 0} onClick={() => setComparison({ student, pair })}>두 날짜 비교</button></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>;
    })}
    <p className="xs muted">두 날짜 접수 수는 실제 제출 기록만 셉니다. 면제와 미대상은 접수 완료로 세지 않으며, 아직 열리지 않았거나 마감 전인 날짜는 미제출로 표시하지 않습니다.</p>
    {comparison && <section ref={comparisonRef} className="card stack" style={{ scrollMarginTop: 'calc(var(--topbar-h, 64px) + 16px)' }} aria-label="같은 학생의 주말 사진 비교">
      <div className="row between"><h2>{comparison.student.student_no} {comparison.student.name} 사진 비교</h2><button className="btn" onClick={() => setComparison(null)}>비교 닫기</button></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 16 }}>
        {[comparison.pair.saturday, comparison.pair.sunday].map((day) => {
          const submission = board.submissions.get(cellKey(comparison.student.id, day.record_date));
          return <div className="stack" key={day.record_date} style={{ minWidth: 0 }}>
            <h3>{fmtDate(day.record_date)}</h3>
            {submission?.images.length ? <Gallery key={`${submission.id}:${submission.image_version}`} images={submission.images} alt={`${comparison.student.name} ${fmtDate(day.record_date)}`} /> : <p className="muted">접수된 사진이 없습니다.</p>}
            <button className="btn" onClick={() => setOpen({ student: comparison.student, date: day.record_date })}>이 날짜 확인 및 수정 요청</button>
          </div>;
        })}
      </div>
    </section>}
    {open && <CellModal key={`${open.student.id}:${open.date}`} student={open.student} date={open.date} onClose={() => setOpen(null)} />}
  </div>;
}
