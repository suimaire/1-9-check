import { useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router';
import { useApp, useBackend, useServerNow } from '../../app/context.tsx';
import { DemoBar, ErrorBanner, Spinner, TopBar, useAsync } from '../../components/ui.tsx';
import type { TeacherData } from '../../lib/backend/types.ts';
import { fmtDate, kstDateOf } from '../../lib/kst.ts';
import { indexBoard, type Board } from '../../lib/status.ts';

export interface TeacherCtx {
  data: TeacherData;
  board: Board;
  now: number;
  reload: () => void;
  setTermId: (id: string) => void;
}

export function useTeacher(): TeacherCtx {
  return useOutletContext<TeacherCtx>();
}

export default function TeacherLayout() {
  const backend = useBackend();
  const { me, signOut } = useApp();
  const now = useServerNow();
  const [termId, setTermId] = useState<string | null>(null);
  const { data, error, loading, reload } = useAsync(() => backend.loadTeacherData(termId), [backend, termId]);

  useEffect(() => {
    const el = document.querySelector('.topbar') as HTMLElement | null;
    if (el) document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
  });

  const klass = data?.klass;
  const header = (
    <>
      <DemoBar />
      <TopBar
        title={klass?.app_title ?? '1-9 체크'}
        subtitle={klass ? `${klass.app_subtitle} · ${klass.name} 담임` : undefined}
        right={
          <div className="row">
            <span className="small strong hide-sm">{me?.displayName}</span>
            <button className="btn sm" onClick={() => void signOut()}>로그아웃</button>
          </div>
        }
      />
      <nav className="tabs" aria-label="교사 메뉴">
        <NavLink to="/teacher" end>날짜별 현황</NavLink>
        <NavLink to="/teacher/overview">기간 한눈에</NavLink>
        <NavLink to="/teacher/roster">명단</NavLink>
        <NavLink to="/teacher/settings">운영 설정</NavLink>
      </nav>
    </>
  );

  if (loading && !data) return <>{header}<main className="page"><Spinner /></main></>;
  if (error) return <>{header}<main className="page"><ErrorBanner error={error} onRetry={reload} /></main></>;
  if (!data) {
    return <>{header}<main className="page"><div className="banner warn">담당 학급이 연결되지 않은 교사 계정입니다. README의 최초 교사 계정 준비 절차를 확인해 주세요.</div></main></>;
  }
  if (now === null) return <>{header}<main className="page"><Spinner label="서버 시각 확인 중" /></main></>;

  const board = indexBoard(data.submissions, data.exemptions, data.excuses);
  const retentionDue = data.term?.retention_until && kstDateOf(now) > data.term.retention_until;

  return (
    <>
      {header}
      <main className="page stack">
        {data.terms.length > 1 && data.term && (
          <label className="row small">
            운영 기간
            <select value={data.term.id} onChange={(e) => setTermId(e.target.value)} style={{ width: 'auto' }}>
              {data.terms.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.start_date} ~ {t.last_record_date})</option>)}
            </select>
          </label>
        )}
        {retentionDue && (
          <div className="banner warn small">
            보관 종료일({fmtDate(data.term!.retention_until!)})이 지났습니다. 자동 삭제는 하지 않으므로 운영 설정 › 자료 삭제에서 직접 정리해 주세요.
          </div>
        )}
        <Outlet context={{ data, board, now, reload, setTermId } satisfies TeacherCtx} />
      </main>
    </>
  );
}
