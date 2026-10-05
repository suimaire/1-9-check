import { useMemo, useState } from 'react';
import { StateChip } from '../../components/ui.tsx';
import { downloadBlob, toCsv } from '../../lib/csv.ts';
import { fmtShortDate, fmtDateTime, weekday } from '../../lib/kst.ts';
import { cellKey, dayRows, STATE_LABEL, STATE_SHORT, submitState, summarize, type SubmitState } from '../../lib/status.ts';
import { EXCUSE_LABEL, REVIEW_LABEL, type Student } from '../../lib/types.ts';
import { CellModal } from './CellModal.tsx';
import { useTeacher } from './TeacherLayout.tsx';

const LEGEND: SubmitState[] = ['on_time', 'late', 'waiting', 'missing', 'exempt', 'scheduled', 'not_target'];

export default function Overview() {
  const { data, board, now } = useTeacher();
  const [open, setOpen] = useState<{ student: Student; date: string } | null>(null);
  const days = data.days;
  const students = data.students;

  // 명단 × 운영 달력으로 모든 칸을 만든 뒤 제출을 연결한다(제출 기록만 조회하지 않음)
  const grid = useMemo(() => students.map((student) => ({
    student,
    cells: days.map((day) => {
      const k = cellKey(student.id, day.record_date);
      const submission = board.submissions.get(k) ?? null;
      return {
        day,
        submission,
        excuse: board.excuses.get(k) ?? null,
        state: submitState({ day, student, exempt: board.exemptions.has(k), submission, now }),
      };
    }),
  })), [students, days, board, now]);

  const footer = useMemo(() => days.map((day) => summarize(dayRows(day, students, board, now), day)), [days, students, board, now]);

  if (!data.term) return <div className="card">운영 기간을 먼저 설정해 주세요.</div>;

  function exportCsv() {
    const header = ['학번', '이름', '기록일', '제출 상태', '확인 상태', '최초 접수 시각(KST)', '최근 이미지 변경(KST)', '학생 입력 사용시간(분)', '학생 메모', '사유 요청', '사유 처리'];
    const rows: unknown[][] = [header];
    for (const g of grid) {
      for (const c of g.cells) {
        rows.push([
          g.student.student_no,
          g.student.name,
          c.day.record_date,
          STATE_LABEL[c.state],
          c.submission ? REVIEW_LABEL[c.submission.review_status] : '',
          c.submission ? fmtDateTime(Date.parse(c.submission.first_submitted_at)) : '',
          c.submission && c.submission.image_version > 1 ? fmtDateTime(Date.parse(c.submission.image_updated_at)) : '',
          c.submission?.self_minutes ?? '',
          c.submission?.student_note ?? '',
          c.excuse ? `${EXCUSE_LABEL[c.excuse.reason]}${c.excuse.note ? ` - ${c.excuse.note}` : ''}` : '',
          c.excuse ? { pending: '대기', approved: '승인', declined: '미승인' }[c.excuse.status] : '',
        ]);
      }
    }
    downloadBlob(toCsv(rows), `상태요약_${data.term!.name}_${new Date(now).toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div className="stack">
      <div className="row between">
        <div className="stack" style={{ gap: 2 }}>
          <h1>기간 한눈에</h1>
          <span className="small muted">{data.term.name} · {students.length}명 × {days.length}일 · 칸을 누르면 그날 이미지와 상태를 엽니다</span>
        </div>
        <button className="btn" onClick={exportCsv}>상태 요약 CSV</button>
      </div>
      <div className="legend">{LEGEND.map((s) => <StateChip key={s} state={s} />)}<span className="small muted">✓ 확인 완료 · ! 수정 요청 · ✉ 사유</span></div>
      <p className="xs muted">표가 화면보다 넓으면 표 안에서 좌우로 밀어 보세요. 학번·이름 열과 날짜 머리글은 고정됩니다.</p>

      <div className="grid-wrap" tabIndex={0} aria-label="학생×날짜 누적 제출표">
        <table className="grid">
          <thead>
            <tr>
              <th className="sticky-col">학번 이름</th>
              {days.map((d) => (
                <th key={d.record_date} className={d.is_target ? '' : 'excluded'} title={d.note ?? undefined}>
                  {fmtShortDate(d.record_date)}<br /><span className="xs">{weekday(d.record_date)}{d.is_target ? '' : '·제외'}</span>
                </th>
              ))}
              <th>접수/대상</th>
            </tr>
          </thead>
          <tbody>
            {grid.map((g) => {
              const target = g.cells.filter((c) => !['not_target', 'exempt', 'scheduled', 'waiting'].includes(c.state)).length;
              const received = g.cells.filter((c) => c.state === 'on_time' || c.state === 'late').length;
              return (
                <tr key={g.student.id}>
                  <th className="sticky-col" scope="row">
                    <span className="mono">{g.student.student_no}</span> {g.student.name}
                    {!g.student.active && <span className="xs faint"> (비활성)</span>}
                  </th>
                  {g.cells.map((c) => {
                    const mark = c.submission?.review_status === 'checked' ? '✓' : c.submission?.review_status === 'revision_requested' ? '!' : '';
                    const clickable = c.state !== 'not_target' || !!c.submission;
                    return (
                      <td key={c.day.record_date}>
                        <button
                          className={`st-${c.state}`}
                          disabled={!clickable}
                          onClick={() => setOpen({ student: g.student, date: c.day.record_date })}
                          aria-label={`${g.student.name} ${c.day.record_date} ${STATE_LABEL[c.state]}`}
                        >
                          {STATE_SHORT[c.state]}{mark && ` ${mark}`}
                          {c.excuse && <span className="dot">✉ 사유</span>}
                        </button>
                      </td>
                    );
                  })}
                  <td className="mono small">{received}/{target}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky-col small">접수 / 대상</td>
              {footer.map((s, i) => (
                <td key={days[i].record_date} className="mono small">{days[i].is_target ? `${s.received}/${s.target}` : '－'}</td>
              ))}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="xs muted">학생별 '접수/대상'은 마감이 지난 대상일 기준이며 순위·점수가 아닙니다. 대상 수는 면제·미대상·마감 전 날짜를 뺀 값입니다.</p>

      {open && <CellModal student={open.student} date={open.date} onClose={() => setOpen(null)} />}
    </div>
  );
}
