import { useState } from 'react';
import { useBackend } from '../../app/context.tsx';
import { ErrorBanner } from '../../components/ui.tsx';
import { fmtDateTime, hhmmToMinutes, minutesToHHMM } from '../../lib/kst.ts';
import type { Term } from '../../lib/types.ts';
import { useTeacher } from './TeacherLayout.tsx';

export function WeekendTermForm({ term, onCreated }: { term: Term | null; onCreated: () => void }) {
  const backend = useBackend();
  const { data, reload, setTermId } = useTeacher();
  const [name, setName] = useState(term?.name ?? '2026 주말 화면 시간 기록');
  const [deadline, setDeadline] = useState(minutesToHHMM(term?.deadline_minutes ?? 540));
  const [instructions, setInstructions] = useState(term?.instructions ?? '토요일과 일요일의 하루 전체 화면 시간 사진을 날짜별로 올려 주세요. 날짜와 총 사용 시간이 보이도록 찍어 주세요.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const minutes = hhmmToMinutes(deadline);
  async function save() {
    if (!name.trim() || minutes === null || minutes <= 0) return;
    setBusy(true); setError(null); setMessage('');
    try {
      const id = await backend.saveWeekendTerm(data.klass.id, { termId: term?.id ?? null, name: name.trim(), deadlineMinutes: minutes, instructions: instructions.trim() });
      if (!term) { setTermId(id); onCreated(); }
      reload();
      setMessage('저장했습니다. 이미 열린 제출일의 마감 시각은 유지됩니다.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="card stack">
    <h2>{term ? '주말 운영 기간' : '새 주말 운영 기간'}</h2>
    <p className="small muted">2026년 11월 21일과 22일, 11월 28일과 29일, 12월 5일과 6일의 기록을 수집합니다. 각 주말 두 날짜의 제출은 다음 월요일 00:00 KST에 함께 열립니다.</p>
    <label className="field">프로그램 이름<input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="field">월요일 마감 시각 (KST)<input type="time" min="00:01" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
    <p className="xs muted">기본 마감은 월요일 09:00입니다. 변경한 시각은 아직 열리지 않은 주말에만 적용되며, 실제 마감은 아래 운영 달력에서 확인할 수 있습니다.</p>
    <label className="field">학생 안내문<textarea maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
    <p className="small muted">최종 제출 종료: {term ? fmtDateTime(Date.parse(term.final_close_at)) : '2026년 12월 7일 23:59:59 KST'}. 주말 기간을 만든 뒤 참여자를 선택하고 학생 화면에 공개할 기간을 지정하세요.</p>
    <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !name.trim() || minutes === null || minutes <= 0} onClick={() => void save()}>{busy ? '저장 중…' : term ? '주말 설정 저장' : '주말 기간 만들기'}</button>
    {message && <div className="banner ok small" role="status">{message}</div>}
    <ErrorBanner error={error} />
  </section>;
}

export function PublicTermForm() {
  const backend = useBackend();
  const { data, reload } = useTeacher();
  const [selected, setSelected] = useState(data.klass.public_term_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const current = data.terms.find((term) => term.id === data.klass.public_term_id);
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await backend.setPublicTerm(data.klass.id, selected || null); setSaved(true); reload(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="card stack">
    <h2>학생 화면 공개 기간</h2>
    <p className="small">현재 지정: <strong>{current?.name ?? '자동 선택'}</strong></p>
    <p className="small muted">교사 화면에서 보는 기간과 학생에게 공개하는 기간은 별도입니다. 아래에서 선택한 뒤 저장해야 학생 제출 화면에 적용됩니다.</p>
    <label className="field">공개할 운영 기간<select value={selected} onChange={(e) => { setSelected(e.target.value); setSaved(false); }}>
      <option value="">자동 선택 (기존 기본 동작)</option>
      {data.terms.map((term) => <option key={term.id} value={term.id}>{term.name} ({term.start_date} ~ {term.last_record_date})</option>)}
    </select></label>
    <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || selected === (data.klass.public_term_id ?? '')} onClick={() => void save()}>{busy ? '저장 중…' : '공개 기간 저장'}</button>
    {saved && <p className="banner ok small" role="status">공개 기간을 저장했습니다.</p>}
    <ErrorBanner error={error} />
  </section>;
}

export function WeekendParticipants() {
  const backend = useBackend();
  const { data, reload } = useTeacher();
  const [selected, setSelected] = useState(() => new Set(data.participantIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await backend.setTermParticipants(data.term!.id, [...selected]); setSaved(true); reload(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="card stack">
    <div className="row between"><h2>주말 참여자 선택</h2><span className="chip neutral">선택 {selected.size}명</span></div>
    <p className="small muted">{data.term!.name}에 참여할 신청자를 기존 명단에서 선택하세요. 저장 전에는 반영되지 않습니다. 참여에서 제외해도 기존 제출 사진과 이력은 학생 상세에 남으며, 전체 명단의 활성 상태는 바뀌지 않습니다.</p>
    <div className="row">
      <button className="btn sm" disabled={busy} onClick={() => { setSelected(new Set(data.students.filter((s) => s.active).map((s) => s.id))); setSaved(false); }}>활성 학생 모두 선택</button>
      <button className="btn sm" disabled={busy} onClick={() => { setSelected(new Set()); setSaved(false); }}>선택 모두 해제</button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
      {data.students.map((student) => <label key={student.id} className="check">
        <input type="checkbox" checked={selected.has(student.id)} disabled={busy || (!student.active && !selected.has(student.id))} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(student.id); else next.delete(student.id); setSelected(next); setSaved(false); }} />
        <span>{student.student_no} {student.name}{!student.active ? ' (비활성, 제출 불가)' : ''}</span>
      </label>)}
    </div>
    {data.students.length === 0 && <p className="muted">기존 학생 명단이 없습니다.</p>}
    <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '이 기간 참여자 저장'}</button>
    {saved && <p className="banner ok small" role="status">이 기간의 참여자를 저장했습니다.</p>}
    <ErrorBanner error={error} />
  </section>;
}
