import { useState } from 'react';
import { useBackend } from '../../app/context.tsx';
import { ErrorBanner } from '../../components/ui.tsx';
import type { PurgePreview, PurgeResult } from '../../lib/backend/types.ts';
import {
  addDays, dayWindow, fmtDate, fmtDateTime, fromKstLocalInput, hhmmToMinutes, isWeekend, kstDateOf, minutesToHHMM, toKstLocalInput,
} from '../../lib/kst.ts';
import type { Term } from '../../lib/types.ts';
import { useTeacher } from './TeacherLayout.tsx';

export default function Settings() {
  const { data } = useTeacher();
  const [creating, setCreating] = useState(!data.term);
  return (
    <div className="stack">
      <h1>운영 설정</h1>
      <TitleForm />
      <TermForm key={creating ? 'new' : data.term?.id} term={creating ? null : data.term} onCreated={() => setCreating(false)} />
      {data.term && !creating && (
        <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setCreating(true)}>+ 새 운영 기간 만들기</button>
      )}
      {creating && data.term && <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setCreating(false)}>새 운영 기간 만들기 취소</button>}
      {data.term && !creating && <CalendarEditor />}
      {data.term && !creating && <CleanupPanel />}
      {data.term && !creating && <PurgePanel />}
    </div>
  );
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, msg, run };
}

function TitleForm() {
  const backend = useBackend();
  const { data, reload } = useTeacher();
  const [title, setTitle] = useState(data.klass.app_title);
  const [subtitle, setSubtitle] = useState(data.klass.app_subtitle);
  const r = useRunner();
  return (
    <section className="card stack">
      <h2>앱 이름</h2>
      <div className="row">
        <label className="field grow">이름<input type="text" maxLength={30} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field grow">부제<input type="text" maxLength={40} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>
      </div>
      <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={r.busy || !title.trim()}
        onClick={() => void r.run(async () => { await backend.saveClassTitle(data.klass.id, title.trim(), subtitle.trim()); reload(); return '저장했습니다.'; })}>저장</button>
      {r.msg && <div className="banner ok small">{r.msg}</div>}
      <ErrorBanner error={r.error} />
    </section>
  );
}

function TermForm({ term, onCreated }: { term: Term | null; onCreated: () => void }) {
  const backend = useBackend();
  const { data, reload, setTermId } = useTeacher();
  const [name, setName] = useState(term?.name ?? '');
  const [start, setStart] = useState(term?.start_date ?? '');
  const [last, setLast] = useState(term?.last_record_date ?? '');
  const [deadline, setDeadline] = useState(minutesToHHMM(term?.deadline_minutes ?? 480));
  const [finalClose, setFinalClose] = useState(term ? toKstLocalInput(Date.parse(term.final_close_at)) : '');
  const [retention, setRetention] = useState(term?.retention_until ?? '');
  const [instructions, setInstructions] = useState(term?.instructions ?? '대표 스마트폰 1대의 하루 전체(00:00~23:59) 화면 시간 화면을 올려 주세요. 날짜와 총 사용 시간이 보이면 됩니다.');
  const r = useRunner();

  const minutes = hhmmToMinutes(deadline);
  const validRange = !!start && !!last && last >= start;
  const defaultFinal = validRange && minutes ? dayWindow(last, minutes).deadlineAt + 7 * 86400000 : null;
  const finalMs = finalClose ? fromKstLocalInput(finalClose) : defaultFinal;
  const defaultRetention = finalMs ? addDays(kstDateOf(finalMs), 30) : '';

  async function save() {
    if (!minutes || !validRange) throw new Error('날짜와 마감 시각을 확인해 주세요.');
    const id = await backend.saveTerm(data.klass.id, {
      termId: term?.id ?? null,
      name: name.trim(),
      startDate: start,
      lastRecordDate: last,
      deadlineMinutes: minutes,
      finalCloseAt: finalMs ? new Date(finalMs).toISOString() : null,
      retentionUntil: retention || defaultRetention || null,
      instructions: instructions.trim(),
    });
    if (!term) {
      setTermId(id);
      onCreated();
    }
    reload();
    return term ? '저장했습니다. 이미 제출 창이 열린 날짜의 마감은 바뀌지 않았습니다.' : '운영 기간을 만들었습니다.';
  }

  return (
    <section className="card stack">
      <h2>{term ? '운영 기간' : '새 운영 기간'}</h2>
      {!term && <div className="banner info small">실제 시험 일정에 맞춰 운영 시작일과 마지막 기록일을 직접 입력해 주세요. 앱이 임의로 정한 날짜는 없습니다.</div>}
      <label className="field">이름<input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 2학기 기말고사" /></label>
      <div className="row">
        <label className="field grow">운영 시작일(첫 기록일)<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field grow">마지막 기록일<input type="date" value={last} onChange={(e) => setLast(e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="field grow">
          다음 날 마감 시각 <span className="hint">기록일 다음 날 이 시각까지 (KST)</span>
          <input type="time" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="field grow">
          마지막 제출 허용 시각 <span className="hint">늦은 제출·교체 가능 끝 (KST)</span>
          <input type="datetime-local" value={finalClose || (defaultFinal ? toKstLocalInput(defaultFinal) : '')} onChange={(e) => setFinalClose(e.target.value)} />
        </label>
      </div>
      {defaultFinal && <p className="xs muted">기본값: 마지막 기록일 마감({fmtDateTime(dayWindow(last, minutes!).deadlineAt)})에서 7일 뒤. <button className="btn sm ghost" onClick={() => setFinalClose('')}>기본값으로</button></p>}
      <label className="field">
        보관 종료일 <span className="hint">예시 기본값: 마지막 제출 허용일 30일 뒤. 이 날이 지나면 알림만 표시하며 자동 삭제하지 않습니다.</span>
        <input type="date" value={retention || defaultRetention} onChange={(e) => setRetention(e.target.value)} />
      </label>
      <label className="field">학생 화면 제출 안내문<textarea maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
      {term && <p className="xs muted">마감 시각을 바꾸면 아직 제출 창이 열리지 않은 날짜에만 적용되어 기존 지각 판정은 바뀌지 않습니다.</p>}
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={r.busy || !name.trim() || !validRange || !minutes}
        onClick={() => void r.run(save)}>{term ? '저장' : '만들기'}</button>
      {r.msg && <div className="banner ok small">{r.msg}</div>}
      <ErrorBanner error={r.error} />
    </section>
  );
}

function CalendarEditor() {
  const backend = useBackend();
  const { data, now, reload } = useTeacher();
  const r = useRunner();
  return (
    <section className="card stack">
      <h2>운영 달력</h2>
      <p className="small muted">기본은 주말 포함 매일 제출입니다. 수집하지 않을 날짜는 체크를 해제하세요. 각 날짜의 마감은 서버에 고정 저장됩니다.</p>
      <div className="table-wrap" style={{ maxHeight: 420 }}>
        <table className="list">
          <thead><tr><th>기록일</th><th>수집 대상</th><th className="hide-sm">마감</th><th>메모</th></tr></thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.record_date}>
                <td className="nowrap" style={{ color: isWeekend(d.record_date) ? 'var(--primary)' : undefined }}>{fmtDate(d.record_date)}</td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={d.is_target} disabled={r.busy}
                      onChange={(e) => void r.run(async () => { await backend.setDayTarget(d.term_id, d.record_date, e.target.checked, d.note ?? ''); reload(); })} />
                    {d.is_target ? '대상' : '제외'}
                  </label>
                </td>
                <td className="hide-sm small nowrap">{fmtDateTime(Date.parse(d.deadline_at))}{Date.parse(d.window_open_at) <= now ? ' (고정)' : ''}</td>
                <td>
                  <input type="text" maxLength={40} defaultValue={d.note ?? ''} placeholder="예: 학교 행사" aria-label={`${d.record_date} 메모`}
                    onBlur={(e) => { if ((e.target.value || null) !== d.note) void r.run(async () => { await backend.setDayTarget(d.term_id, d.record_date, d.is_target, e.target.value); reload(); }); }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBanner error={r.error} />
    </section>
  );
}

function CleanupPanel() {
  const backend = useBackend();
  const { data } = useTeacher();
  const r = useRunner();
  return (
    <section className="card stack">
      <h2>이전 이미지 정리</h2>
      <p className="small muted">학생이 교체하기 전 이미지와 확정되지 않은 업로드(30분 지난 것)를 Storage에서 지웁니다. 현재 제출된 이미지와 접수 기록은 지우지 않습니다. 자동으로 실행되지 않으니 가끔 눌러 주세요.</p>
      <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={r.busy}
        onClick={() => void r.run(async () => {
          const res = await backend.cleanupImages(data.term!.id);
          return `대상 ${res.found}개 중 ${res.deleted}개 삭제${res.failed ? `, ${res.failed}개 실패(다시 눌러 재시도)` : ''}.`;
        })}>{r.busy ? '정리 중…' : '이전 이미지 정리'}</button>
      {r.msg && <div className="banner ok small">{r.msg}</div>}
      <ErrorBanner error={r.error} />
    </section>
  );
}

function PurgePanel() {
  const backend = useBackend();
  const { data, reload } = useTeacher();
  const term = data.term!;
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [result, setResult] = useState<PurgeResult | null>(null);
  const r = useRunner();

  return (
    <section className="card stack">
      <h2>자료 삭제</h2>
      <p className="small muted">
        보관 종료일: {term.retention_until ? fmtDate(term.retention_until) : '미설정'} · 자동 삭제 기능은 없습니다. 이 운영 기간의 제출 기록·이미지·사유·면제·교사 메모·운영 달력을 지웁니다. 학생 명단은 남습니다.
      </p>
      <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={r.busy}
        onClick={() => void r.run(async () => { setResult(null); setPreview(await backend.purgePreview(term.id)); })}>삭제 대상 확인</button>
      {preview && (
        <div className="banner warn stack">
          <strong>{preview.name} ({preview.start_date} ~ {preview.last_record_date})</strong>
          <p className="small">
            제출 {preview.submissions}건 · 제출 이력 {preview.submission_events}건 · 사유 {preview.excuse_requests}건 · 면제 {preview.exemptions}건 · 교사 메모 {preview.teacher_notes}건 · 운영 달력 {preview.term_days}일 · 이미지 {preview.objects}개
          </p>
          <p className="small">되돌릴 수 없습니다. 이미지(Storage)를 먼저 지우고, 모두 지워졌을 때만 DB 기록을 지웁니다.</p>
          <label className="field">확인을 위해 운영 기간 이름 '{preview.name}'을 입력하세요<input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></label>
          <button className="btn danger solid" style={{ alignSelf: 'flex-start' }} disabled={r.busy || confirmName !== preview.name}
            onClick={() => void r.run(async () => {
              const res = await backend.purgeExecute(term.id, confirmName);
              setResult(res);
              if (res.status === 'done') { setPreview(null); setConfirmName(''); reload(); }
            })}>{r.busy ? '삭제 중…' : '영구 삭제'}</button>
        </div>
      )}
      {result?.status === 'done' && <div className="banner ok small">삭제 완료: 이미지 {result.objects_deleted}개와 DB 기록을 지웠습니다.</div>}
      {result?.status === 'partial' && (
        <div className="banner error small">
          일부만 처리되었습니다(이미지 삭제 {result.objects_deleted}개, 실패 {result.objects_failed ?? 0}개{result.db_error ? `, DB 오류 ${result.db_error}` : ''}). DB 기록은 아직 남아 있습니다. '영구 삭제'를 다시 눌러 재시도하세요.
        </div>
      )}
      <ErrorBanner error={r.error} />
    </section>
  );
}
