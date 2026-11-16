import { useEffect, useRef, useState } from 'react';
import { useBackend } from '../app/context.tsx';
import { Modal, Spinner } from '../components/ui.tsx';
import { renderSyntheticScreenshot } from '../lib/backend/demoData.ts';
import { BackendError, type PublicInfo } from '../lib/backend/types.ts';
import { ImageError, prepareImage, type PreparedImage } from '../lib/image.ts';
import { fmtDate, fmtDateTime } from '../lib/kst.ts';
import { getLastStudentNo, getReceipt, getToken, saveLastStudentNo, saveReceipt, saveToken, STUDENT_NOS } from '../lib/localReceipt.ts';
import { errorMessage } from '../lib/messages.ts';
import { createTrackedUrl, revokeUrl } from '../lib/objectUrls.ts';
import { MAX_IMAGES } from '../lib/types.ts';
import { weekendPairs, type WeekendPair } from '../lib/weekend.ts';
import { clearWeekendAttempts, loadWeekendAttempts, saveWeekendAttempts, submitWeekendDays, type WeekendAttempt } from '../lib/weekendSubmit.ts';

interface Picked { id: string; image: PreparedImage; url: string }
interface Draft { picked: Picked[]; minutes: string; error: string | null }
const emptyDraft = (): Draft => ({ picked: [], minutes: '', error: null });

export default function WeekendSubmit({ info, now }: { info: PublicInfo; now: number }) {
  const pairs = weekendPairs(info.open_days);
  const [selected, setSelected] = useState(pairs[0]?.saturday.record_date ?? '');
  const pair = pairs.find(p => p.saturday.record_date === selected) ?? pairs[0];
  if (!pair) return <p>지금 제출할 주말 기록이 없습니다.</p>;
  return <WeekendForm key={`${info.term?.id}:${pair.saturday.record_date}`} pair={pair} info={info} now={now}
    earlier={pairs} onSelect={setSelected} />;
}

function WeekendForm({ pair, info, now, earlier, onSelect }: {
  pair: WeekendPair; info: PublicInfo; now: number; earlier: WeekendPair[]; onSelect: (date: string) => void;
}) {
  const backend = useBackend();
  const [studentNo, setStudentNo] = useState(getLastStudentNo);
  const [drafts, setDrafts] = useState<Draft[]>([emptyDraft(), emptyDraft()]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const attempts = useRef<WeekendAttempt[]>([]);
  const tokens = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const inFlight = useRef(false);
  const picking = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [, redraw] = useState(0);
  const days = [pair.saturday, pair.sunday];
  const validNo = STUDENT_NOS.has(studentNo);
  const started = attempts.current.length > 0;
  const done = attempts.current.filter(a => a.result).length;
  const locked = busy || recovering || preparing !== null;
  const termId = info.term!.id!;
  const closed = now > Date.parse(info.term!.final_close_at);
  const validMinutes = (s: string) => s.trim() === '' || (/^\d+$/.test(s) && Number(s) <= 1440);
  const canSend = validNo && (!closed || started) && drafts.every((d, i) => !!attempts.current[i]?.result
    || (d.picked.length >= 1 && d.picked.length <= MAX_IMAGES && validMinutes(d.minutes)));
  const unknownResult = attempts.current.some(a => !a.result && (a.error instanceof BackendError
    ? a.error.network || a.error.code === 'server_error' : !!a.error));

  function persistResult(attempt: WeekendAttempt) {
    const result = attempt.result;
    if (result) {
      if (result.replacement_token) {
        tokens.current.set(result.record_date, result.replacement_token);
        saveToken(studentNo, result.record_date, result.replacement_token, termId);
      }
      saveReceipt(studentNo, result.record_date, { firstSubmittedAt: result.first_submitted_at, late: result.late, version: result.version }, termId);
      saveLastStudentNo(studentNo);
    }
    setStorageWarning(!saveWeekendAttempts(attempts.current));
    redraw(x => x + 1);
  }

  useEffect(() => {
    if (!validNo) return;
    const saved = loadWeekendAttempts(termId, studentNo, pair.saturday.record_date);
    if (!saved.length) return;
    let cancelled = false;
    attempts.current = saved;
    setDrafts(saved.map(a => ({ ...emptyDraft(), minutes: a.input.selfMinutes === null ? '' : String(a.input.selfMinutes) })));
    setRecovering(true);
    void (async () => {
      try {
        for (const attempt of saved) {
          if (cancelled) return;
          if (!attempt.result) {
            try {
              const result = await backend.publicRecover(attempt.input);
              if (cancelled) return;
              if (result) attempt.result = result;
            } catch (error) { if (cancelled) return; attempt.error = error; }
          }
          persistResult(attempt);
        }
      } finally { if (!cancelled) setRecovering(false); }
    })();
    return () => { cancelled = true; };
  }, [backend, termId, studentNo, pair.saturday.record_date]);

  useEffect(() => () => draftsRef.current.forEach(d => d.picked.forEach(p => revokeUrl(p.url))), []);
  useEffect(() => {
    if (!drafts.some(d => d.picked.length) || done === 2) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [drafts, done]);

  function update(index: number, patch: Partial<Draft>) {
    setDrafts(current => current.map((d, i) => i === index ? { ...d, ...patch } : d));
  }
  async function accept(index: number, files: File[]) {
    if (locked || attempts.current[index]?.input.images.length || attempts.current[index]?.result || picking.current || !files.length) return;
    if (files.length + draftsRef.current[index].picked.length > MAX_IMAGES) {
      update(index, { error: '날짜별 사진은 최대 3장까지 선택할 수 있습니다.' });
      return;
    }
    picking.current = true;
    setPreparing(index);
    const added: Picked[] = [];
    try {
      for (const file of files) {
        const image = await prepareImage(file);
        added.push({ id: crypto.randomUUID(), image, url: createTrackedUrl(image.blob) });
      }
      update(index, { picked: [...draftsRef.current[index].picked, ...added], error: null });
    } catch (error) {
      added.forEach(p => revokeUrl(p.url));
      update(index, { error: error instanceof ImageError ? error.message : '사진을 준비하지 못했습니다.' });
    } finally {
      picking.current = false;
      setPreparing(null);
    }
  }
  async function synthetic(index: number) {
    if (locked || picking.current) return;
    const blob = await renderSyntheticScreenshot('데모', days[index].record_date, 120, drafts[index].picked.length + 1);
    await accept(index, [new File([blob], 'synthetic.png', { type: 'image/png' })]);
  }
  function remove(index: number, id: string) {
    const picked = drafts[index].picked;
    const old = picked.find(p => p.id === id);
    if (old) revokeUrl(old.url);
    update(index, { picked: picked.filter(p => p.id !== id), error: null });
  }
  function editAgain() {
    if (unknownResult || busy || done === 1) return;
    if (done === 2) {
      drafts.forEach(d => d.picked.forEach(p => revokeUrl(p.url)));
      setDrafts([emptyDraft(), emptyDraft()]);
    }
    attempts.current = [];
    clearWeekendAttempts(termId, studentNo, pair.saturday.record_date);
    redraw(x => x + 1);
  }
  async function submit() {
    setConfirm(false);
    if (inFlight.current || !canSend || preparing !== null || done === 2) return;
    inFlight.current = true;
    setBusy(true);
    if (!started) attempts.current = days.map((day, i) => ({ input: {
      termId, studentNo, recordDate: day.record_date, requestId: crypto.randomUUID(),
      images: drafts[i].picked.map(p => ({ blob: p.image.blob, mime: p.image.mime })),
      token: tokens.current.get(day.record_date) ?? getToken(studentNo, day.record_date, termId),
      selfMinutes: drafts[i].minutes.trim() === '' ? null : Number(drafts[i].minutes), note: null,
    } }));
    attempts.current.forEach((attempt, i) => {
      if (!attempt.result && !attempt.input.images.length) {
        attempt.input.images = drafts[i].picked.map(p => ({ blob: p.image.blob, mime: p.image.mime }));
        attempt.input.selfMinutes = drafts[i].minutes.trim() === '' ? null : Number(drafts[i].minutes);
      }
    });
    saveLastStudentNo(studentNo);
    setStorageWarning(!saveWeekendAttempts(attempts.current));
    try {
      await submitWeekendDays(attempts.current, input => backend.publicSubmit(input), persistResult);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <>
    <section className="card stack" aria-label="주말 스크린타임 제출">
      <h1>주말 스크린타임 제출</h1>
      <label className="field">학번
        <input type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={5}
          placeholder="예: 10903" value={studentNo} disabled={locked || started}
          onChange={e => { tokens.current.clear(); setStudentNo(e.target.value.replace(/\s/g, '')); }} />
        {studentNo.length >= 5 && !validNo && <span role="alert" className="small">1-9반 학번을 확인해 주세요.</span>}
      </label>
      <div>
        <p className="strong">제출 대상: {fmtDate(pair.saturday.record_date)} ~ {fmtDate(pair.sunday.record_date)}</p>
        <p className="small muted">마감: {fmtDateTime(Date.parse(pair.saturday.deadline_at))} (KST)</p>
      </div>
      {earlier.length > 1 && <details className="fold"><summary>다른 주말 선택</summary><div className="row">
        {earlier.map(p => <button className="btn sm" key={p.saturday.record_date} disabled={locked || started || drafts.some(d => d.picked.length > 0)}
          onClick={() => onSelect(p.saturday.record_date)}>{fmtDate(p.saturday.record_date)} ~ {fmtDate(p.sunday.record_date)}</button>)}
      </div></details>}
      {days.map((day, index) => {
        const d = drafts[index];
        const attempt = attempts.current[index];
        const locked = busy || recovering || preparing !== null || !!attempt?.input.images.length || !!attempt?.result;
        const receipt = validNo ? getReceipt(studentNo, day.record_date, termId) : null;
        const label = index === 0 ? '토요일' : '일요일';
        return <div key={day.record_date} className="weekend-day stack">
          <h2>{label}, {fmtDate(day.record_date)}</h2>
          {attempt?.result ? <div className="banner ok" role="status"><strong>{label}: 접수 완료</strong>
            <p className="small">사진 {attempt.result.image_count ?? d.picked.length}장 접수
              {attempt.result.replaced ? ' (사진 교체)' : ''}</p></div> : <>
            {receipt && <p className="small muted">이 기기의 이전 접수 기록이 있습니다. 다시 제출하면 해당 날짜 사진 전체를 교체합니다.</p>}
            <div className="row between"><span>스크린타임 사진</span><span className="small muted">{d.picked.length}/3장</span></div>
            {d.picked.length > 0 && <div className="pick-grid">{d.picked.map((p, i) => <div className="pick-item" key={p.id}>
              <img src={p.url} alt={`${label} 사진 ${i + 1} 미리보기`} /><span className="thumb-no">{i + 1}</span>
              <button className="pick-remove" aria-label={`${label} 사진 ${i + 1} 삭제`} disabled={locked} onClick={() => remove(index, p.id)}>×</button>
            </div>)}</div>}
            {d.picked.length < MAX_IMAGES && (backend.mode === 'demo'
              ? <button className="btn block" disabled={locked} onClick={() => void synthetic(index)}>{label} 합성 사진 추가</button>
              : <label className="picker"><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={locked}
                  aria-label={`${label} 사진 선택`} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void accept(index, files); }} />
                <strong>{d.picked.length ? '사진 추가' : '사진 선택'}</strong><span className="small muted">날짜별 최대 3장</span></label>)}
            {preparing === index && <Spinner label="사진 준비 중" />}
            {d.error && <div className="banner error" role="alert">{d.error}</div>}
            <label className="field small">총 사용 시간 (분, 선택)
              <input type="number" inputMode="numeric" min={0} max={1440} step={1} placeholder="예: 120" value={d.minutes} disabled={locked}
                onChange={e => update(index, { minutes: e.target.value })} aria-label={`${label} 총 사용 시간`} />
              {!validMinutes(d.minutes) && <span role="alert">0~1440분의 정수로 입력해 주세요.</span>}
            </label>
            {attempt?.error && <div className="banner error" role="alert">{label}: {errorMessage(attempt.error)}</div>}
          </>}
        </div>;
      })}
      {done === 1 && <p role="status">일부 제출되었습니다. 다시 시도하면 접수되지 않은 날짜만 전송합니다.</p>}
      {recovering && <Spinner label="이전 접수 결과 확인 중" />}
      {started && attempts.current.some(a => !a.result && !a.input.images.length) && !recovering && <p className="small">접수되지 않은 날짜의 사진을 다시 선택해 주세요. 이전 요청 번호로 확인하여 중복 접수를 막습니다.</p>}
      {unknownResult && <p className="small">접수 결과 확인을 위해 다시 시도해 주세요.</p>}
      {storageWarning && <p className="banner warn small">이 기기에 복구 정보를 저장할 수 없습니다. 접수 완료까지 이 화면을 유지해 주세요.</p>}
      {closed && <div className="banner warn">이번 주말 프로그램의 제출 기간이 끝났습니다.</div>}
      {done < 2 ? <button className="btn primary lg block" disabled={!canSend || locked} onClick={() => setConfirm(true)}>
        {busy ? '제출 중…' : started ? '접수되지 않은 날짜 다시 시도' : '주말 스크린타임 한 번에 제출'}
      </button> : <p className="strong" role="status">토요일과 일요일 기록이 모두 접수되었습니다.</p>}
      {started && done !== 1 && !busy && !unknownResult && <button className="btn" onClick={editAgain}>{done === 2 ? '사진 다시 선택해서 교체' : '입력 다시 수정'}</button>}
      <p className="xs muted">신청 학생만 참여합니다. 각 날짜의 하루 전체 사용 시간과 날짜가 보이는 사진을 선택해 주세요.</p>
    </section>
    {info.term?.instructions && <p className="small muted">{info.term.instructions}</p>}
    {confirm && <Modal title="학번과 제출 사진 확인" onClose={() => setConfirm(false)}>
      <p>학번 <strong className="confirm-no">{studentNo}</strong></p>
      {days.map((day, i) => <p key={day.record_date}>{fmtDate(day.record_date)}: {attempts.current[i]?.result ? '접수 완료, 다시 보내지 않음' : `사진 ${drafts[i].picked.length}장`}</p>)}
      <div className="row"><button className="btn" onClick={() => setConfirm(false)}>수정할게요</button>
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>확인하고 제출</button></div>
    </Modal>}
  </>;
}
