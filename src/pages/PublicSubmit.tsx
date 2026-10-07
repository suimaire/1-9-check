// 공개 제출 화면(학생 로그인 없음): 학번 → 사진 1~3장 선택(썸네일·삭제) → 제출 → 학번 확인 → 사진 세트 제출.
// 브라우저는 submit 함수만 호출하고, 학번·날짜·파일 검증과 제출 판정은 서버가 한다.
// 학번만으로 학생 이름이나 제출 여부를 조회하지 않는다. '이미 냈음' 표시는 이 기기의 기록으로만 한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useApp, useBackend } from '../app/context.tsx';
import { DemoBar, ErrorBanner, Spinner, TopBar, useAsync } from '../components/ui.tsx';
import { renderSyntheticScreenshot } from '../lib/backend/demoData.ts';
import { BackendError, type PublicInfo, type PublicSubmitResult } from '../lib/backend/types.ts';
import { fmtBytes, ImageError, prepareImage, type PreparedImage } from '../lib/image.ts';
import { MAX_IMAGES } from '../lib/types.ts';
import { addDays, fmtDate, fmtDateTime, kstDateOf } from '../lib/kst.ts';
import {
  getLastStudentNo, getReceipt, getToken, saveLastStudentNo, saveReceipt, saveToken, STUDENT_NOS,
} from '../lib/localReceipt.ts';
import { errorMessage } from '../lib/messages.ts';
import { createTrackedUrl, revokeUrl } from '../lib/objectUrls.ts';

const TITLE = '1-9 체크';
const SUBTITLE = '시험기간 스크린타임 인증';

interface Picked {
  id: string;
  image: PreparedImage;
  url: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'sending' }
  | { kind: 'done'; result: PublicSubmitResult; studentNo: string }
  | { kind: 'failed'; error: unknown };

export default function PublicSubmit() {
  const backend = useBackend();
  const { demo } = useApp();
  const { data: info, error, loading, reload } = useAsync(() => backend.publicInfo(), [backend]);
  useEffect(() => demo?.subscribe(reload), [demo, reload]);

  return (
    <>
      <DemoBar />
      <TopBar title={info?.app_title || TITLE} subtitle={info?.app_subtitle || SUBTITLE} />
      <main className="page narrow stack">
        {loading && !info ? <Spinner /> : error ? <ErrorBanner error={error} onRetry={reload} /> : info ? <Body info={info} /> : null}
        <p className="xs faint center-text"><Link to="/teacher" className="faint">담임 화면</Link></p>
      </main>
    </>
  );
}

function useClock(info: PublicInfo): number {
  const offset = useMemo(() => Date.parse(info.server_now) - Date.now(), [info]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30 * 1000);
    return () => clearInterval(t);
  }, []);
  return Date.now() + offset;
}

function Body({ info }: { info: PublicInfo }) {
  const now = useClock(info);
  if (!info.ready || !info.term) {
    return <div className="card">지금은 제출 기간이 아닙니다. 담임 선생님 안내를 기다려 주세요.</div>;
  }
  if (info.open_days.length === 0) {
    const next = info.next_day;
    return (
      <div className="card stack">
        <h2>{info.term.name}</h2>
        <p>지금 제출할 기록이 없습니다.</p>
        {next && (
          <p className="muted small">
            다음 제출: {fmtDate(next.record_date)} 사용 기록을 {fmtDateTime(Date.parse(next.window_open_at))}부터 {fmtDateTime(Date.parse(next.deadline_at))}까지 냅니다.
          </p>
        )}
      </div>
    );
  }
  return <SubmitForm info={info} now={now} />;
}

function SubmitForm({ info, now }: { info: PublicInfo; now: number }) {
  const backend = useBackend();
  const isDemo = backend.mode === 'demo';
  const days = info.open_days;
  const [studentNo, setStudentNo] = useState(getLastStudentNo);
  const [recordDate, setRecordDate] = useState(days[0].record_date);
  const [showErrors, setShowErrors] = useState(false);
  // 선택한 사진(선택한 순서 = 사진 1·2·3). 학번 확인창에서 '수정할게요'를 눌러도 그대로 둔다.
  const [picked, setPicked] = useState<Picked[]>([]);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [pickError, setPickError] = useState<string | null>(null);
  const [hours, setHours] = useState('');
  const [mins, setMins] = useState('');
  const [note, setNote] = useState('');
  const [, setSaved] = useState(0);
  // 같은 학번·날짜·사진 세트의 재시도는 같은 request_id로 보내 중복 접수를 막는다
  const pending = useRef<{ requestId: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const noInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => pickedRef.current.forEach((p) => revokeUrl(p.url)), []);

  const day = days.find((d) => d.record_date === recordDate) ?? days[0];
  const validNo = STUDENT_NOS.has(studentNo);
  const noError = (/\D/.test(studentNo) || (studentNo.length >= 5 && !validNo) || (showErrors && !validNo))
    ? '1-9반 학번을 확인해 주세요.' : null;
  const receipt = validNo ? getReceipt(studentNo, day.record_date) : null;
  const token = validNo ? getToken(studentNo, day.record_date) : null;
  const beforeDeadline = now <= Date.parse(day.deadline_at);
  const yesterday = addDays(kstDateOf(now), -1) === day.record_date;

  const selfMinutes = useMemo(() => {
    if (hours.trim() === '' && mins.trim() === '') return { value: null as number | null, valid: true };
    const h = hours.trim() === '' ? 0 : Number(hours);
    const m = mins.trim() === '' ? 0 : Number(mins);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return { value: null, valid: false };
    const total = h * 60 + m;
    return { value: total, valid: total <= 1440 };
  }, [hours, mins]);

  function resetAttempt() {
    pending.current = null;
    if (phase.kind === 'failed' || phase.kind === 'done') setPhase({ kind: 'idle' });
  }

  // 한 번에 여러 장 또는 한 장씩 여러 번 추가. 합계 3장을 넘기면 아무것도 추가하지 않고 알려 준다.
  async function accept(files: File[]) {
    setPickError(null);
    if (files.length === 0) return;
    const room = MAX_IMAGES - picked.length;
    if (files.length > room) {
      setPickError(`사진은 최대 ${MAX_IMAGES}장까지 제출할 수 있습니다.${room > 0 ? ` 지금은 ${room}장만 더 추가할 수 있어요.` : ''}`);
      return;
    }
    setPhase({ kind: 'preparing' });
    const added: Picked[] = [];
    let failure: string | null = null;
    for (const file of files) {
      try {
        const image = await prepareImage(file);
        added.push({ id: crypto.randomUUID(), image, url: createTrackedUrl(image.blob) });
      } catch (err) {
        failure = err instanceof ImageError ? err.message : '이미지를 처리하지 못했습니다.';
      }
    }
    if (added.length) {
      setPicked((prev) => [...prev, ...added]);
      pending.current = null; // 사진 세트가 바뀌면 새 제출 시도
    }
    if (failure) setPickError(added.length ? `일부 사진을 추가하지 못했습니다. ${failure}` : failure);
    setPhase({ kind: 'idle' });
  }

  function remove(id: string) {
    const target = picked.find((p) => p.id === id);
    if (target) revokeUrl(target.url);
    setPicked((prev) => prev.filter((p) => p.id !== id));
    setPickError(null);
    resetAttempt();
  }

  async function makeSynthetic() {
    const blob = await renderSyntheticScreenshot(`데모 ${studentNo || '학번'}`, day.record_date, 120 + Math.floor(Math.random() * 200), picked.length + 1);
    await accept([new File([blob], 'synthetic.png', { type: 'image/png' })]);
  }

  // 제출 전 학번 확인: 기존 검증을 통과한 경우에만 확인창을 띄운다
  function askConfirm() {
    if (!validNo) return setShowErrors(true);
    if (picked.length === 0 || inFlight.current || !selfMinutes.valid || note.length > 100) return;
    setConfirming(true);
  }

  function cancelConfirm() {
    setConfirming(false);
    noInput.current?.focus();
  }

  async function submit() {
    setConfirming(false);
    if (!validNo) return setShowErrors(true);
    if (picked.length === 0 || picked.length > MAX_IMAGES || inFlight.current || !selfMinutes.valid || note.length > 100) return;
    inFlight.current = true;
    const key = `${studentNo}|${day.record_date}`;
    if (pending.current?.key !== key) pending.current = { requestId: crypto.randomUUID(), key };
    const p = pending.current;
    const no = studentNo;
    setPhase({ kind: 'sending' });
    try {
      const result = await backend.publicSubmit({
        studentNo: no, recordDate: day.record_date, requestId: p.requestId,
        images: picked.map((x) => ({ blob: x.image.blob, mime: x.image.mime })),
        token: getToken(no, day.record_date), selfMinutes: selfMinutes.value, note: note.trim() || null,
      });
      if (result.replacement_token) saveToken(no, result.record_date, result.replacement_token);
      saveReceipt(no, result.record_date, { firstSubmittedAt: result.first_submitted_at, late: result.late, version: result.version });
      saveLastStudentNo(no);
      pending.current = null;
      picked.forEach((x) => revokeUrl(x.url));
      setPicked([]);
      setPhase({ kind: 'done', result, studentNo: no });
      setSaved((x) => x + 1);
    } catch (err) {
      // 응답을 못 받은 경우만 같은 요청으로 다시 시도한다(서버가 같은 결과를 돌려준다)
      if (!(err instanceof BackendError && (err.network || err.code === 'server_error'))) pending.current = null;
      setPhase({ kind: 'failed', error: err });
    } finally {
      inFlight.current = false;
    }
  }

  const busy = phase.kind === 'preparing' || phase.kind === 'sending';
  const isReplace = !!receipt && !!token;

  return (
    <>
      <section className="card stack" aria-label="스크린타임 제출">
        <label className="field">
          학번
          <input
            ref={noInput}
            type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={5} placeholder="예: 10901"
            value={studentNo} disabled={busy} aria-invalid={!!noError}
            onChange={(e) => { setStudentNo(e.target.value.replace(/\s/g, '')); resetAttempt(); }}
            onBlur={() => studentNo && setShowErrors(true)}
            style={{ fontSize: 22, letterSpacing: 2 }}
          />
          {noError && <span className="small" role="alert" style={{ color: 'var(--danger)' }}>{noError}</span>}
        </label>

        {days.length > 1 ? (
          <label className="field">
            기록 날짜
            <select value={day.record_date} disabled={busy} onChange={(e) => { setRecordDate(e.target.value); resetAttempt(); }}>
              {days.map((d, i) => (
                <option key={d.record_date} value={d.record_date}>{fmtDate(d.record_date)} 사용 기록{i === 0 ? ' (가장 최근)' : ''}</option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="stack" style={{ gap: 2 }}>
          <span className="strong">{fmtDate(day.record_date)} 사용 기록{yesterday ? ' (어제)' : ''}</span>
          <span className="small muted">
            마감 {fmtDateTime(Date.parse(day.deadline_at))} · {beforeDeadline ? <span className="chip st-waiting">마감 전</span> : <span className="chip st-late">마감 지남 · 지금 내면 지각 접수</span>}
          </span>
        </div>

        {phase.kind === 'done' && (
          <div className="banner ok" role="status">
            <strong>{phase.result.replayed ? '이미 접수된 제출입니다.' : phase.result.replaced ? '사진이 교체되었습니다.' : '접수되었습니다.'}</strong>
            <p className="small">
              {phase.studentNo} · {fmtDate(phase.result.record_date)} 기록{phase.result.image_count ? ` · 사진 ${phase.result.image_count}장` : ''} · 최초 접수 {fmtDateTime(Date.parse(phase.result.first_submitted_at))} · {phase.result.late ? '지각 접수' : '정시 접수'}
            </p>
            <p className="xs">파일 접수 확인일 뿐, 사용 시간 내용을 자동 검증한 것은 아닙니다.</p>
          </div>
        )}
        {phase.kind !== 'done' && receipt && (
          <div className="banner info small">
            이 기기에서 {fmtDate(day.record_date)} 기록을 이미 제출했습니다 (최초 접수 {fmtDateTime(Date.parse(receipt.firstSubmittedAt))} · {receipt.late ? '지각' : '정시'}).
            {token ? ' 사진을 다시 골라 제출하면 사진 전체가 새 사진으로 교체됩니다.' : ' 교체하려면 담임 선생님께 알려 주세요.'}
          </div>
        )}

        <div className="stack" style={{ gap: 8 }}>
          <div className="row between">
            <span className="strong">스크린타임 사진</span>
            <span className="small muted">{picked.length}/{MAX_IMAGES}장</span>
          </div>
          {isDemo && picked.length === 0 && (
            <div className="banner info small">데모에서는 개인 사진을 받지 않습니다. 합성 이미지로 제출 흐름을 체험합니다.</div>
          )}
          {picked.length === 0 ? (
            isDemo ? (
              <button className="btn lg block" onClick={() => void makeSynthetic()} disabled={busy}>합성 스크린샷 만들기</button>
            ) : (
              <label className="picker" style={{ position: 'relative' }}>
                <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy}
                  onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void accept(fs); }} />
                <strong>사진 선택</strong>
                <span className="small muted">최대 {MAX_IMAGES}장 · 여러 장을 한 번에 골라도 됩니다</span>
              </label>
            )
          ) : (
            <div className="pick-grid">
              {picked.map((p, i) => (
                <div key={p.id} className="pick-item">
                  <img src={p.url} alt={`사진 ${i + 1} 미리보기`} />
                  <span className="thumb-no">{i + 1}</span>
                  <button type="button" className="pick-remove" aria-label={`사진 ${i + 1} 삭제`} disabled={busy} onClick={() => remove(p.id)}>×</button>
                </div>
              ))}
              {picked.length < MAX_IMAGES && (
                isDemo ? (
                  <button type="button" className="pick-add" disabled={busy} onClick={() => void makeSynthetic()}>
                    <span style={{ fontSize: 28 }} aria-hidden="true">+</span><span className="small">합성 사진 추가</span>
                  </button>
                ) : (
                  <label className="pick-add" aria-disabled={busy}>
                    <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy}
                      onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void accept(fs); }} />
                    <span style={{ fontSize: 28 }} aria-hidden="true">+</span>
                    <span className="small">사진 추가</span>
                  </label>
                )
              )}
            </div>
          )}
          <ul className="xs muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>첫 번째 사진은 하루 전체 사용 시간 화면을 권장합니다.</li>
            <li>앱별 사용 시간 등 추가 화면은 필요하면 더 올려 주세요. 최대 {MAX_IMAGES}장까지 제출할 수 있습니다.</li>
            <li>개인 메시지·알림 내용 등 불필요한 개인정보는 가리고 제출해도 됩니다.</li>
          </ul>
        </div>
        {phase.kind === 'preparing' && <Spinner label="사진 준비 중(위치 정보 제거·압축)" />}
        {pickError && <div className="banner error" role="alert">{pickError}</div>}

        {picked.length > 0 && (
          <div className="stack">
            <p className="xs muted">
              제출본 {fmtBytes(picked.reduce((n, p) => n + p.image.blob.size, 0))} · 글자가 흐린 사진은 ×로 지우고 다시 추가하세요. 사진 위치·기기 정보 같은 부가 정보는 제거되었습니다.
            </p>

            <details className="fold">
              <summary>선택 입력 (총 사용 시간·한 줄 메모)</summary>
              <div>
                <div className="stack" style={{ gap: 6 }}>
                  <span className="small strong">총 사용 시간 (선택)</span>
                  <div className="row">
                    <input type="number" inputMode="numeric" min={0} max={24} placeholder="시간" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 96 }} aria-label="시간" />
                    <span>시간</span>
                    <input type="number" inputMode="numeric" min={0} max={59} placeholder="분" value={mins} onChange={(e) => setMins(e.target.value)} style={{ width: 96 }} aria-label="분" />
                    <span>분</span>
                  </div>
                  {!selfMinutes.valid && <span className="small" style={{ color: 'var(--danger)' }}>0분~24시간 사이로 입력해 주세요.</span>}
                </div>
                <label className="field">
                  선생님께 한 줄 남기기 <span className="hint">{note.length}/100</span>
                  <input type="text" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
              </div>
            </details>

            {phase.kind === 'failed' && (
              <div className="banner error" role="alert">
                {phase.error instanceof BackendError && phase.error.network ? (
                  <>
                    <strong>접수 확인을 받지 못했습니다.</strong>
                    <p className="small">'다시 시도'를 누르면 같은 제출로 확인되어 중복 접수되지 않습니다.</p>
                  </>
                ) : (
                  <>
                    <strong>접수되지 않았습니다.</strong>
                    <p className="small">{errorMessage(phase.error)}</p>
                  </>
                )}
              </div>
            )}

            <div className="submit-bar stack" style={{ gap: 8 }}>
              <button className="btn primary lg block" onClick={askConfirm} disabled={busy || !selfMinutes.valid}>
                {phase.kind === 'sending' ? '제출 중…' : phase.kind === 'failed' ? '다시 시도' : isReplace ? `사진 ${picked.length}장으로 교체` : `사진 ${picked.length}장 제출하기`}
              </button>
            </div>
          </div>
        )}
      </section>

      {confirming && <ConfirmStudentNo studentNo={studentNo} disabled={busy} onCancel={cancelConfirm} onConfirm={() => void submit()} />}

      <details className="fold">
        <summary>어떤 화면을 올리나요?</summary>
        <div>
          {info.term?.instructions && <p className="small">{info.term.instructions}</p>}
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>대표 스마트폰 1대의 <strong>전날 하루 전체(00:00~23:59)</strong> 기록 화면을 첫 번째 사진으로 올립니다.</li>
            <li><strong>날짜와 총 사용 시간</strong>이 잘 보이는지 확인해 주세요.</li>
            <li>앱 목록·알림 등은 휴대폰 사진 편집(자르기·가리기)으로 가린 뒤 올려도 됩니다.</li>
            <li>iPhone: 설정 › 스크린 타임 › 모든 활동 보기(일). Android: 설정 › 디지털 웰빙 및 자녀 보호 기능.</li>
          </ul>
        </div>
      </details>
    </>
  );
}

function ConfirmStudentNo({ studentNo, disabled, onCancel, onConfirm }: {
  studentNo: string; disabled: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onCancel]);
  return (
    <div className="modal-backdrop centered" onClick={onCancel}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-no-title" aria-describedby="confirm-no-body"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-no-title">학번을 확인해 주세요</h2>
        <p id="confirm-no-body">입력한 학번이 <strong className="confirm-no">{studentNo}</strong>이 맞나요?</p>
        <div className="confirm-actions">
          <button className="btn lg" onClick={onCancel}>아니요, 수정할게요</button>
          <button className="btn primary lg" onClick={onConfirm} disabled={disabled} autoFocus>네, 맞아요</button>
        </div>
      </div>
    </div>
  );
}
