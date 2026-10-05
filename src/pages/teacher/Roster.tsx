import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useBackend } from '../../app/context.tsx';
import { ErrorBanner, Modal } from '../../components/ui.tsx';
import { parseRoster, type RosterLine } from '../../lib/csv.ts';
import { kstDateOf } from '../../lib/kst.ts';
import { STUDENT_NOS } from '../../lib/localReceipt.ts';
import type { Student } from '../../lib/types.ts';
import { useTeacher } from './TeacherLayout.tsx';

type Kind = 'new' | 'rename' | 'same' | 'problem';

export default function Roster() {
  const { data, now, reload } = useTeacher();
  const [editing, setEditing] = useState<Student | null>(null);
  const activeCount = data.students.filter((s) => s.active).length;

  return (
    <div className="stack">
      <h1>명단</h1>

      <section className="card stack">
        <div className="row between">
          <h2>학번 명단</h2>
          <span className="small muted">활성 {activeCount}명 / 전체 {data.students.length}명</span>
        </div>
        <p className="small muted">학생은 계정 없이 첫 화면에서 학번(10901~10934)으로 제출합니다. 표시명은 이 교사 화면에만 보이고 제출 화면에는 반환되지 않습니다. 비활성 학번은 제출이 거절됩니다.</p>
        <div className="table-wrap">
          <table className="list">
            <thead><tr><th>학번</th><th>표시명</th><th>상태</th><th className="hide-sm">대상 기간</th><th /></tr></thead>
            <tbody>
              {data.students.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.student_no}{!STUDENT_NOS.has(s.student_no) && <span className="xs faint"> (제출 범위 밖)</span>}</td>
                  <td><Link to={`/teacher/students/${s.id}`}>{s.name}</Link></td>
                  <td>{s.active ? <span className="chip rv-checked">활성</span> : <span className="chip neutral">비활성</span>}</td>
                  <td className="hide-sm small muted">{s.roster_from ?? '처음'} ~ {s.roster_until ?? '끝'}</td>
                  <td><button className="btn sm" onClick={() => setEditing(s)}>수정</button></td>
                </tr>
              ))}
              {data.students.length === 0 && <tr><td colSpan={5} className="muted">아직 명단이 없습니다. 아래에서 붙여넣거나 CSV를 올려 주세요.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="xs muted">비활성화·다시 활성화는 표시명을 눌러 학생 상세에서 합니다. 과거 기록과 인원수는 비활성화 때문에 사라지지 않습니다.</p>
      </section>

      <ImportPanel onDone={reload} classId={data.klass.id} existing={data.students} rosterFromDefault={data.term && now >= Date.parse(data.days[0]?.window_open_at ?? '') ? kstDateOf(now) : null} />

      {editing && <EditStudent student={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function ImportPanel({ classId, existing, rosterFromDefault, onDone }: {
  classId: string; existing: Student[]; rosterFromDefault: string | null; onDone: () => void;
}) {
  const backend = useBackend();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const lines = useMemo(() => (text.trim() ? parseRoster(text) : []), [text]);
  const classified = lines.map((l): RosterLine & { kind: Kind; current?: Student } => {
    if (l.problem) return { ...l, kind: 'problem' };
    const cur = existing.find((s) => s.student_no === l.student_no);
    if (!cur) return { ...l, kind: 'new' };
    return { ...l, kind: cur.name === l.name ? 'same' : 'rename', current: cur };
  });
  const counts = { new: 0, rename: 0, same: 0, problem: 0 } as Record<Kind, number>;
  classified.forEach((c) => counts[c.kind]++);
  const notInImport = lines.length ? existing.filter((s) => !lines.some((l) => l.student_no === s.student_no)).length : 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await backend.addStudents(classId, classified.filter((c) => c.kind === 'new').map((c) => ({ student_no: c.student_no, name: c.name, roster_from: rosterFromDefault })));
      for (const c of classified.filter((x) => x.kind === 'rename')) await backend.updateStudent(c.current!.id, { name: c.name });
      setDone(`신규 ${counts.new}명 추가, 이름 변경 ${counts.rename}명 반영. 기존 학생은 삭제하지 않았습니다.`);
      setText('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>명단 가져오기·표시명 바꾸기</h2>
      <p className="small muted">엑셀에서 '학번, 표시명' 두 열을 복사해 붙여넣거나 CSV 파일을 선택하세요. 저장 전에 중복·누락을 보여 줍니다. 가져온 자료에 없는 기존 학생은 삭제하지 않습니다.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'10901\t학생 01\n10902\t학생 02'} rows={5} />
      <label className="btn sm" style={{ alignSelf: 'flex-start', position: 'relative' }}>
        CSV 파일 선택
        <input type="file" accept=".csv,.txt,text/csv,text/plain" style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setText(await f.text()); }} />
      </label>
      {lines.length > 0 && (
        <>
          <div className="row small">
            <span className="chip st-on_time">신규 {counts.new}</span>
            <span className="chip st-waiting">이름 변경 {counts.rename}</span>
            <span className="chip neutral">동일 {counts.same}</span>
            <span className="chip st-missing">문제 {counts.problem}</span>
            {notInImport > 0 && <span className="muted">· 가져온 자료에 없는 기존 학생 {notInImport}명(유지)</span>}
          </div>
          {rosterFromDefault && counts.new > 0 && <p className="small muted">운영 중 추가되는 학생은 {rosterFromDefault}부터 제출 대상이 됩니다(학생 '수정'에서 바꿀 수 있음).</p>}
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="list">
              <thead><tr><th>행</th><th>학번</th><th>이름</th><th>처리</th></tr></thead>
              <tbody>
                {classified.filter((c) => c.kind !== 'same').map((c) => (
                  <tr key={c.line}>
                    <td>{c.line}</td><td className="mono">{c.student_no || '–'}</td><td>{c.name || '–'}</td>
                    <td className="small">{c.kind === 'new' ? '신규 추가' : c.kind === 'rename' ? `이름 변경(${c.current!.name} → ${c.name})` : <span style={{ color: 'var(--danger)' }}>{c.problem} · 제외</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn primary" disabled={busy || counts.new + counts.rename === 0} onClick={() => void save()}>
            {busy ? '저장 중…' : `저장 (신규 ${counts.new} · 변경 ${counts.rename})`}
          </button>
        </>
      )}
      {done && <div className="banner ok small">{done}</div>}
      <ErrorBanner error={error} />
    </section>
  );
}

function EditStudent({ student, onClose, onDone }: { student: Student; onClose: () => void; onDone: () => void }) {
  const backend = useBackend();
  const [no, setNo] = useState(student.student_no);
  const [name, setName] = useState(student.name);
  const [from, setFrom] = useState(student.roster_from ?? '');
  const [until, setUntil] = useState(student.roster_until ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await backend.updateStudent(student.id, { student_no: no.trim(), name: name.trim(), roster_from: from || null, roster_until: until || null });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="학생 정보 수정" onClose={onClose}>
      <label className="field">학번<input type="text" value={no} onChange={(e) => setNo(e.target.value)} /></label>
      <label className="field">표시명<input type="text" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="row">
        <label className="field grow">대상 시작일 <span className="hint">비우면 운영 시작부터</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field grow">대상 마지막 날 <span className="hint">비우면 끝까지</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      </div>
      <p className="xs muted">학번을 바꾸면 새 학번으로만 제출할 수 있습니다(제출 범위 10901~10934).</p>
      <ErrorBanner error={error} />
      <button className="btn primary" disabled={busy || !no.trim() || !name.trim()} onClick={() => void save()}>저장</button>
    </Modal>
  );
}
