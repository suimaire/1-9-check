import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useBackend } from '../../app/context.tsx';
import { AuthImage, ErrorBanner, ReviewChip, StateChip, useAsync } from '../../components/ui.tsx';
import { addDays, fmtDate, fmtDateTime, fmtShortDate, fmtShortDateTime, fmtTime, kstDateOf } from '../../lib/kst.ts';
import { cellKey, consecutiveMissingCount, STATE_LABEL, STREAK_MIN, submitState } from '../../lib/status.ts';
import { EXCUSE_LABEL, type Student } from '../../lib/types.ts';
import { CellModal } from './CellModal.tsx';
import { useTeacher } from './TeacherLayout.tsx';

export default function StudentDetail() {
  const { id } = useParams();
  const { data, board, now, reload } = useTeacher();
  const student = data.students.find((s) => s.id === id);
  const [open, setOpen] = useState<{ date: string; image: number } | null>(null);
  const setOpenDate = (date: string) => setOpen({ date, image: 0 });

  if (!student) return <div className="card">학생을 찾을 수 없습니다. <Link to="/teacher/roster">명단으로</Link></div>;
  const term = data.term;
  const streak = consecutiveMissingCount(student, data.days, board, now);

  return (
    <div className="stack">
      <div className="row between">
        <div className="stack" style={{ gap: 2 }}>
          <h1>{student.student_no} {student.name}</h1>
          <span className="small muted">
            {student.active ? '활성 · 학번으로 제출' : `비활성(제출 거절)${student.roster_until ? ` · 대상 마지막 날 ${student.roster_until}` : ''}`}
          </span>
        </div>
        <div className="row">
          {term && streak >= STREAK_MIN && <span className="chip flag" title="현재 시각 기준, 마감이 지난 수집 대상일을 최근부터 거슬러 센 연속 미제출 일수(면제·수집 제외·마감 전 날짜는 건너뜀)">{streak}일 연속 미제출</span>}
          <Link className="btn sm" to="/teacher">현황으로</Link>
        </div>
      </div>

      {term && <CompareSection student={student} onOpen={(date, image) => setOpen({ date, image })} />}

      {term ? (
        <section className="card stack">
          <h2>날짜별 기록</h2>
          <div className="table-wrap">
            <table className="list">
              <thead><tr><th>기록일</th><th>제출 상태</th><th className="hide-sm">최초 접수</th><th>확인</th><th>사유·메모</th></tr></thead>
              <tbody>
                {[...data.days].reverse().map((day) => {
                  const k = cellKey(student.id, day.record_date);
                  const sub = board.submissions.get(k) ?? null;
                  const ex = board.excuses.get(k) ?? null;
                  const state = submitState({ day, student, exempt: board.exemptions.has(k), submission: sub, now });
                  return (
                    <tr key={day.record_date} className="clickable" onClick={() => setOpenDate(day.record_date)}>
                      <td className="nowrap">{fmtDate(day.record_date)}</td>
                      <td className="nowrap"><StateChip state={state} />{sub && <span className="xs muted"> 사진 {sub.images.length}장</span>}</td>
                      <td className="hide-sm mono small nowrap">{sub ? fmtShortDateTime(Date.parse(sub.first_submitted_at)) : '–'}</td>
                      <td>{sub ? <ReviewChip status={sub.review_status} /> : <span className="faint">–</span>}</td>
                      <td className="small">
                        {ex && <div>사유: {EXCUSE_LABEL[ex.reason]}{ex.note ? ` · ${ex.note}` : ''}</div>}
                        {sub?.student_note && <div className="muted">메모: {sub.student_note}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : <div className="card">운영 기간이 없습니다.</div>}

      {term && <ExemptionForm studentId={student.id} termId={term.id} start={term.start_date} last={term.last_record_date} onDone={reload} />}
      {term && <NotesPanel studentId={student.id} termId={term.id} />}
      <ActivePanel studentId={student.id} active={student.active} now={now} onDone={reload} />

      {open && <CellModal key={`${open.date}:${open.image}`} student={student} date={open.date} initialImage={open.image} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * 사용 기록 비교: 한 학생의 최근 7일/14일 원본 사진을 날짜별로 나란히 놓는다(왼쪽이 오래된 날).
 * 사진 k번은 같은 줄에 맞춰 보이고, 미제출·면제 날짜도 빈 칸으로 남겨 날짜 흐름을 유지한다.
 * 자동 분석·점수·평가는 하지 않는다. 사진은 이 화면에서 보이는 칸만 내려받는다.
 */
function CompareSection({ student, onOpen }: { student: Student; onOpen: (date: string, image: number) => void }) {
  const { data, board, now } = useTeacher();
  const [span, setSpan] = useState<7 | 14>(7);
  const scroller = useRef<HTMLDivElement>(null);
  // 하루가 끝나 제출 창이 열린 날짜까지만(오늘처럼 아직 끝나지 않은 날 제외)
  const days = data.days.filter((d) => now >= Date.parse(d.window_open_at)).slice(-span);
  const cells = days.map((day) => {
    const k = cellKey(student.id, day.record_date);
    const sub = board.submissions.get(k) ?? null;
    return { day, sub, state: submitState({ day, student, exempt: board.exemptions.has(k), submission: sub, now }) };
  });
  const rows = Math.max(1, ...cells.map((c) => c.sub?.images.length ?? 0));

  // 가장 최근 날짜가 보이도록 오른쪽 끝으로
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [span, days.length]);

  return (
    <section className="card stack">
      <div className="row between">
        <h2>사용 기록 비교</h2>
        <div className="filters" role="group" aria-label="비교 기간">
          {([7, 14] as const).map((n) => (
            <button key={n} aria-pressed={span === n} onClick={() => setSpan(n)}>최근 {n}일</button>
          ))}
        </div>
      </div>
      {cells.length === 0 ? (
        <p className="small muted">아직 비교할 날짜가 없습니다.</p>
      ) : (
        <div className="compare" ref={scroller} style={{ ['--rows' as string]: rows }}>
          {cells.map(({ day, sub, state }) => (
            <div key={day.record_date} className="cmp-col">
              <div className="cmp-head">
                <strong>{fmtShortDate(day.record_date)}</strong>
                <StateChip state={state} short />
                <span className="xs muted">{sub ? `사진 ${sub.images.length}장 · ${fmtTime(Date.parse(sub.first_submitted_at))}` : ' '}</span>
              </div>
              {sub ? (
                Array.from({ length: rows }, (_, i) => {
                  const img = sub.images[i];
                  return img ? (
                    <button key={img.path} type="button" className="cmp-thumb" onClick={() => onOpen(day.record_date, i)}
                      aria-label={`${fmtDate(day.record_date)} 사진 ${i + 1}/${sub.images.length} 크게 보기`}>
                      <AuthImage path={img.path} alt="" lazy />
                      <span className="thumb-no">{i + 1}</span>
                    </button>
                  ) : <div key={i} className="cmp-empty" aria-hidden="true">–</div>;
                })
              ) : (
                <div className="cmp-blank">{STATE_LABEL[state]}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="xs muted">학생이 올린 원본 사진을 날짜별로 나란히 보여 줍니다. 사진을 누르면 크게 볼 수 있습니다. 사용 시간을 자동으로 판정하거나 점수화하지 않습니다.</p>
    </section>
  );
}

function ExemptionForm({ studentId, termId, start, last, onDone }: { studentId: string; termId: string; start: string; last: string; onDone: () => void }) {
  const backend = useBackend();
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(start);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function apply(exempt: boolean) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const n = await backend.setExemptions(termId, studentId, from, to, exempt, reason);
      setMsg(exempt ? `${n}일을 면제로 지정했습니다.` : `${n}일의 면제를 취소했습니다.`);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>면제 지정·취소</h2>
      <p className="small muted">교사가 승인한 날짜만 제출 분모와 미제출 집계에서 빠집니다. 사유 요청·결석만으로 자동 면제되지 않습니다. 이미 접수된 이미지는 지우지 않고 열람할 수 있게 남깁니다.</p>
      <div className="row">
        <label className="field">시작일<input type="date" min={start} max={last} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">종료일<input type="date" min={start} max={last} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field grow">사유(교사용)<input type="text" maxLength={100} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 체험학습" /></label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || to < from} onClick={() => void apply(true)}>기간 면제 지정</button>
        <button className="btn danger" disabled={busy || to < from} onClick={() => void apply(false)}>기간 면제 취소</button>
      </div>
      {msg && <div className="banner ok small">{msg}</div>}
      <ErrorBanner error={error} />
    </section>
  );
}

function NotesPanel({ studentId, termId }: { studentId: string; termId: string }) {
  const backend = useBackend();
  const { data: notes, error, reload } = useAsync(() => backend.listNotes(studentId, termId), [backend, studentId, termId]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      await backend.addNote(studentId, termId, null, body.trim());
      setBody('');
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="row between">
        <h2>교사 지도 메모</h2>
        <span className="chip neutral">학생에게 보이지 않음</span>
      </div>
      <p className="xs muted">별도 테이블에 저장되며 학생 제출 화면에서는 조회할 수 없습니다. 상태 요약 CSV에도 포함되지 않습니다.</p>
      <textarea maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="예: 10/14 개별 상담. 취침 전 휴대폰 사용 줄이기로 약속." />
      <button className="btn" disabled={busy || !body.trim()} onClick={() => void add()}>메모 저장</button>
      <ErrorBanner error={error ?? err} />
      {(notes ?? []).map((n) => (
        <div key={n.id} className="card tight stack" style={{ gap: 4 }}>
          <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
          <div className="row between">
            <span className="xs muted">{fmtDateTime(Date.parse(n.created_at))}{n.record_date ? ` · ${n.record_date} 관련` : ''}</span>
            <button className="btn sm ghost" onClick={() => void backend.deleteNote(n.id).then(reload, setErr)}>삭제</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function ActivePanel({ studentId, active, now, onDone }: { studentId: string; active: boolean; now: number; onDone: () => void }) {
  const backend = useBackend();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [until, setUntil] = useState(addDays(kstDateOf(now), -1));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>명단 상태</h2>
      {active ? (
        <div className="row">
          <label className="field">대상 마지막 기록일<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          <button className="btn danger" disabled={busy} onClick={() => void run(() => backend.setStudentActive(studentId, false, until))}>비활성화</button>
          <span className="small muted">기록은 지우지 않으며, 지정한 날짜 이후만 제출 대상에서 빠집니다. 비활성 학번은 제출이 거절됩니다.</span>
        </div>
      ) : (
        <button className="btn" disabled={busy} onClick={() => void run(() => backend.setStudentActive(studentId, true, null))}>다시 활성화</button>
      )}
      <ErrorBanner error={error} />
    </section>
  );
}
