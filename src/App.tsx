import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';
import { AppProvider, configError, useApp } from './app/context.tsx';
import { Spinner } from './components/ui.tsx';
import ChangePassword from './pages/ChangePassword.tsx';
import Login, { NotTeacher } from './pages/Login.tsx';
import PublicSubmit from './pages/PublicSubmit.tsx';
import DayBoard from './pages/teacher/DayBoard.tsx';
import Overview from './pages/teacher/Overview.tsx';
import Roster from './pages/teacher/Roster.tsx';
import Settings from './pages/teacher/Settings.tsx';
import StudentDetail from './pages/teacher/StudentDetail.tsx';
import TeacherLayout from './pages/teacher/TeacherLayout.tsx';

/** 교사 화면은 로그인 + 서버에서 읽은 역할(profiles.role=teacher) 기준. 데이터 접근 자체는 RLS가 막는다. */
function RequireTeacher({ children }: { children: ReactNode }) {
  const { me, loading } = useApp();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/teacher/login" replace />;
  if (me.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (me.role !== 'teacher') return <NotTeacher />;
  return <>{children}</>;
}

function AppRoutes() {
  const { backend } = useApp();
  // 백엔드(실제/데모)가 바뀌면 화면 상태를 모두 버린다
  return (
    <Routes key={backend?.mode ?? 'none'}>
      {/* 학생: 로그인 없이 학번으로 제출 */}
      <Route path="/" element={<PublicSubmit />} />
      {/* 담임 */}
      <Route path="/teacher/login" element={<Login />} />
      <Route path="/login" element={<Navigate to="/teacher/login" replace />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/teacher" element={<RequireTeacher><TeacherLayout /></RequireTeacher>}>
        <Route index element={<DayBoard />} />
        <Route path="overview" element={<Overview />} />
        <Route path="students/:id" element={<StudentDetail />} />
        <Route path="roster" element={<Roster />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** 실행 모드 설정 오류: 데모로 대체하지 않고 여기서 멈춘다. */
function ConfigError({ message }: { message: string }) {
  return (
    <div className="login-wrap">
      <div className="login-card stack">
        <h1>1-9 체크</h1>
        <div className="banner error" role="alert">
          <strong>설정 오류 — 앱을 시작하지 않았습니다</strong>
          <p className="small">{message}</p>
          <p className="small">실제 연결: .env.local에 VITE_APP_MODE=supabase, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY · 데모: npm run dev:demo</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  if (configError) return <ConfigError message={configError} />;
  return (
    <AppProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AppProvider>
  );
}
