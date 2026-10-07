import { useState } from 'react';
import { Link } from 'react-router';
import { useBackend } from '../../app/context.tsx';
import { ErrorBanner, Gallery, Modal, ReviewChip, StateChip } from '../../components/ui.tsx';
import { fmtBytes } from '../../lib/image.ts';
import { fmtDate, fmtDateTime, fmtMinutes } from '../../lib/kst.ts';
import { cellKey, submitState } from '../../lib/status.ts';
import { EXCUSE_LABEL, type ReviewStatus, type Student } from '../../lib/types.ts';
import { useTeacher } from './TeacherLayout.tsx';

/** 학생×날짜 한 칸: 사진 세트·접수 시각·확인 상태·사유·면제를 연다. 사진은 이 창을 열 때만 내려받는다. */
export function CellModal({ student, date, initialImage = 0, onClose }: {
  student: Student; date: string; initialImage?: number; onClose: () => void;
}) {
  const backend = useBackend();
  const { data, board, now, reload } = useTeacher();
  const day = data.days.find((d) => d.record_date === date)!;
  const k = cellKey(student.id, date);
  const submission = board.submissions.get(k) ?? null;
  const excuse = board.excuses.get(k) ?? null;
  const exempt = board.exemptions.has(k);
  const state = submitState({ day, student, exempt, submission, now });

  const [message, setMessage] = useState(submission?.review_status === 'revision_requested' ? submission.revision_message ?? '' : '');
  const [showRevision, setShowRevision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      reload();
    } catch (err) {
      setError(err);
      reload(); // 예: 학생이 그 사이 이미지를 교체했으면 최신 버전을 다시 보여준다
    } finally {
      setBusy(false);
    }
  }

  const review = (status: ReviewStatus) =>
    run(() => backend.reviewSubmission(submission!.id, submission!.image_version, status, message), status === 'checked' ? '확인 완료로 표시했습니다.' : status === 'revision_requested' ? '수정 요청을 보냈습니다.' : '미확인으로 되돌렸습니다.');

  return (
    <Modal title={`${student.student_no} ${student.name} · ${fmtDate(date)}`} onClose={onClose}>
      <div className="row" style={{ gap: 6 }}>
        <StateChip state={state} />
        {submission && <ReviewChip status={submission.review_status} />}
        {exempt && submission && <span className="chip neutral">면제 전 접수 이력 보존</span>}
        <span className="small muted">마감 {fmtDateTime(Date.parse(day.deadline_at))}</span>
      </div>

      {submission ? (
        <>
          <Gallery key={`${submission.id}:${submission.image_version}`} images={submission.images} alt={`${student.name} ${fmtDate(date)}`} initial={initialImage} />
          <p className="xs muted">사진을 누르면 원래 크기로 확대됩니다. 파일 접수일 뿐 사용량을 자동 검증한 것이 아닙니다.</p>
          <dl className="kv">
            <dt>최초 접수</dt><dd>{fmtDateTime(Date.parse(submission.first_submitted_at))}</dd>
            <dt>사진</dt><dd>사진 {submission.images.length}장 · {submission.image_version}번째 제출본 · {fmtDateTime(Date.parse(submission.image_updated_at))} · {fmtBytes(submission.images.reduce((n, i) => n + i.bytes, 0))}</dd>
            <dt>학생 입력 시간</dt><dd>{submission.self_minutes === null ? '입력 없음' : `${fmtMinutes(submission.self_minutes)} (학생 입력값)`}</dd>
            {submission.student_note && (<><dt>학생 메모</dt><dd>{submission.student_note}</dd></>)}
            {submission.revision_message && (<><dt>최근 수정 요청</dt><dd>{submission.revision_message}</dd></>)}
          </dl>
          <div className="card tight stack" style={{ gap: 6 }}>
            <div className="row between">
              <span className="small strong">다른 기기 재제출</span>
              {submission.resubmit_open && <span className="chip st-waiting">허용 중</span>}
            </div>
            <p className="xs muted">학생은 처음 제출한 기기에서만 사진을 교체할 수 있습니다(사진 세트 전체 교체). 다른 기기에서 다시 내야 하면 허용을 켜 주세요. 다음 1회 제출이 교체로 반영되고(최초 접수 시각 유지), 허용은 자동으로 꺼집니다. 켜 둔 동안에는 학번만 알면 누구나 교체할 수 있으니 필요할 때만 켭니다.</p>
            <div className="row">
              {submission.resubmit_open ? (
                <button className="btn sm" disabled={busy} onClick={() => void run(() => backend.allowResubmission(submission.id, false), '재제출 허용을 껐습니다.')}>허용 끄기</button>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => void run(() => backend.allowResubmission(submission.id, true), '다른 기기 재제출을 1회 허용했습니다.')}>재제출 허용</button>
              )}
            </div>
          </div>
          <div className="row">
            <button className="btn green" disabled={busy || submission.review_status === 'checked'} onClick={() => void review('checked')}>확인 완료</button>
            <button className="btn" disabled={busy} onClick={() => setShowRevision((v) => !v)}>수정 요청</button>
            {submission.review_status !== 'unchecked' && (
              <button className="btn ghost" disabled={busy} onClick={() => void review('unchecked')}>미확인으로</button>
            )}
          </div>
          {showRevision && (
            <div className="stack">
              <label className="field">
                수정 요청 내용 <span className="hint">{message.length}/200 · 학생 제출 화면에는 표시되지 않으니 직접 알려 주세요</span>
                <textarea maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="예: 날짜와 총 사용 시간이 함께 보이도록 다시 찍어 주세요." />
              </label>
              <button className="btn primary" disabled={busy || !message.trim()} onClick={() => void review('revision_requested')}>수정 요청 보내기</button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">접수된 사진이 없습니다.</p>
      )}

      {excuse && (
        <div className="card tight stack">
          <div className="row between">
            <strong>학생이 보낸 사유</strong>
            <span className="chip info">{excuse.status === 'pending' ? '승인 대기' : excuse.status === 'approved' ? '면제 승인' : '미승인'}</span>
          </div>
          <p>{EXCUSE_LABEL[excuse.reason]}{excuse.note ? ` · ${excuse.note}` : ''}</p>
          <p className="xs muted">전달 {fmtDateTime(Date.parse(excuse.updated_at))}</p>
          {excuse.status !== 'approved' && (
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(() => backend.resolveExcuse(excuse.id, true), '면제로 승인했습니다.')}>면제 승인</button>
              {excuse.status === 'pending' && (
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => backend.resolveExcuse(excuse.id, false), '미승인으로 표시했습니다.')}>미승인</button>
              )}
            </div>
          )}
        </div>
      )}

      {day.is_target && (
        <div className="row">
          {exempt ? (
            <button className="btn danger" disabled={busy} onClick={() => void run(() => backend.setExemptions(data.term!.id, student.id, date, date, false, ''), '면제를 취소했습니다.')}>이 날짜 면제 취소</button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => void run(() => backend.setExemptions(data.term!.id, student.id, date, date, true, '교사 지정'), '이 날짜를 면제했습니다.')}>이 날짜 면제</button>
          )}
          <Link className="btn ghost" to={`/teacher/students/${student.id}`} onClick={onClose}>학생 상세</Link>
        </div>
      )}

      {notice && <div className="banner ok small" role="status">{notice}</div>}
      <ErrorBanner error={error} />
    </Modal>
  );
}
