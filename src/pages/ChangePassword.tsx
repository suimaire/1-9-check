import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useApp } from '../app/context.tsx';
import { DemoBar, ErrorBanner, TopBar } from '../components/ui.tsx';
import { homePath } from './Login.tsx';

export default function ChangePassword() {
  const { backend, me, refreshMe, signOut } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!me) return <Navigate to="/teacher/login" replace />;
  if (!me.mustChangePassword) return <Navigate to={homePath(me.role)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setError(null);
    if (next !== confirm) return setLocalError('새 비밀번호 확인이 일치하지 않습니다.');
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      return setLocalError('새 비밀번호는 영문과 숫자를 섞어 8자 이상으로 정해 주세요.');
    }
    setBusy(true);
    try {
      await backend!.changePassword(current, next);
      await refreshMe();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DemoBar />
      <TopBar title="비밀번호 변경" right={<button className="btn sm" onClick={() => void signOut()}>로그아웃</button>} />
      <main className="page narrow">
        <form className="card stack" onSubmit={submit}>
          <p>{me.displayName}님, 처음 로그인했습니다. 선생님께 받은 임시 비밀번호를 본인만 아는 비밀번호로 바꿔야 사용할 수 있습니다.</p>
          <label className="field">
            임시(현재) 비밀번호
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label className="field">
            새 비밀번호 <span className="hint">영문+숫자 8자 이상</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
          <label className="field">
            새 비밀번호 확인
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          {localError && <div className="banner error">{localError}</div>}
          <ErrorBanner error={error} />
          <button className="btn primary lg block" disabled={busy}>{busy ? '변경 중…' : '비밀번호 변경'}</button>
        </form>
      </main>
    </>
  );
}
