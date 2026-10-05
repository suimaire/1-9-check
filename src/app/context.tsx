import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createDemoBackend, type DemoControls } from '../lib/backend/demo.ts';
import { createSupabaseBackend } from '../lib/backend/supabase.ts';
import type { Backend } from '../lib/backend/types.ts';
import { revokeAllObjectUrls } from '../lib/objectUrls.ts';
import type { Me } from '../lib/types.ts';
import { errorMessage } from '../lib/messages.ts';

// 실행 모드는 빌드 시 VITE_APP_MODE로 명시한다(demo | supabase).
// supabase 모드에서 연결값이 빠지면 설정 오류로 멈추고, 데모로 대체하지 않는다.
// demo 모드에서는 Supabase 클라이언트를 만들지 않는다.
const APP_MODE = import.meta.env.VITE_APP_MODE as string | undefined;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export type AppMode = 'demo' | 'supabase';

function resolveMode(): { mode: AppMode | null; configError: string | null } {
  if (APP_MODE === 'demo') return { mode: 'demo', configError: null };
  if (APP_MODE === 'supabase') {
    const missing = [!SUPABASE_URL && 'VITE_SUPABASE_URL', !SUPABASE_KEY && 'VITE_SUPABASE_PUBLISHABLE_KEY'].filter(Boolean);
    if (missing.length) return { mode: 'supabase', configError: `실제 모드(VITE_APP_MODE=supabase)인데 ${missing.join(', ')} 값이 없습니다.` };
    if (/^sb_secret_/.test(SUPABASE_KEY!)) return { mode: 'supabase', configError: 'VITE_SUPABASE_PUBLISHABLE_KEY에 secret key가 들어 있습니다. publishable key만 넣으세요.' };
    return { mode: 'supabase', configError: null };
  }
  return {
    mode: null,
    configError: APP_MODE
      ? `VITE_APP_MODE 값 '${APP_MODE}'을(를) 알 수 없습니다. demo 또는 supabase로 지정하세요.`
      : 'VITE_APP_MODE가 지정되지 않았습니다. demo 또는 supabase로 지정하세요.',
  };
}

export const { mode: appMode, configError } = resolveMode();
export const demoAllowed = appMode === 'demo' && !configError;

let realBackend: Backend | null = null;
function getRealBackend(): Backend | null {
  if (appMode !== 'supabase' || configError) return null;
  realBackend ??= createSupabaseBackend(SUPABASE_URL!, SUPABASE_KEY!);
  return realBackend;
}

interface AppCtx {
  backend: Backend | null; // null = 연결 대기(환경 변수 없음)
  demo: DemoControls | null;
  me: Me | null;
  loading: boolean;
  authError: string | null;
  refreshMe(): Promise<void>;
  enterDemo(): void;
  leaveDemo(): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // 데모 모드는 처음부터 데모 백엔드로 시작한다(공개 제출 화면도 데모로 동작).
  const [demoBackend, setDemoBackend] = useState<ReturnType<typeof createDemoBackend> | null>(() => (demoAllowed ? createDemoBackend() : null));
  const backend: Backend | null = demoBackend ?? getRealBackend();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const seq = useRef(0);

  const refreshMe = useCallback(async () => {
    const id = ++seq.current;
    if (!backend) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const next = await backend.getMe();
      if (id === seq.current) {
        setMe(next);
        setAuthError(null);
      }
    } catch (err) {
      if (id === seq.current) {
        setMe(null);
        setAuthError(errorMessage(err));
      }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    setLoading(true);
    void refreshMe();
    if (!backend) return;
    return backend.onAuthChange(() => void refreshMe());
  }, [backend, refreshMe]);

  const value = useMemo<AppCtx>(() => ({
    backend,
    demo: demoBackend?.demo ?? null,
    me,
    loading,
    authError,
    refreshMe,
    enterDemo() {
      if (!demoAllowed) return;
      setMe(null);
      setDemoBackend(createDemoBackend());
    },
    leaveDemo() {
      // 데모를 처음 상태로 되돌린다
      revokeAllObjectUrls();
      setMe(null);
      setDemoBackend(demoAllowed ? createDemoBackend() : null);
    },
    async signOut() {
      revokeAllObjectUrls();
      if (backend) await backend.signOut();
      setMe(null);
    },
  }), [backend, demoBackend, me, loading, authError, refreshMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}

export function useBackend(): Backend {
  const { backend } = useApp();
  if (!backend) throw new Error('backend not configured');
  return backend;
}

/** 서버 기준 현재 시각. 실제 연결은 서버 시각과의 차이를 보정해 30초마다 갱신한다. */
export function useServerNow(): number | null {
  const { backend, demo } = useApp();
  const [base, setBase] = useState<{ server: number; local: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!backend) return;
    let alive = true;
    const sync = () => backend.serverNow().then((ms) => alive && setBase({ server: ms, local: Date.now() })).catch(() => undefined);
    void sync();
    const timer = setInterval(sync, 5 * 60 * 1000);
    const unsub = demo?.subscribe(() => void sync());
    return () => {
      alive = false;
      clearInterval(timer);
      unsub?.();
    };
  }, [backend, demo]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  if (!base) return null;
  if (backend?.mode === 'demo') return base.server; // 데모 시각은 고정
  return base.server + (Date.now() - base.local);
}
