// 담임 로그인(교사 ID + 비밀번호, Supabase Auth). 학생은 로그인하지 않는다.
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { useApp } from '../app/context.tsx';
import { DemoBar, ErrorBanner } from '../components/ui.tsx';

export function homePath(role: 'teacher' | 'student') {
  return role === 'teacher' ? '/teacher' : '/';
}

/** 예전 학생 Auth 계정으로 로그인된 경우: 더 이상 쓰지 않는 계정이므로 로그아웃만 안내한다. */
export function NotTeacher() {
  const { signOut } = useApp();
  return (
    <div className="login-wrap">
      <div className="login-card stack">
        <h1>1-9 체크</h1>
        <div className="banner warn">
          <strong>담임 계정이 아닙니다.</strong>
          <p className="small">학생은 로그인 없이 첫 화면에서 학번으로 제출합니다.</p>
        </div>
        <button className="btn primary block" onClick={() => void signOut()}>로그아웃</button>
        <Link className="btn ghost block" to="/">제출 화면으로</Link>
      </div>
    </div>
  );
}

export default function Login() {
  const { backend, me, loading, authError } = useApp();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!loading && me) {
    if (me.role !== 'teacher') return <NotTeacher />;
    return <Navigate to={me.mustChangePassword ? '/change-password' : '/teacher'} replace />;
  }

  const isDemo = backend?.mode === 'demo';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!backend || busy) return;
    setBusy(true);
    setError(null);
    try {
      await backend.signIn(isDemo ? 'teacher' : loginId, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DemoBar />
      <div className="login-wrap">
        <div className="login-card stack">
          <div className="stack" style={{ gap: 4 }}>
            <h1>1-9 체크</h1>
            <p className="muted small">담임 로그인</p>
          </div>

          {authError && !isDemo && <div className="banner error">{authError}</div>}

          {isDemo ? (
            <form className="card stack" onSubmit={submit}>
              <p className="small muted">데모에서는 비밀번호를 확인하지 않습니다. 합성 학생 34명(학생 01~34)과 합성 이미지만 있습니다.</p>
              <button className="btn primary lg block" disabled={busy}>담임 화면 보기</button>
              <ErrorBanner error={error} />
            </form>
          ) : (
            <form className="card stack" onSubmit={submit} noValidate>
              <label className="field">
                교사 ID
                <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={loginId} onChange={(e) => setLoginId(e.target.value)} required />
              </label>
              <label className="field">
                비밀번호
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              <ErrorBanner error={error} />
              <button className="btn primary lg block" disabled={busy || !loginId || !password}>{busy ? '확인 중…' : '로그인'}</button>
            </form>
          )}

          <Link className="btn ghost block" to="/">학생 제출 화면으로</Link>
        </div>
      </div>
    </>
  );
}
